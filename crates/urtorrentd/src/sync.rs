// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Incremental sync (AGENTS.md 4.6), polled (`GET /sync`) or pushed as
//! server-sent events (`GET /events`). The daemon builds a snapshot at most
//! every [`MIN_INTERVAL`], however many clients there are, and keeps the
//! fingerprints of the last [`KEEP`] snapshots. A client passes the `rev` it
//! holds; if that snapshot is still kept it gets only what changed, otherwise
//! everything. Polling keeps no per-client state; a stream keeps only the
//! last `rev` and transfer state it sent.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::convert::Infallible;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::response::sse::Event;
use futures_util::Stream;
use serde::Serialize;
use tokio::sync::watch;
use tokio::time::{Interval, MissedTickBehavior};

use crate::daemon::Daemon;
use crate::error::ApiResult;
use crate::model::{SyncResponse, TorrentSummary, TransferInfo};
use crate::store::Category;

/// Snapshots are rebuilt at most this often.
pub const MIN_INTERVAL: Duration = Duration::from_millis(500);
/// Snapshots whose fingerprints are kept for diffs.
pub const KEEP: usize = 16;
/// A stream looks for changes this often (and sends only when there are).
pub const PUSH_INTERVAL: Duration = Duration::from_secs(1);

fn fingerprint<T: Serialize>(v: &T) -> u64 {
    let mut h = DefaultHasher::new();
    serde_json::to_vec(v).unwrap_or_default().hash(&mut h);
    h.finish()
}

/// Fingerprints of one snapshot.
#[derive(Debug, Default)]
struct Prints {
    rev: u64,
    torrents: HashMap<String, u64>,
    categories: HashMap<String, u64>,
    tags: u64,
}

/// The newest snapshot in full.
#[derive(Debug)]
struct Latest {
    built: Instant,
    torrents: BTreeMap<String, TorrentSummary>,
    categories: BTreeMap<String, Category>,
    tags: Vec<String>,
    transfer: TransferInfo,
}

/// Sync state shared by all clients.
#[derive(Debug, Default)]
pub struct SyncState {
    next_rev: u64,
    kept: VecDeque<Arc<Prints>>,
    latest: Option<Arc<Latest>>,
}

impl Daemon {
    /// Everything, or the changes since `rev`.
    pub(crate) async fn sync(&self, rev: Option<u64>) -> ApiResult<SyncResponse> {
        let (latest, prints) = self.snapshot().await?;
        let base = rev.and_then(|r| {
            let s = self.sync.lock().ok()?;
            s.kept.iter().find(|p| p.rev == r).cloned()
        });
        let mut out = SyncResponse {
            rev: prints.rev,
            full: base.is_none(),
            torrents: BTreeMap::new(),
            torrents_removed: Vec::new(),
            categories: BTreeMap::new(),
            categories_removed: Vec::new(),
            tags: None,
            transfer: latest.transfer.clone(),
        };
        match base {
            None => {
                out.torrents = latest.torrents.clone();
                out.categories = latest.categories.clone();
                out.tags = Some(latest.tags.clone());
            }
            Some(old) => {
                for (h, t) in &latest.torrents {
                    if old.torrents.get(h) != prints.torrents.get(h) {
                        out.torrents.insert(h.clone(), t.clone());
                    }
                }
                out.torrents_removed = old
                    .torrents
                    .keys()
                    .filter(|h| !prints.torrents.contains_key(*h))
                    .cloned()
                    .collect();
                out.torrents_removed.sort();
                for (n, c) in &latest.categories {
                    if old.categories.get(n) != prints.categories.get(n) {
                        out.categories.insert(n.clone(), c.clone());
                    }
                }
                out.categories_removed = old
                    .categories
                    .keys()
                    .filter(|n| !prints.categories.contains_key(*n))
                    .cloned()
                    .collect();
                out.categories_removed.sort();
                if old.tags != prints.tags {
                    out.tags = Some(latest.tags.clone());
                }
            }
        }
        Ok(out)
    }

