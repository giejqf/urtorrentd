// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Read models: torrent list rows, torrent detail, transfer info. List rows
//! come from the `statuses()` snapshot (which carries the tracker summary,
//! distributed copies, activity times and the sequential flag since
//! urtorrent 0.12), plus two caches that only change on edits: tracker URLs
//! for magnet links and the content path (AGENTS.md 4.4).

use std::path::Path;

use urtorrent::{InfoHash, TorrentId, TorrentStatus};

use super::{ContentLayoutInfo, Daemon, Entry, State};
use crate::error::ApiResult;
use crate::model::{
    ConnectionStatus, TorrentDetail, TorrentErrorKind, TorrentFilter, TorrentListQuery,
    TorrentSort, TorrentState, TorrentSummary, TransferInfo,
};
use crate::util::{blocking, hex, now, percent_encode};

/// Share ratio: uploaded over downloaded. A torrent that downloaded less than
/// 1% of what it has (added complete, or mostly) divides by what it has
/// instead, so seeding from existing data still yields a meaningful ratio.
pub(crate) fn ratio(uploaded: u64, downloaded: u64, have: u64) -> Option<f64> {
    let base = if downloaded < have / 100 {
        have
    } else {
        downloaded
    };
    (base > 0).then(|| uploaded as f64 / base as f64)
}

fn layout_of(files: &[urtorrent::FileStatus]) -> Option<ContentLayoutInfo> {
    let first = files.first()?;
    if files.len() == 1 && !first.path.contains('/') {
        return Some(ContentLayoutInfo {
            content: first.path.clone(),
            root: None,
        });
    }
    let root = first.path.split_once('/').map(|(r, _)| r.to_string());
    let shared = root.as_ref().filter(|r| {
        let prefix = format!("{r}/");
        files.iter().all(|f| f.path.starts_with(&prefix))
    });
    Some(match shared {
        Some(r) => ContentLayoutInfo {
            content: r.clone(),
            root: Some(r.clone()),
        },
        None => ContentLayoutInfo {
            content: String::new(),
            root: None,
        },
    })
}

fn join(dir: &Path, rel: &str) -> String {
    if rel.is_empty() {
        dir.to_string_lossy().into_owned()
    } else {
        dir.join(rel).to_string_lossy().into_owned()
    }
}

fn magnet_uri(hash: &InfoHash, name: &str, trackers: &[String]) -> String {
    let mut uri = format!("magnet:?xt=urn:btih:{}", hex(hash));
    if !name.is_empty() {
        uri.push_str("&dn=");
        uri.push_str(&percent_encode(name));
    }
    for t in trackers {
        uri.push_str("&tr=");
        uri.push_str(&percent_encode(t));
    }
    uri
}

fn opt_limit(v: u64) -> Option<u64> {
    (v > 0).then_some(v)
}

fn error_kind(k: urtorrent::ErrorKind) -> TorrentErrorKind {
    match k {
        urtorrent::ErrorKind::ContentMissing => TorrentErrorKind::ContentMissing,
        urtorrent::ErrorKind::Io => TorrentErrorKind::Io,
        urtorrent::ErrorKind::Metadata => TorrentErrorKind::Metadata,
        _ => TorrentErrorKind::Other,
    }
}

/// A torrent's state as the API shows it.
pub(crate) fn api_state(s: &TorrentStatus, moving: bool) -> TorrentState {
    use urtorrent::TorrentState as L;
    if moving {
        return TorrentState::Moving;
    }
    match s.state {
        L::FetchingMetadata => TorrentState::Metadata,
        L::QueuedForChecking => TorrentState::CheckingQueued,
        L::Checking => TorrentState::Checking,
        L::Downloading => TorrentState::Downloading,
        L::Seeding => TorrentState::Seeding,
        L::Queued => TorrentState::Queued,
        L::Paused => TorrentState::Stopped,
        L::Error => TorrentState::Error,
        L::Held => TorrentState::Held,
        _ => TorrentState::Unknown,
    }
}

