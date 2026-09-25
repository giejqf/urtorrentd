// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Per-torrent operations behind the API: lifecycle, queue, limits, storage
//! moves, files, trackers, web seeds and peers. Each maps onto `Session`
//! calls (AGENTS.md section 3) plus the daemon record where it keeps state.

use std::net::{IpAddr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;

use urtorrent::{InfoHash, QueueMove, Torrent, TorrentId};

use super::Daemon;
use crate::error::{ApiError, ApiResult};
use crate::model::{
    self, FileInfo, LimitsRequest, PeerSourceInfo, PiecesResponse, QueueMoveTo, TimelineKind,
    TorrentPatch, TrackerEndpointInfo, TrackerInfo, TrackerStatus, TrackersResponse,
};
use crate::settings::valid_tracker_url;
use crate::store::StopCondition;
use crate::util::{hex, normalize_ip};

fn usize_of(n: u32) -> usize {
    usize::try_from(n).unwrap_or(usize::MAX)
}

/// Parse `ip`, `ip:port` or `[ipv6]:port` down to the address.
pub(crate) fn parse_peer_ip(s: &str) -> Option<IpAddr> {
    let s = s.trim();
    if let Ok(a) = s.parse::<SocketAddr>() {
        return Some(normalize_ip(a.ip()));
    }
    s.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .ok()
        .map(normalize_ip)
}

/// A torrent's name as a file name: no `/`, no control characters, no
/// leading dot, at most 200 bytes (`fallback` when nothing is left).
pub(crate) fn export_name(name: &str, fallback: &str) -> String {
    let mut out: String = name
        .chars()
        .map(|c| if c == '/' || c.is_control() { '_' } else { c })
        .collect();
    out = out.trim().trim_start_matches('.').to_string();
    if out.len() > 200 {
        let mut end = 200;
        while !out.is_char_boundary(end) {
            end -= 1;
        }
        out.truncate(end);
    }
    if out.is_empty() {
        fallback.to_string()
    } else {
        out
    }
}

/// Where a move takes a torrent's content.
#[derive(Debug, Clone)]
pub(crate) enum MoveTo {
    /// Its save path: the download path goes; `managed` keeps automatic
    /// management on.
    Save { path: String, managed: bool },
    /// A download path of an incomplete torrent (the content moves on to the
    /// save path when it completes).
    Download { path: String },
}

impl Daemon {
    /// Start (resume under the queue). An errored torrent is recovered
    /// (urtorrent 0.12): missing files are looked for again, an I/O error
    /// restarts; unusable metadata is refused (`busy`).
    pub(crate) async fn start_torrent(&self, hash: InfoHash, id: TorrentId) -> ApiResult<()> {
        self.session.resume(id).await?;
        self.edit_record(hash, |r| r.stopped = false)
    }

    /// Stop.
    pub(crate) async fn stop_torrent(&self, hash: InfoHash, id: TorrentId) -> ApiResult<()> {
        self.session.pause(id).await?;
        self.edit_record(hash, |r| {
            r.stopped = true;
            r.stop_condition = StopCondition::None;
        })
    }

    /// Force start (`true`) or hand back to the queue (`false`).
    pub(crate) async fn force_start(
        &self,
        hash: InfoHash,
        id: TorrentId,
        on: bool,
    ) -> ApiResult<()> {
        if on {
            self.session.force_resume(id).await?;
            self.edit_record(hash, |r| r.stopped = false)
        } else {
            self.session.set_auto_managed(id, true).await?;
            Ok(())
        }
    }

    /// Start a full recheck; it runs in the background (the state shows
    /// `checking`). It also clears an error (urtorrent 0.12), except for
    /// unusable metadata, which is refused here rather than failing unseen.
    pub(crate) async fn recheck(self: &Arc<Self>, id: TorrentId) -> ApiResult<()> {
        let st = self.session.status(id).await?;
        if st.error_kind == Some(urtorrent::ErrorKind::Metadata) {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                crate::error::ErrorCode::Busy,
                "the torrent's metadata is unusable; only removing it helps",
            ));
        }
        let d = self.clone();
        tokio::spawn(async move {
            if let Err(e) = d.session.force_recheck(id).await {
                d.logs.warn(format!("recheck failed: {e}"));
            }
        });
        Ok(())
    }

    /// Remove a torrent (and its content), then everything the daemon kept.
    pub(crate) async fn remove(
        &self,
        hash: InfoHash,
        id: TorrentId,
        with_files: bool,
    ) -> ApiResult<()> {
        let _ops = self.ops.lock().await;
        let summary = self.hook_summary(hash, TimelineKind::Removed).await;
        let r = if with_files {
            self.session.remove_torrent_with_files(id).await
        } else {
            self.session.remove_torrent(id).await
        };
        match r {
            Ok(()) | Err(urtorrent::Error::NoSuchTorrent) => {}
            Err(e) => return Err(e.into()),
        }
        let name = self.name_of(&hash);
        {
            let mut st = self.state();
            st.by_id.remove(&id);
            st.torrents.remove(&hash);
            if let Ok(stats) = &self.stats {
                stats.forget(&hash);
            }
            self.lifecycle_with(hash, TimelineKind::Removed, None, summary);
        }
        self.forget_files(&hash);
        let _g = self.persist_lock.lock().await;
        let (store, h) = (self.store.clone(), hex(&hash));
        crate::util::blocking(move || store.delete_torrent(&h)).await?;
        self.logs.info(format!(
            "removed torrent {name}{}",
            if with_files { " and its files" } else { "" }
        ));
        Ok(())
    }

    /// Move in the queue.
    pub(crate) async fn queue_move(&self, id: TorrentId, to: QueueMoveTo) -> ApiResult<()> {
        let to = match to {
            QueueMoveTo::Top => QueueMove::Top,
            QueueMoveTo::Up => QueueMove::Up,
            QueueMoveTo::Down => QueueMove::Down,
            QueueMoveTo::Bottom => QueueMove::Bottom,
        };
        Ok(self.session.move_in_queue(id, to).await?)
    }

    /// Put a torrent at a place in the queue (0 first, past the end last).
    pub(crate) async fn set_queue_position(&self, id: TorrentId, position: u64) -> ApiResult<()> {
        let at = usize::try_from(position).unwrap_or(usize::MAX);
        Ok(self.session.set_queue_position(id, at).await?)
    }

    /// Sequential download on or off.
    pub(crate) async fn set_sequential(
        &self,
        hash: InfoHash,
        id: TorrentId,
        on: bool,
    ) -> ApiResult<()> {
        self.session.set_sequential(id, on).await?;
        let _ = hash;
        Ok(())
    }

    /// First and last piece of each file first: remember it, and apply it
    /// once the metadata is known.
    pub(crate) async fn set_first_last(
        &self,
        hash: InfoHash,
        id: TorrentId,
        on: bool,
    ) -> ApiResult<()> {
        self.edit_record(hash, |r| r.first_last_piece_priority = on)?;
        match self.apply_first_last(id, on).await {
            Err(ApiError {
                code: crate::error::ErrorCode::Busy,
                ..
            }) => Ok(()),
            other => other,
        }
    }

    /// Raise the first and last piece of every wanted file to the top
    /// priority (`on`), or let the file priorities decide every piece again.
    pub(crate) async fn apply_first_last(&self, id: TorrentId, on: bool) -> ApiResult<()> {
        let files = self.session.files(id).await?;
        if files.is_empty() {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                crate::error::ErrorCode::Busy,
                "the metadata is not known yet",
            ));
        }
        if !on {
            let prios = files.iter().map(|f| f.priority).collect();
            return Ok(self.session.set_file_priorities(id, prios).await?);
        }
        let t = Self::parsed_torrent(self.session.torrent_file(id).await?)?;
        let plen = u64::from(t.info.piece_length.max(1));
        let mut pieces = self.session.piece_priorities(id).await?;
        for (f, file) in files.iter().zip(t.info.content_files()) {
            if f.priority == 0 || file.length == 0 {
                continue;
            }
            let first = usize::try_from(file.offset / plen).unwrap_or(usize::MAX);
            let last =
                usize::try_from((file.offset + file.length - 1) / plen).unwrap_or(usize::MAX);
            for i in [first, last] {
                if let Some(p) = pieces.get_mut(i) {
                    *p = 7;
                }
            }
        }
        Ok(self.session.set_piece_priorities(id, pieces).await?)
    }

    /// Per-torrent limits (present fields only).
    pub(crate) async fn set_limits(&self, id: TorrentId, req: &LimitsRequest) -> ApiResult<()> {
        if req.upload_limit.is_some() || req.download_limit.is_some() {
            let st = self.session.status(id).await?;
            let up = match req.upload_limit {
                Some(v) => v.unwrap_or(0),
                None => st.upload_limit,
            };
            let down = match req.download_limit {
                Some(v) => v.unwrap_or(0),
                None => st.download_limit,
            };
            self.session.set_torrent_rate_limits(id, up, down).await?;
        }
        if let Some(v) = req.max_connections {
            self.session.set_max_peers(id, v.map(usize_of)).await?;
        }
        if let Some(v) = req.max_uploads {
            self.session.set_max_uploads(id, v.map(usize_of)).await?;
        }
        Ok(())
    }

    /// Move the content in the background; `managed` keeps automatic
    /// management on (a relocation), otherwise a manual move turns it off.
    pub(crate) fn spawn_move(
        self: &Arc<Self>,
        hash: InfoHash,
        id: TorrentId,
        to: MoveTo,
        recheck: bool,
    ) {
        let path = match &to {
            MoveTo::Save { path, .. } | MoveTo::Download { path } => path.clone(),
        };
        {
            let mut st = self.state();
            match st.torrents.get_mut(&hash) {
                Some(e) if !e.moving => e.moving = true,
                _ => return,
            }
        }
        let d = self.clone();
        tokio::spawn(async move {
            let r = d.session.move_storage(id, PathBuf::from(&path)).await;
            if let Some(e) = d.state().torrents.get_mut(&hash) {
                e.moving = false;
                e.content = None;
            }
            match r {
                Ok(()) => {
                    let _ = d
                        .update_record(hash, |rec| match &to {
                            MoveTo::Save { path, managed } => {
                                rec.save_path = path.clone();
                                rec.download_path = None;
                                if !managed {
                                    rec.auto_management = false;
                                }
                            }
                            MoveTo::Download { path } => {
                                rec.download_path = Some(path.clone());
                                rec.auto_management = false;
                            }
                        })
                        .await;
                    d.logs.info(format!("moved {} to {path}", hex(&hash)));
                    d.lifecycle(hash, TimelineKind::Moved, Some(path.clone()))
                        .await;
                    if recheck {
                        d.recheck_finished(hash, id).await;
                    }
                }
                Err(e) => d
                    .logs
                    .warn(format!("moving {} to {path} failed: {e}", hex(&hash))),
            }
        });
    }

    /// `recheck_on_completion`: recheck a finished torrent.
    pub(crate) async fn recheck_finished(self: &Arc<Self>, hash: InfoHash, id: TorrentId) {
        self.logs.info(format!(
            "rechecking {} (recheck_on_completion)",
            self.name_of(&hash)
        ));
        if let Err(e) = self.recheck(id).await {
            self.logs
                .warn(format!("recheck of {}: {e}", self.name_of(&hash)));
        }
    }

    /// A torrent's download path after it was added (qBittorrent's
    /// `setDownloadPath`): an incomplete torrent's content moves there (or,
    /// with `None`, to its save path); a complete one's stays in its save
    /// path. Either way automatic management goes off.
    pub(crate) async fn set_download_path(
        self: &Arc<Self>,
        hash: InfoHash,
        id: TorrentId,
        path: Option<String>,
    ) -> ApiResult<()> {
        let s = self.session.status(id).await?;
        let (save_path, moving) = {
            let st = self.state();
            let e = st
                .torrents
                .get(&hash)
                .ok_or_else(|| ApiError::torrent_not_found(&hex(&hash)))?;
            (e.record.save_path.clone(), e.moving)
        };
        if moving {
            return Err(ApiError::new(
                axum::http::StatusCode::CONFLICT,
                crate::error::ErrorCode::Busy,
                "the torrent is moving",
            ));
        }
        let here = s.save_path.to_string_lossy().into_owned();
        let target = match (&path, s.complete) {
            (_, true) => None,
            (Some(p), false) => Some(MoveTo::Download { path: p.clone() }),
            (None, false) if here != save_path => Some(MoveTo::Save {
                path: save_path,
                managed: false,
            }),
            (None, false) => None,
        };
        match target {
            Some(to) if Some(&here) != path.as_ref() => self.spawn_move(hash, id, to, false),
            _ => {
                self.update_record(hash, |r| {
                    r.download_path = path.filter(|_| !s.complete);
                    r.auto_management = false;
                })
                .await?;
            }
        }
        Ok(())
    }

    /// Write a torrent's `.torrent` into `dir` (`export_dir`,
    /// `export_dir_finished`) as `<name>.torrent`, or `<name> <hash>.torrent`
    /// when a different file has that name. Failures are logged.
    pub(crate) async fn export_torrent(&self, hash: InfoHash, id: TorrentId, dir: &str) {
        let bytes = match self.session.torrent_file(id).await {
            Ok(Some(b)) => b,
            Ok(None) => return,
            Err(e) => {
                self.logs
                    .warn(format!("exporting {}: {e}", self.name_of(&hash)));
                return;
            }
        };
        // The torrent's own name (a rename wins): the tick may not have seen
        // it yet.
        let renamed = self
            .state()
            .torrents
            .get(&hash)
            .and_then(|e| e.record.name.clone());
        let own = Torrent::parse(&bytes).ok().map(|t| t.info.name.clone());
        let name = export_name(&renamed.or(own).unwrap_or_else(|| hex(&hash)), &hex(&hash));
        let short = hex(&hash)[..8].to_string();
        let target = PathBuf::from(dir);
        let r = crate::util::blocking(move || {
            std::fs::create_dir_all(&target)?;
            let first = target.join(format!("{name}.torrent"));
            let path = match std::fs::read(&first) {
                Ok(old) if old == bytes => return Ok(()),
                Ok(_) => target.join(format!("{name} {short}.torrent")),
                Err(_) => first,
            };
            let tmp = path.with_extension("torrent.tmp");
            std::fs::write(&tmp, &bytes)?;
            std::fs::rename(&tmp, &path)
        })
        .await;
        if let Err(e) = r {
            self.logs
                .warn(format!("exporting {} to {dir}: {e}", self.name_of(&hash)));
        }
    }

    /// Change the display name or comment.
    pub(crate) async fn patch_torrent(&self, hash: InfoHash, p: TorrentPatch) -> ApiResult<()> {
        self.update_record(hash, |r| {
            if let Some(name) = p.name {
                r.name = name.filter(|n| !n.is_empty());
            }
            if let Some(comment) = p.comment {
                r.comment = comment;
            }
        })
        .await
    }

    /// Add peers to try.
    pub(crate) async fn add_peers(&self, id: TorrentId, peers: &[SocketAddr]) -> ApiResult<()> {
        for p in peers {
            self.session.add_peer(id, *p).await?;
        }
        Ok(())
    }

    /// Ban addresses session-wide (kept in the settings).
    pub(crate) async fn ban(self: &Arc<Self>, ips: Vec<IpAddr>) -> ApiResult<()> {
        let mut list = self.settings().banned_ips;
        for ip in ips {
            if !list.contains(&ip) {
                list.push(ip);
            }
        }
        self.update_settings(crate::settings::SettingsPatch {
            banned_ips: Some(list),
            ..Default::default()
        })
        .await
        .map(|_| ())
    }

    fn parsed_torrent(bytes: Option<Vec<u8>>) -> ApiResult<Torrent> {
        let bytes = bytes.ok_or_else(|| ApiError::conflict("the metadata is not known yet"))?;
        Torrent::parse(&bytes).map_err(|e| ApiError::internal(format!("stored metainfo: {e}")))
    }

    /// The content files with progress, priority, piece range and availability.
    pub(crate) async fn files(&self, id: TorrentId) -> ApiResult<Vec<FileInfo>> {
        let files = self.session.files(id).await?;
        if files.is_empty() {
            return Ok(Vec::new());
        }
        let t = Self::parsed_torrent(self.session.torrent_file(id).await?)?;
        let pieces = self.session.pieces(id).await?;
        let plen = u64::from(t.info.piece_length.max(1));
        let spans: Vec<(u64, u64)> = t
            .info
            .content_files()
            .map(|f| (f.offset, f.length))
            .collect();
        Ok(files
            .into_iter()
            .enumerate()
            .map(|(index, f)| {
                let (offset, len) = spans.get(index).copied().unwrap_or((0, f.size));
                let first = offset / plen;
                let last = if len == 0 {
                    first
                } else {
                    (offset + len - 1) / plen
                };
                let range =
                    usize::try_from(first).unwrap_or(0)..=usize::try_from(last).unwrap_or(0);
                let (mut total, mut avail) = (0usize, 0usize);
                for p in pieces.get(range).unwrap_or(&[]) {
                    total += 1;
                    if p.availability > 0 || p.state == urtorrent::PieceState::Have {
                        avail += 1;
                    }
                }
                FileInfo {
                    index,
                    path: f.path,
                    size: f.size,
                    progress: if f.size == 0 {
                        1.0
                    } else {
                        f.done as f64 / f.size as f64
                    },
                    priority: f.priority,
                    first_piece: u32::try_from(first).unwrap_or(u32::MAX),
                    last_piece: u32::try_from(last).unwrap_or(u32::MAX),
                    availability: if total == 0 {
                        0.0
                    } else {
                        avail as f64 / total as f64
                    },
                }
            })
            .collect())
    }

    /// Set the priority of some files.
    pub(crate) async fn set_file_priority(
        &self,
        hash: InfoHash,
        id: TorrentId,
        indexes: &[usize],
        priority: u8,
    ) -> ApiResult<()> {
        if priority > 7 {
            return Err(ApiError::bad_request("priority ranges from 0 to 7"));
        }
        let files = self.session.files(id).await?;
        if files.is_empty() {
            return Err(ApiError::conflict("the metadata is not known yet"));
        }
        let mut prios: Vec<u8> = files.iter().map(|f| f.priority).collect();
        for i in indexes {
            let slot = prios
                .get_mut(*i)
                .ok_or_else(|| ApiError::bad_request(format!("no file with index {i}")))?;
            *slot = priority;
        }
        self.session.set_file_priorities(id, prios).await?;
        // File priorities decide every piece again: re-apply first/last.
        let first_last = self
            .state()
            .torrents
            .get(&hash)
            .is_some_and(|e| e.record.first_last_piece_priority);
        if first_last {
            self.apply_first_last(id, true).await?;
        }
        Ok(())
    }

    /// Rename one file by its current path.
    pub(crate) async fn rename_file(
        &self,
        hash: InfoHash,
        id: TorrentId,
        old: &str,
        new: &str,
    ) -> ApiResult<()> {
        let files = self.session.files(id).await?;
        let index = files
            .iter()
            .position(|f| f.path == old)
            .ok_or_else(|| ApiError::not_found(format!("no file {old:?}")))?;
        self.session.rename_file(id, index, new.to_string()).await?;
        self.invalidate_content(hash);
        Ok(())
    }

    /// Rename a folder: every file under `old/` moves under `new/`.
    pub(crate) async fn rename_folder(
        &self,
        hash: InfoHash,
        id: TorrentId,
        old: &str,
        new: &str,
    ) -> ApiResult<()> {
        let old = old.trim_end_matches('/');
        let new = new.trim_end_matches('/');
        if old.is_empty() || new.is_empty() {
            return Err(ApiError::bad_request("folder paths must not be empty"));
        }
        let prefix = format!("{old}/");
        let files = self.session.files(id).await?;
        let moves: Vec<(usize, String)> = files
            .iter()
            .enumerate()
            .filter_map(|(i, f)| {
                f.path
                    .strip_prefix(&prefix)
                    .map(|rest| (i, format!("{new}/{rest}")))
            })
            .collect();
        if moves.is_empty() {
            return Err(ApiError::not_found(format!("no folder {old:?}")));
        }
        // Some files may have moved even when a later rename fails.
        let mut r = Ok(());
        for (i, path) in moves {
            r = self.session.rename_file(id, i, path).await;
            if r.is_err() {
                break;
            }
        }
        self.invalidate_content(hash);
        Ok(r?)
    }

    /// The torrent's file paths changed.
    pub(crate) fn invalidate_content(&self, hash: InfoHash) {
        if let Some(e) = self.state().torrents.get_mut(&hash) {
            e.content = None;
        }
        self.invalidate_files(&hash);
    }

    pub(crate) fn invalidate_trackers(&self, hash: InfoHash) {
        if let Some(e) = self.state().torrents.get_mut(&hash) {
            e.tracker_urls = None;
        }
    }

    /// Trackers plus the trackerless sources.
    pub(crate) async fn trackers(&self, id: TorrentId) -> ApiResult<TrackersResponse> {
        let status = self.session.status(id).await?;
        let peers = self.session.peers(id).await?;
        let settings = self.settings();
        let count = |src: urtorrent::PeerSource| peers.iter().filter(|p| p.source == src).count();
        let public = !status.private;
        Ok(TrackersResponse {
            trackers: status
                .trackers
                .iter()
                .map(|t| TrackerInfo {
                    url: t.url.clone(),
                    tier: t.tier,
                    status: if t.updating {
                        TrackerStatus::Updating
                    } else if t.working {
                        TrackerStatus::Working
                    } else if t.fails > 0 {
                        TrackerStatus::NotWorking
                    } else {
                        TrackerStatus::NotContacted
                    },
                    message: t.last_error.clone(),
                    fails: t.fails,
                    seeders: t.seeders,
                    leechers: t.leechers,
                    downloaded: t.downloaded,
                    next_announce_in: t.next_announce_in.map(|d| d.as_secs()),
                    updating: t.updating,
                    endpoints: t
                        .endpoints
                        .iter()
                        .map(|ep| TrackerEndpointInfo {
                            local: ep.local.to_string(),
                            working: ep.working,
                            updating: ep.updating,
                            fails: ep.fails,
                            message: ep.last_error.clone(),
                            seeders: ep.seeders,
                            leechers: ep.leechers,
                            next_announce_in: ep.next_announce_in.map(|d| d.as_secs()),
                        })
                        .collect(),
                })
                .collect(),
            dht: PeerSourceInfo {
                enabled: public && settings.dht,
                peers: count(urtorrent::PeerSource::Dht),
            },
            pex: PeerSourceInfo {
                enabled: public && settings.pex,
                peers: count(urtorrent::PeerSource::Pex),
            },
            lsd: PeerSourceInfo {
                enabled: public && settings.lsd,
                peers: count(urtorrent::PeerSource::Lsd),
            },
        })
    }

    /// Add trackers (a tier of their own after the last, unless `tier` is given).
    pub(crate) async fn add_trackers(
        &self,
        hash: InfoHash,
        id: TorrentId,
        urls: &[String],
        tier: Option<usize>,
    ) -> ApiResult<()> {
        for u in urls {
            if !valid_tracker_url(u) {
                return Err(ApiError::bad_request(format!(
                    "{u:?} is not an http, https or udp URL"
                )));
            }
        }
        let existing = self.session.trackers(id).await?;
        let next = existing.iter().map(|t| t.tier + 1).max().unwrap_or(0);
        for (i, u) in urls.iter().enumerate() {
            if existing.iter().any(|t| t.url == *u) {
                continue;
            }
            self.session
                .add_tracker(id, u.clone(), tier.unwrap_or(next + i))
                .await?;
        }
        self.invalidate_trackers(hash);
        Ok(())
    }

    /// Remove trackers.
    pub(crate) async fn remove_trackers(
        &self,
        hash: InfoHash,
        id: TorrentId,
        urls: &[String],
    ) -> ApiResult<()> {
        let existing = self.session.trackers(id).await?;
        for u in urls {
            if !existing.iter().any(|t| t.url == *u) {
                return Err(ApiError::not_found(format!("no tracker {u:?}")));
            }
        }
        for u in urls {
            self.session.remove_tracker(id, u.clone()).await?;
        }
        self.invalidate_trackers(hash);
        Ok(())
    }

    /// Replace a tracker's URL, keeping its tier.
    pub(crate) async fn edit_tracker(
        &self,
        hash: InfoHash,
        id: TorrentId,
        url: &str,
        new_url: &str,
    ) -> ApiResult<()> {
        if !valid_tracker_url(new_url) {
            return Err(ApiError::bad_request(format!(
                "{new_url:?} is not an http, https or udp URL"
            )));
        }
        let existing = self.session.trackers(id).await?;
        let tier = existing
            .iter()
            .find(|t| t.url == url)
            .map(|t| t.tier)
            .ok_or_else(|| ApiError::not_found(format!("no tracker {url:?}")))?;
        if existing.iter().any(|t| t.url == new_url) {
            return Err(ApiError::conflict(format!("tracker {new_url:?} exists")));
        }
        self.session.remove_tracker(id, url.to_string()).await?;
        self.session
            .add_tracker(id, new_url.to_string(), tier)
            .await?;
        self.invalidate_trackers(hash);
        Ok(())
    }

    /// Web seed URLs.
    pub(crate) async fn web_seeds(&self, id: TorrentId) -> ApiResult<Vec<String>> {
        Ok(self.session.status(id).await?.web_seed_urls)
    }

    /// Add web seeds.
    pub(crate) async fn add_web_seeds(&self, id: TorrentId, urls: &[String]) -> ApiResult<()> {
        for u in urls {
            let l = u.to_ascii_lowercase();
            if !(l.starts_with("http://") || l.starts_with("https://")) {
                return Err(ApiError::bad_request(format!(
                    "{u:?} is not an http(s) URL"
                )));
            }
        }
        for u in urls {
            self.session.add_web_seed(id, u.clone()).await?;
        }
        Ok(())
    }

    /// Remove web seeds.
    pub(crate) async fn remove_web_seeds(&self, id: TorrentId, urls: &[String]) -> ApiResult<()> {
        let existing = self.web_seeds(id).await?;
        for u in urls {
            if !existing.contains(u) {
                return Err(ApiError::not_found(format!("no web seed {u:?}")));
            }
        }
        for u in urls {
            self.session.remove_web_seed(id, u.clone()).await?;
        }
        Ok(())
    }

    /// Replace a web seed URL.
    pub(crate) async fn edit_web_seed(
        &self,
        id: TorrentId,
        url: &str,
        new_url: &str,
    ) -> ApiResult<()> {
        self.remove_web_seeds(id, &[url.to_string()]).await?;
        self.add_web_seeds(id, &[new_url.to_string()]).await
    }

    /// Connected peers.
    pub(crate) async fn peers(&self, id: TorrentId) -> ApiResult<Vec<model::PeerInfo>> {
        let status = self.session.status(id).await?;
        let total = status.pieces_total.max(1) as f64;
        Ok(self
            .session
            .peers(id)
            .await?
            .into_iter()
            .map(|p| {
                let loc = self.geo.lookup(p.addr.ip());
                (p, loc)
            })
            .map(|(p, loc)| model::PeerInfo {
                country: loc.country,
                asn: loc.asn,
                as_org: loc.as_org,
                address: p.addr.to_string(),
                source: match p.source {
                    urtorrent::PeerSource::Tracker => model::PeerSource::Tracker,
                    urtorrent::PeerSource::Manual => model::PeerSource::Manual,
                    urtorrent::PeerSource::Pex => model::PeerSource::Pex,
                    urtorrent::PeerSource::Lsd => model::PeerSource::Lsd,
                    urtorrent::PeerSource::Incoming => model::PeerSource::Incoming,
                    urtorrent::PeerSource::Dht => model::PeerSource::Dht,
                    urtorrent::PeerSource::Resume => model::PeerSource::Resume,
                },
                incoming: p.incoming,
                transport: match p.transport {
                    urtorrent::PeerTransport::Tcp => model::PeerTransport::Tcp,
                    urtorrent::PeerTransport::Utp => model::PeerTransport::Utp,
                    _ => model::PeerTransport::Other,
                },
                encrypted: p.encrypted,
                client: p.client.clone(),
                peer_id: p.peer_id.map(|id| hex(&id)),
                progress: if p.is_seed {
                    1.0
                } else {
                    (p.pieces as f64 / total).min(1.0)
                },
                is_seed: p.is_seed,
                upload_only: p.upload_only,
                downloaded: p.downloaded,
                uploaded: p.uploaded,
                download_rate: p.download_rate,
                upload_rate: p.upload_rate,
                peer_choking: p.peer_choking,
                am_choking: p.am_choking,
                peer_interested: p.peer_interested,
                am_interested: p.am_interested,
                outstanding_requests: p.outstanding,
                connected_for: p.connected_for.as_secs(),
            })
            .collect())
    }

    /// Piece states and availability.
    pub(crate) async fn pieces(&self, id: TorrentId) -> ApiResult<PiecesResponse> {
        let pieces = self.session.pieces(id).await?;
        Ok(PiecesResponse {
            states: pieces
                .iter()
                .map(|p| match p.state {
                    urtorrent::PieceState::Missing => model::PieceState::Missing,
                    urtorrent::PieceState::Downloading => model::PieceState::Downloading,
                    urtorrent::PieceState::Have => model::PieceState::Have,
                })
                .collect(),
            availability: pieces.iter().map(|p| p.availability).collect(),
            priorities: pieces.iter().map(|p| p.priority).collect(),
        })
    }

    /// Piece hashes, hex, in piece order.
    pub(crate) async fn piece_hashes(&self, id: TorrentId) -> ApiResult<Vec<String>> {
        let t = Self::parsed_torrent(self.session.torrent_file(id).await?)?;
        Ok(t.info.piece_hashes.iter().map(|h| hex(h)).collect())
    }

    /// The `.torrent` (current trackers and web seeds included).
    pub(crate) async fn torrent_file(&self, id: TorrentId) -> ApiResult<Vec<u8>> {
        self.session
            .torrent_file(id)
            .await?
            .ok_or_else(|| ApiError::conflict("the metadata is not known yet"))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn peer_ips() {
        assert_eq!(parse_peer_ip("1.2.3.4"), Some("1.2.3.4".parse().unwrap()));
        assert_eq!(
            parse_peer_ip("1.2.3.4:5678"),
            Some("1.2.3.4".parse().unwrap())
        );
        assert_eq!(
            parse_peer_ip("[fd00::1]:80"),
            Some("fd00::1".parse().unwrap())
        );
        assert_eq!(parse_peer_ip("fd00::1"), Some("fd00::1".parse().unwrap()));
        assert_eq!(parse_peer_ip("nope"), None);
    }
}