    /// The current snapshot, rebuilt if older than [`MIN_INTERVAL`].
    async fn snapshot(&self) -> ApiResult<(Arc<Latest>, Arc<Prints>)> {
        {
            let s = self
                .sync
                .lock()
                .map_err(|_| crate::error::ApiError::internal("sync state poisoned"))?;
            if let (Some(l), Some(p)) = (&s.latest, s.kept.back())
                && l.built.elapsed() < MIN_INTERVAL
            {
                return Ok((l.clone(), p.clone()));
            }
        }
        let rows = self.summaries().await?;
        let transfer = self.transfer_info().await?;
        let categories = self.categories();
        let tags: Vec<String> = self.tags().into_iter().collect();
        let torrents: BTreeMap<String, TorrentSummary> =
            rows.into_iter().map(|t| (t.hash.clone(), t)).collect();
        let mut prints = Prints {
            rev: 0,
            torrents: torrents
                .iter()
                .map(|(h, t)| (h.clone(), fingerprint(t)))
                .collect(),
            categories: categories
                .iter()
                .map(|(n, c)| (n.clone(), fingerprint(c)))
                .collect(),
            tags: fingerprint(&tags),
        };
        let latest = Arc::new(Latest {
            built: Instant::now(),
            torrents,
            categories: categories.into_iter().collect(),
            tags,
            transfer,
        });
        let mut s = self
            .sync
            .lock()
            .map_err(|_| crate::error::ApiError::internal("sync state poisoned"))?;
        s.next_rev += 1;
        prints.rev = s.next_rev;
        let prints = Arc::new(prints);
        s.kept.push_back(prints.clone());
        while s.kept.len() > KEEP {
            s.kept.pop_front();
        }
        s.latest = Some(latest.clone());
        Ok((latest, prints))
    }
}

/// Whether a diff carries anything the client does not have.
fn has_changes(r: &SyncResponse, last_transfer: Option<&TransferInfo>) -> bool {
    r.full
        || !r.torrents.is_empty()
        || !r.torrents_removed.is_empty()
        || !r.categories.is_empty()
        || !r.categories_removed.is_empty()
        || r.tags.is_some()
        || last_transfer != Some(&r.transfer)
}

struct StreamState {
    daemon: Arc<Daemon>,
    /// The revision the client holds.
    rev: Option<u64>,
    /// The transfer state last sent.
    last_transfer: Option<TransferInfo>,
    interval: Interval,
    shutdown: watch::Receiver<bool>,
}

/// Server-sent events: a `sync` event (id = the revision, data = a
/// [`SyncResponse`]) at once, then whenever something changed, checked every
/// [`PUSH_INTERVAL`]. Nothing is queued: each event is computed when the
/// connection can take it, so a slow client gets the latest diff, not a
/// backlog. The stream ends when the daemon shuts down.
pub(crate) fn event_stream(
    daemon: Arc<Daemon>,
    rev: Option<u64>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let mut interval = tokio::time::interval(PUSH_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let shutdown = daemon.shutdown_watch();
    let state = StreamState {
        daemon,
        rev,
        last_transfer: None,
        interval,
        shutdown,
    };
    futures_util::stream::unfold(state, |mut s| async move {
        loop {
            // The first tick of a tokio interval completes at once.
            tokio::select! {
                _ = s.interval.tick() => {}
                _ = s.shutdown.wait_for(|stop| *stop) => return None,
            }
            if s.daemon.is_closed() {
                return None;
            }
            let Ok(resp) = s.daemon.sync(s.rev).await else {
                continue;
            };
            let changed = has_changes(&resp, s.last_transfer.as_ref());
            s.rev = Some(resp.rev);
            if !changed {
                continue;
            }
            s.last_transfer = Some(resp.transfer.clone());
            let event = Event::default()
                .event("sync")
                .id(resp.rev.to_string())
                .json_data(&resp)
                .unwrap_or_else(|e| Event::default().comment(format!("encoding failed: {e}")));
            return Some((Ok(event), s));
        }
    })
}
