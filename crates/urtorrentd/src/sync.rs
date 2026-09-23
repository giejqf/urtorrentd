// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Incremental sync for polling clients (AGENTS.md 4.6). The daemon builds a
//! snapshot at most every [`MIN_INTERVAL`], however many clients poll, and
//! keeps the fingerprints of the last [`KEEP`] snapshots. A client passes the
//! `rev` it holds; if that snapshot is still kept it gets only what changed,
//! otherwise everything. No per-client state is kept.

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::Serialize;

use crate::daemon::Daemon;
use crate::error::ApiResult;
use crate::model::{SyncResponse, TorrentSummary, TransferInfo};
use crate::store::Category;

/// Snapshots are rebuilt at most this often.
pub const MIN_INTERVAL: Duration = Duration::from_millis(500);
/// Snapshots whose fingerprints are kept for diffs.
pub const KEEP: usize = 16;

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