/// Whether a search word matches a list row: its name, category, a tag,
/// one of its trackers' hosts (`hosts`), or (6+ hex digits) the start of
/// its info-hash.
fn search_matches(word: &regex::Regex, t: &TorrentSummary, hosts: &[String]) -> bool {
    let w = word.as_str();
    (w.len() >= 6
        && w.bytes().all(|b| b.is_ascii_hexdigit())
        && t.hash.starts_with(&w.to_ascii_lowercase()))
        || word.is_match(&t.name)
        || t.category.as_deref().is_some_and(|c| word.is_match(c))
        || t.tags.iter().any(|x| word.is_match(x))
        || hosts.iter().any(|h| word.is_match(h))
}

/// Build a list row.
pub(crate) fn summary(s: &TorrentStatus, e: &Entry, st: &State) -> TorrentSummary {
    use urtorrent::TorrentState as L;
    let r = &e.record;
    let state = api_state(s, e.moving);
    let running = !matches!(s.state, L::Paused | L::Error | L::Held);
    let stalled = match s.state {
        L::Downloading => s.download_rate == 0,
        L::Seeding => s.upload_rate == 0,
        _ => false,
    };
    let (base_down, base_up) = e.baseline.unwrap_or((s.downloaded, s.uploaded));
    let left = s.total_wanted.saturating_sub(s.total_wanted_done);
    let ratio = ratio(s.uploaded, s.downloaded, s.total_wanted_done);
    let active_secs = s.active_time.as_secs();
    let name = r.name.clone().unwrap_or_else(|| s.name.clone());
    let urls = e.tracker_urls.clone().unwrap_or_default();
    let mut tracker_hosts: Vec<String> = Vec::new();
    for host in urls
        .iter()
        .filter_map(|u| crate::stats::db::tracker_host(u))
    {
        if !tracker_hosts.contains(&host) {
            tracker_hosts.push(host);
        }
    }
    let (content_path, root_path) = match &e.content {
        Some(c) => (
            Some(join(&s.save_path, &c.content)),
            c.root.as_ref().map(|root| join(&s.save_path, root)),
        ),
        None => (None, None),
    };
    TorrentSummary {
        hash: hex(&s.info_hash),
        magnet_uri: magnet_uri(&s.info_hash, &s.name, &urls),
        name,
        state,
        stalled,
        forced: running && !s.auto_managed,
        complete: s.complete,
        error: s.error.clone(),
        error_kind: s.error_kind.map(error_kind),
        progress: s.wanted_progress(),
        size: s.total_wanted,
        total_size: s.total_size,
        completed: s.total_wanted_done,
        left,
        downloaded: s.downloaded,
        uploaded: s.uploaded,
        downloaded_session: s.downloaded.saturating_sub(base_down),
        uploaded_session: s.uploaded.saturating_sub(base_up),
        wasted: s.corrupt.saturating_add(s.redundant),
        ratio,
        download_rate: s.download_rate,
        upload_rate: s.upload_rate,
        eta: (!s.complete && s.download_rate > 0).then(|| left / s.download_rate),
        download_limit: opt_limit(s.download_limit),
        upload_limit: opt_limit(s.upload_limit),
        max_connections: s.max_peers.unwrap_or_else(|| {
            usize::try_from(st.settings.max_connections_per_torrent).unwrap_or(usize::MAX)
        }),
        max_uploads: s.max_uploads,
        peers: s.peers,
        seeds: s.seeds,
        swarm_seeds: s.swarm_seeders,
        swarm_leechers: s.swarm_leechers,
        availability: s.distributed_copies().map(f64::from),
        save_path: r.save_path.clone(),
        download_path: r.download_path.clone(),
        content_path,
        root_path,
        category: r.category.clone(),
        tags: r.tags.iter().cloned().collect(),
        added_on: s.added_on,
        completed_on: s.completed_on,
        last_activity: super::tick::last_activity(s),
        seen_complete: if s.complete || s.seeds > 0 {
            Some(now())
        } else {
            s.last_seen_complete
        },
        active_time: active_secs,
        seeding_time: s.seeding_time.as_secs(),
        queue_position: s.queue_position,
        auto_management: r.auto_management,
        sequential: s.sequential,
        first_last_piece_priority: r.first_last_piece_priority,
        private: s.private,
        has_metadata: s.has_metadata,
        piece_size: s.piece_length,
        pieces_have: s.pieces_have,
        pieces_total: s.pieces_total,
        tracker: s.working_tracker.clone(),
        trackers_count: s.trackers_count,
        tracker_hosts,
        comment: r.comment.clone().or_else(|| s.comment.clone()),
        created_by: s.created_by.clone(),
        creation_date: s.creation_date,
        share_limits: r.share_limits,
        popularity: match (ratio, active_secs) {
            (Some(r), secs) if secs > 0 => Some(r * 2_592_000.0 / secs as f64),
            _ => None,
        },
        next_announce_in: s.next_announce_in.map(|d| d.as_secs()),
    }
}

