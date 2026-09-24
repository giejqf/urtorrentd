// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! File search across torrents (`GET /torrents/files`): an in-memory index
//! of every torrent's file paths, as the engine names them (renames
//! included). It is filled in the background after the start and, for
//! anything missing, before a search; a torrent's entry is dropped whenever
//! its paths may change (renames, content layouts, the incomplete-file
//! suffix, metadata arriving) and when it is removed, so a search never
//! sees stale paths. A search asks the engine only for the files of the
//! page it returns (progress, priority), never for every torrent's
//! (AGENTS.md 4.4).

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::sync::{Arc, Mutex, MutexGuard};

use tokio::task::JoinHandle;
use urtorrent::{InfoHash, TorrentId};

use super::Daemon;
use crate::error::{ApiError, ApiResult};
use crate::model::{FileMatch, FileSearch, FileSearchQuery};
use crate::util::{hex, parse_hash, search_words};

/// Largest page.
const MAX_PAGE: usize = 1000;

/// A torrent's file paths, in file order.
type Files = Arc<[Box<str>]>;

/// Every indexed torrent's files.
#[derive(Debug, Default)]
struct Index {
    torrents: HashMap<InfoHash, Files>,
    /// A clock that ticks on every invalidation, the tick of each torrent's
    /// last one, and of the last full clear: a fill that read the engine
    /// before its torrent changed is not stored.
    clock: u64,
    changed: HashMap<InfoHash, u64>,
    cleared: u64,
}

/// The index, and the lock that lets one fill run at a time (a search
/// right after the start waits for the warm-up instead of repeating it).
#[derive(Debug, Default)]
pub(crate) struct FileIndex {
    index: Mutex<Index>,
    fill: tokio::sync::Mutex<()>,
}

fn to_files(files: Vec<urtorrent::FileStatus>) -> Files {
    files.into_iter().map(|f| f.path.into_boxed_str()).collect()
}

