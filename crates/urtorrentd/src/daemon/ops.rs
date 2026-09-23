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
    self, FileInfo, LimitsRequest, PeerSourceInfo, PiecesResponse, QueueMoveTo, TorrentPatch,
    TrackerInfo, TrackerStatus, TrackersResponse,
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

impl Daemon {
    /// Start (resume under the queue).
    pub(crate) async fn start_torrent(&self, hash: InfoHash, id: TorrentId) -> ApiResult<()> {
        self.refuse_errored(id).await?;
        self.session.resume(id).await?;
        self.update_record(hash, |r| r.stopped = false).await
    }

    /// Stop.
    pub(crate) async fn stop_torrent(&self, hash: InfoHash, id: TorrentId) -> ApiResult<()> {
        self.session.pause(id).await?;
        self.update_record(hash, |r| {
            r.stopped = true;
            r.stop_condition = StopCondition::None;
        })
        .await
    }

    /// Force start (`true`) or hand back to the queue (`false`).
    pub(crate) async fn force_start(
        &self,
        hash: InfoHash,
        id: TorrentId,
        on: bool,
    ) -> ApiResult<()> {
        if on {
            self.refuse_errored(id).await?;
            self.session.force_resume(id).await?;
            self.update_record(hash, |r| r.stopped = false).await
        } else {
            self.session.set_auto_managed(id, true).await?;
            Ok(())
        }
    }

    /// Start a full recheck; it runs in the background.
    pub(crate) async fn recheck(self: &Arc<Self>, id: TorrentId) -> ApiResult<()> {
        self.refuse_errored(id).await?;
        let d = self.clone();
        tokio::spawn(async move {
            if let Err(e) = d.session.force_recheck(id).await {
                d.logs.warn(format!("recheck failed: {e}"));
            }
        });
        Ok(())
    }

    /// The library cannot clear a torrent's error: `resume` and
    /// `force_recheck` do nothing on an errored torrent (and the recheck
    /// reports success). Say so instead of claiming a success
    /// (docs/gaps.md, item 1).
    async fn refuse_errored(&self, id: TorrentId) -> ApiResult<()> {
        let st = self.session.status(id).await?;
        if st.state == urtorrent::TorrentState::Error {
            return Err(ApiError::conflict(format!(
                "the torrent stopped with an error ({}); it cannot be restarted or rechecked \
                 yet: remove it and add it again",
                st.error.unwrap_or_default()
            )));
        }
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
        }
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

    /// Sequential download on or off.
    pub(crate) async fn set_sequential(
        &self,
        hash: InfoHash,
        id: TorrentId,
        on: bool,
    ) -> ApiResult<()> {
        self.session.set_sequential(id, on).await?;
        self.update_record(hash, |r| r.sequential = on).await
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
        path: String,
        managed: bool,
    ) {
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
                        .update_record(hash, |rec| {
                            rec.save_path = path.clone();
                            rec.download_path = None;
                            if !managed {
                                rec.auto_management = false;
                            }
                        })
                        .await;
                    d.logs.info(format!("moved {} to {path}", hex(&hash)));
                }
                Err(e) => d
                    .logs
                    .warn(format!("moving {} to {path} failed: {e}", hex(&hash))),
            }
        });
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
        Ok(self.session.set_file_priorities(id, prios).await?)
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
        for (i, path) in moves {
            self.session.rename_file(id, i, path).await?;
        }
        self.invalidate_content(hash);
        Ok(())
    }

    pub(crate) fn invalidate_content(&self, hash: InfoHash) {
        if let Some(e) = self.state().torrents.get_mut(&hash) {
            e.content = None;
        }
    }

    pub(crate) fn invalidate_trackers(&self, hash: InfoHash) {
        if let Some(e) = self.state().torrents.get_mut(&hash) {
            e.trackers = None;
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
                    status: if t.working {
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
            .map(|p| model::PeerInfo {
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