/// Whether a row passes a state filter.
pub(crate) fn filter_matches(f: TorrentFilter, t: &TorrentSummary) -> bool {
    let running = !matches!(
        t.state,
        TorrentState::Stopped | TorrentState::Error | TorrentState::Held
    );
    let active = t.download_rate > 0 || t.upload_rate > 0;
    match f {
        TorrentFilter::All => true,
        TorrentFilter::Downloading => !t.complete,
        TorrentFilter::Seeding => t.complete && running,
        TorrentFilter::Completed => t.complete,
        TorrentFilter::Stopped => matches!(t.state, TorrentState::Stopped | TorrentState::Held),
        TorrentFilter::Running => running,
        TorrentFilter::Active => active,
        TorrentFilter::Inactive => !active,
        TorrentFilter::Stalled => t.stalled,
        TorrentFilter::StalledSeeding => t.stalled && t.state == TorrentState::Seeding,
        TorrentFilter::StalledDownloading => t.stalled && t.state == TorrentState::Downloading,
        TorrentFilter::Checking => {
            matches!(
                t.state,
                TorrentState::Checking | TorrentState::CheckingQueued
            )
        }
        TorrentFilter::Moving => t.state == TorrentState::Moving,
        TorrentFilter::Errored => t.state == TorrentState::Error,
    }
}

fn sort_rows(rows: &mut [TorrentSummary], key: TorrentSort) {
    use std::cmp::Ordering;
    fn f(a: Option<f64>, b: Option<f64>) -> Ordering {
        a.unwrap_or(-1.0).total_cmp(&b.unwrap_or(-1.0))
    }
    rows.sort_by(|a, b| match key {
        TorrentSort::Name => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        TorrentSort::Size => a.size.cmp(&b.size),
        TorrentSort::Progress => a.progress.total_cmp(&b.progress),
        TorrentSort::DownloadRate => a.download_rate.cmp(&b.download_rate),
        TorrentSort::UploadRate => a.upload_rate.cmp(&b.upload_rate),
        TorrentSort::AddedOn => a.added_on.cmp(&b.added_on),
        TorrentSort::CompletedOn => a.completed_on.cmp(&b.completed_on),
        TorrentSort::Ratio => f(a.ratio, b.ratio),
        TorrentSort::QueuePosition => a.queue_position.cmp(&b.queue_position),
        TorrentSort::State => format!("{:?}", a.state).cmp(&format!("{:?}", b.state)),
        TorrentSort::Uploaded => a.uploaded.cmp(&b.uploaded),
        TorrentSort::Downloaded => a.downloaded.cmp(&b.downloaded),
        TorrentSort::Eta => a.eta.unwrap_or(u64::MAX).cmp(&b.eta.unwrap_or(u64::MAX)),
        TorrentSort::Category => a.category.cmp(&b.category),
    });
}