impl Daemon {
    fn file_index(&self) -> MutexGuard<'_, Index> {
        self.file_index
            .index
            .lock()
            .unwrap_or_else(|e| e.into_inner())
    }

    /// A torrent's paths may have changed: index it again when needed.
    pub(crate) fn invalidate_files(&self, hash: &InfoHash) {
        let mut idx = self.file_index();
        idx.clock += 1;
        let clock = idx.clock;
        idx.changed.insert(*hash, clock);
        idx.torrents.remove(hash);
    }

    /// A torrent was removed (from the registry first, so no fill stores it
    /// again).
    pub(crate) fn forget_files(&self, hash: &InfoHash) {
        let mut idx = self.file_index();
        idx.torrents.remove(hash);
        idx.changed.remove(hash);
    }

    /// Drop the whole index (engine events were lost).
    pub(crate) fn clear_file_index(&self) {
        let mut idx = self.file_index();
        idx.clock += 1;
        idx.cleared = idx.clock;
        idx.torrents.clear();
    }

    /// Index the torrents that are not (all of them after a start).
    pub(crate) async fn index_files(&self, only: Option<&InfoHash>) {
        let _fill = self.file_index.fill.lock().await;
        let missing: Vec<(InfoHash, TorrentId)> = {
            let st = self.state();
            let idx = self.file_index();
            st.torrents
                .iter()
                .filter(|(h, _)| only.is_none_or(|o| o == *h) && !idx.torrents.contains_key(*h))
                .map(|(h, e)| (*h, e.id))
                .collect()
        };
        for (hash, id) in missing {
            let read_at = self.file_index().clock;
            // A magnet without metadata has no files yet; its entry is
            // dropped when the metadata arrives.
            let Ok(files) = self.session.files(id).await else {
                continue;
            };
            let files = to_files(files);
            // Still the same torrent (the state lock orders this against a
            // removal), and it did not change since it was read.
            let st = self.state();
            if st.torrents.get(&hash).is_some_and(|e| e.id == id) {
                let mut idx = self.file_index();
                let since = idx
                    .changed
                    .get(&hash)
                    .copied()
                    .unwrap_or(0)
                    .max(idx.cleared);
                if since <= read_at {
                    idx.torrents.insert(hash, files);
                }
            }
        }
    }

    /// Fill the index in the background (after the start).
    pub(crate) fn spawn_file_index(self: &Arc<Self>) -> JoinHandle<()> {
        let d = Arc::downgrade(self);
        tokio::spawn(async move {
            if let Some(d) = d.upgrade() {
                d.index_files(None).await;
            }
        })
    }

    /// Files across torrents whose paths match the search.
    pub(crate) async fn search_files(&self, q: FileSearchQuery) -> ApiResult<FileSearch> {
        let words =
            search_words(q.search.as_deref().unwrap_or("")).map_err(ApiError::bad_request)?;
        let limit = q.limit.unwrap_or(100);
        if !(1..=MAX_PAGE).contains(&limit) {
            return Err(ApiError::bad_request(format!(
                "`limit` must be 1 to {MAX_PAGE}"
            )));
        }
        let only = match &q.hash {
            Some(h) => {
                let hash = parse_hash(h)
                    .ok_or_else(|| ApiError::bad_request(format!("{h:?} is not an info-hash")))?;
                if !self.state().torrents.contains_key(&hash) {
                    return Err(ApiError::torrent_not_found(h));
                }
                Some(hash)
            }
            None => None,
        };
        self.index_files(only.as_ref()).await;
        let mut torrents: Vec<(Option<String>, InfoHash, TorrentId)> = {
            let st = self.state();
            st.torrents
                .iter()
                .filter(|(h, _)| only.is_none_or(|o| o == **h))
                .map(|(h, e)| (e.record.name.clone().or_else(|| e.name.clone()), *h, e.id))
                .collect()
        };
        // Names the tick has not seen yet (just added, just started).
        if torrents.iter().any(|t| t.0.is_none()) {
            let names: HashMap<InfoHash, String> = self
                .session
                .statuses()
                .await
                .unwrap_or_default()
                .into_iter()
                .map(|s| (s.info_hash, s.name))
                .collect();
            for t in torrents.iter_mut().filter(|t| t.0.is_none()) {
                t.0 = names.get(&t.1).cloned();
            }
        }
        // Torrents by name, then info-hash; files in their order.
        let mut torrents: Vec<(String, InfoHash, TorrentId)> = torrents
            .into_iter()
            .map(|(name, h, id)| (name.unwrap_or_else(|| hex(&h)), h, id))
            .collect();
        torrents.sort_by(|a, b| {
            a.0.to_lowercase()
                .cmp(&b.0.to_lowercase())
                .then(a.1.cmp(&b.1))
        });
        // The files searched: the index's, and fresh from the engine for a
        // torrent that changed since the fill (never skipped).
        let mut files: Vec<Option<Files>> = {
            let idx = self.file_index();
            torrents
                .iter()
                .map(|(_, h, _)| idx.torrents.get(h).cloned())
                .collect()
        };
        for (slot, (_, _, id)) in files.iter_mut().zip(&torrents) {
            if slot.is_none() {
                *slot = self.session.files(*id).await.ok().map(to_files);
            }
        }
        // Count every match; keep the page's.
        let offset = q.offset.unwrap_or(0);
        let mut total = 0usize;
        let mut page: Vec<(usize, usize)> = Vec::new();
        for (t, list) in files.iter().enumerate() {
            for (i, path) in list.iter().flat_map(|l| l.iter().enumerate()) {
                if words.iter().all(|w| w.is_match(path)) {
                    if total >= offset && page.len() < limit {
                        page.push((t, i));
                    }
                    total += 1;
                }
            }
        }
        // Progress and priority, fresh, for the torrents of this page only
        // (a torrent removed meanwhile drops out of the page).
        let mut fresh: HashMap<usize, Vec<urtorrent::FileStatus>> = HashMap::new();
        let mut out = Vec::with_capacity(page.len());
        for (t, i) in page {
            let (name, hash, id) = &torrents[t];
            if let Entry::Vacant(slot) = fresh.entry(t) {
                slot.insert(self.session.files(*id).await.unwrap_or_default());
            }
            let Some(f) = fresh.get(&t).and_then(|l| l.get(i)) else {
                continue;
            };
            out.push(FileMatch {
                hash: hex(hash),
                torrent: name.clone(),
                index: i,
                path: f.path.clone(),
                size: f.size,
                progress: if f.size == 0 {
                    1.0
                } else {
                    f.done as f64 / f.size as f64
                },
                priority: f.priority,
            });
        }
        Ok(FileSearch { total, files: out })
    }
}