impl Daemon {
    /// Fill the caches list rows need (tracker URLs, content path), for the
    /// torrents whose cache was invalidated.
    async fn refresh_caches(&self, statuses: &[TorrentStatus]) {
        let (tracker_ids, content_ids) = {
            let st = self.state();
            let (mut t, mut c) = (Vec::new(), Vec::new());
            for s in statuses {
                let Some(e) = st.torrents.get(&s.info_hash) else {
                    continue;
                };
                if e.tracker_urls.is_none() {
                    t.push((s.info_hash, e.id));
                }
                if e.content.is_none() && s.has_metadata {
                    c.push((s.info_hash, e.id));
                }
            }
            (t, c)
        };
        for (h, id) in tracker_ids {
            if let Ok(list) = self.session.trackers(id).await {
                let urls: Vec<String> = list.into_iter().map(|t| t.url).collect();
                self.set_cache(h, |e| e.tracker_urls = Some(urls));
            }
        }
        for (h, id) in content_ids {
            if let Ok(files) = self.session.files(id).await
                && let Some(layout) = layout_of(&files)
            {
                self.set_cache(h, |e| e.content = Some(layout));
            }
        }
    }

    fn set_cache(&self, hash: InfoHash, f: impl FnOnce(&mut Entry)) {
        if let Some(e) = self.state().torrents.get_mut(&hash) {
            f(e);
        }
    }

    /// Every torrent's list row, in queue order.
    pub(crate) async fn summaries(&self) -> ApiResult<Vec<TorrentSummary>> {
        let statuses = self.session.statuses().await?;
        self.refresh_caches(&statuses).await;
        let st = self.state();
        let mut rows: Vec<TorrentSummary> = statuses
            .iter()
            .filter_map(|s| st.torrents.get(&s.info_hash).map(|e| summary(s, e, &st)))
            .collect();
        rows.sort_by_key(|r| r.queue_position);
        Ok(rows)
    }

    /// The torrent list with filters, sorting and paging.
    pub(crate) async fn list(&self, q: &TorrentListQuery) -> ApiResult<Vec<TorrentSummary>> {
        let words = crate::util::search_words(q.search.as_deref().unwrap_or(""))
            .map_err(crate::error::ApiError::bad_request)?;
        let hashes: Option<Vec<String>> = q.hashes.as_ref().map(|h| {
            h.split('|')
                .map(|x| x.trim().to_ascii_lowercase())
                .collect()
        });
        let rows = self.summaries().await?;
        let mut rows: Vec<TorrentSummary> = rows
            .into_iter()
            .filter(|t| filter_matches(q.filter.unwrap_or_default(), t))
            .filter(|t| match q.category.as_deref() {
                None => true,
                Some("") => t.category.is_none(),
                Some(c) => t.category.as_deref() == Some(c),
            })
            .filter(|t| match q.tag.as_deref() {
                None => true,
                Some("") => t.tags.is_empty(),
                Some(tag) => t.tags.iter().any(|x| x == tag),
            })
            .filter(|t| match q.tracker.as_deref() {
                None => true,
                Some("") => t.trackers_count == 0,
                Some(host) => t.tracker_hosts.iter().any(|h| h.eq_ignore_ascii_case(host)),
            })
            .filter(|t| hashes.as_ref().is_none_or(|h| h.contains(&t.hash)))
            .filter(|t| q.private.is_none_or(|p| t.private == p))
            // Every tracker's host, not only the working one's.
            .filter(|t| words.iter().all(|w| search_matches(w, t, &t.tracker_hosts)))
            .collect();
        if let Some(key) = q.sort {
            sort_rows(&mut rows, key);
        }
        if q.reverse.unwrap_or(false) {
            rows.reverse();
        }
        let offset = q.offset.unwrap_or(0);
        let rows: Vec<TorrentSummary> = rows
            .into_iter()
            .skip(offset)
            .take(q.limit.unwrap_or(usize::MAX))
            .collect();
        Ok(rows)
    }

    /// One torrent in full.
    pub(crate) async fn detail(&self, hash: InfoHash, id: TorrentId) -> ApiResult<TorrentDetail> {
        let s = self.session.status(id).await?;
        let files = self.session.files(id).await.unwrap_or_default();
        let st = &mut *self.state();
        let e = st
            .torrents
            .get_mut(&hash)
            .ok_or_else(|| crate::error::ApiError::torrent_not_found(&hex(&hash)))?;
        e.tracker_urls = Some(s.trackers.iter().map(|t| t.url.clone()).collect());
        if let Some(layout) = layout_of(&files) {
            e.content = Some(layout);
        }
        let e = st
            .torrents
            .get(&hash)
            .ok_or_else(|| crate::error::ApiError::torrent_not_found(&hex(&hash)))?;
        Ok(TorrentDetail {
            summary: summary(&s, e, st),
            web_seeds: s.web_seed_urls.clone(),
            known_peers: s.peer_list_size,
            source_url: e.record.source_url.clone(),
        })
    }

    /// Session-wide transfer state.
    pub(crate) async fn transfer_info(&self) -> ApiResult<TransferInfo> {
        let stats = self.session.stats().await?;
        let (settings, base, incoming) = {
            let st = self.state();
            (st.settings.clone(), st.base_totals, st.incoming_seen)
        };
        let path = settings.save_path.clone();
        let free_space = blocking(move || {
            rustix::fs::statvfs(path.as_str())
                .map(|v| v.f_bavail.saturating_mul(v.f_frsize))
                .map_err(std::io::Error::from)
        })
        .await
        .ok();
        let downloaded_total = base.downloaded.saturating_add(stats.downloaded);
        let uploaded_total = base.uploaded.saturating_add(stats.uploaded);
        let (up, down) = settings.effective_rate_limits();
        Ok(TransferInfo {
            download_rate: stats.download_rate,
            upload_rate: stats.upload_rate,
            downloaded_session: stats.downloaded,
            uploaded_session: stats.uploaded,
            downloaded_total,
            uploaded_total,
            ratio: (downloaded_total > 0).then(|| uploaded_total as f64 / downloaded_total as f64),
            download_limit: opt_limit(down),
            upload_limit: opt_limit(up),
            alt_speed_enabled: settings.alt_speed_enabled,
            connection_status: if incoming {
                ConnectionStatus::Connected
            } else {
                ConnectionStatus::Firewalled
            },
            listen_port: self.session.listen_port(),
            peers: stats.peers,
            connections: stats.connections,
            dht_nodes: stats.dht_nodes,
            external_v4: stats.external_v4.map(|a| a.to_string()),
            external_v6: stats.external_v6.map(|a| a.to_string()),
            free_space,
            disk_jobs_pending: stats.disk_jobs_pending,
        })
    }

    /// The torrent count.
    pub(crate) fn count(&self) -> usize {
        self.state().torrents.len()
    }

    /// A torrent's display name (for log lines).
    pub(crate) fn name_of(&self, hash: &InfoHash) -> String {
        self.state()
            .torrents
            .get(hash)
            .and_then(|e| e.record.name.clone().or_else(|| e.name.clone()))
            .unwrap_or_else(|| hex(hash))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ratios() {
        assert_eq!(ratio(0, 0, 0), None);
        assert_eq!(ratio(50, 100, 100), Some(0.5));
        // Added complete: divide by what we have.
        assert_eq!(ratio(200, 0, 100), Some(2.0));
        assert_eq!(ratio(200, 1000, 1000), Some(0.2));
    }
}
