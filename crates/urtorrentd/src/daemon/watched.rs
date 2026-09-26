// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Watch folders (qBittorrent's watched folders, `scan_dirs`): `.torrent`
//! files, and `.magnet` files holding a magnet link, dropped in a folder are
//! added with the folder's options. A file is taken once it has not changed
//! for [`SETTLE`] (a download may still be writing it). Once handled it is
//! renamed to `<name>.added` (or deleted, if the folder says so), or to
//! `<name>.rejected` when it cannot be added, so it is never taken twice.
//! These files are the daemon's input, not torrent content (AGENTS.md rule
//! 5 is about the engine's files).

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use super::Daemon;
use super::add::{MAX_TORRENT_FILE, Parsed, parse_magnet, parse_metainfo};
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::log::LogTopic;
use crate::model::{WatchFolderStatus, WatchOutcome, WatchPickup, WatchStatus};
use crate::settings::{AfterAdd, WatchFolder};
use crate::util::{blocking, hex, now};

/// A file is taken once it has not changed for this long.
const SETTLE: Duration = Duration::from_secs(3);
/// Subfolder levels looked into.
const MAX_DEPTH: usize = 8;
/// Files taken per scan at most (the rest wait for the next).
const PER_SCAN: usize = 64;
/// A `.magnet` file larger than this is not a magnet link.
const MAX_MAGNET_FILE: u64 = 64 * 1024;
/// Pickups remembered (`GET /watch-folders`).
const KEEP_PICKUPS: usize = 100;

/// A file as it was when handled: path, size, modification time.
type FileKey = (PathBuf, u64, Option<SystemTime>);

/// What the scans remember.
#[derive(Debug, Default)]
pub(crate) struct WatchState {
    /// Files handled whose rename or deletion failed: not taken again until
    /// they change.
    stuck: HashSet<FileKey>,
    /// The last error reading each folder.
    errors: HashMap<String, String>,
    /// When each folder was last read, unix seconds.
    scanned: HashMap<String, u64>,
    /// What the folders' files became, oldest first.
    recent: VecDeque<WatchPickup>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Torrent,
    Magnet,
}

fn kind_of(p: &Path) -> Option<Kind> {
    let ext = p.extension()?.to_str()?.to_ascii_lowercase();
    match ext.as_str() {
        "torrent" => Some(Kind::Torrent),
        "magnet" => Some(Kind::Magnet),
        _ => None,
    }
}

/// A file ready to take.
struct Found {
    folder: usize,
    key: FileKey,
    kind: Kind,
    /// `None`: larger than a file of its kind can be.
    bytes: Option<Vec<u8>>,
}

/// What one pass over the folders found (blocking).
struct Scan {
    found: Vec<Found>,
    /// Every candidate file seen, settled or not.
    seen: HashSet<FileKey>,
    /// Folders that could not be read: (path, error).
    errors: Vec<(String, String)>,
}

fn scan(folders: &[WatchFolder], stuck: &HashSet<FileKey>, now: SystemTime) -> Scan {
    let mut s = Scan {
        found: Vec::new(),
        seen: HashSet::new(),
        errors: Vec::new(),
    };
    for (i, f) in folders.iter().enumerate() {
        let mut dirs = vec![(PathBuf::from(&f.path), 0usize)];
        while let Some((dir, depth)) = dirs.pop() {
            let entries = match std::fs::read_dir(&dir) {
                Ok(e) => e,
                Err(e) => {
                    if depth == 0 {
                        s.errors.push((f.path.clone(), e.to_string()));
                    }
                    continue;
                }
            };
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy().starts_with('.') {
                    continue;
                }
                // The entry's own type: a symbolic link to a folder is not
                // followed.
                let Ok(ft) = entry.file_type() else {
                    continue;
                };
                let path = entry.path();
                if ft.is_dir() {
                    if f.recursive && depth + 1 < MAX_DEPTH {
                        dirs.push((path, depth + 1));
                    }
                    continue;
                }
                let Some(kind) = kind_of(&path) else {
                    continue;
                };
                let Ok(meta) = std::fs::metadata(&path) else {
                    continue;
                };
                if !meta.is_file() {
                    continue;
                }
                let key = (path, meta.len(), meta.modified().ok());
                s.seen.insert(key.clone());
                let settled = key
                    .2
                    .and_then(|m| now.duration_since(m).ok())
                    .is_some_and(|age| age >= SETTLE);
                if !settled || stuck.contains(&key) || s.found.len() >= PER_SCAN {
                    continue;
                }
                let limit = match kind {
                    Kind::Torrent => MAX_TORRENT_FILE as u64,
                    Kind::Magnet => MAX_MAGNET_FILE,
                };
                let bytes = if meta.len() > limit {
                    None
                } else {
                    match std::fs::read(&key.0) {
                        Ok(b) => Some(b),
                        Err(_) => continue,
                    }
                };
                s.found.push(Found {
                    folder: i,
                    key,
                    kind,
                    bytes,
                });
            }
        }
    }
    s
}

fn parse(kind: Kind, bytes: Option<Vec<u8>>) -> ApiResult<Parsed> {
    let bytes = bytes.ok_or_else(|| ApiError::bad_request("the file is too large"))?;
    match kind {
        Kind::Torrent => parse_metainfo(bytes, None),
        Kind::Magnet => {
            let text = String::from_utf8_lossy(&bytes);
            let link = text
                .lines()
                .map(|l| l.trim().trim_start_matches('\u{feff}'))
                .find(|l| l.to_ascii_lowercase().starts_with("magnet:"))
                .ok_or_else(|| ApiError::bad_request("no magnet link in the file"))?;
            parse_magnet(link.to_string(), None)
        }
    }
}

/// `path` with `suffix` appended to its file name.
fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.file_name().unwrap_or_default().to_os_string();
    name.push(suffix);
    path.with_file_name(name)
}

impl Daemon {
    /// Take what the watch folders hold (the tick).
    pub(crate) async fn scan_watch_folders(self: &Arc<Self>) {
        let folders = self.settings().watch_folders;
        if folders.is_empty() {
            return;
        }
        let stuck = self.watch_state().stuck.clone();
        let list = folders.clone();
        let Ok(found) = blocking(move || Ok(scan(&list, &stuck, SystemTime::now()))).await else {
            return;
        };
        let read_at = now();
        {
            let mut st = self.watch_state();
            for f in &folders {
                if !found.errors.iter().any(|(p, _)| p == &f.path) {
                    st.scanned.insert(f.path.clone(), read_at);
                }
            }
            st.scanned
                .retain(|p, _| folders.iter().any(|f| &f.path == p));
        }
        self.watch_folder_errors(&folders, found.errors);
        for f in found.found {
            let folder = &folders[f.folder];
            let path = f.key.0.clone();
            let shown = path.display().to_string();
            let parsed = parse(f.kind, f.bytes);
            let hash = parsed.as_ref().ok().map(|p| hex(&p.hash));
            let result = match parsed {
                Ok(p) => self.add_one(p, &folder.options).await,
                Err(e) => Err(e),
            };
            let mut pickup = WatchPickup {
                time: now(),
                folder: folder.path.clone(),
                file: shown.clone(),
                outcome: WatchOutcome::Added,
                hash,
                name: None,
                error: None,
            };
            let target = match &result {
                Ok(added) => {
                    self.logs.info_on(
                        LogTopic::WatchFolders,
                        added.hash.as_str(),
                        format!("added {} from the watch folder ({shown})", added.name),
                    );
                    pickup.name = Some(added.name.clone());
                    (folder.after_add == AfterAdd::Rename).then(|| with_suffix(&path, ".added"))
                }
                Err(e) if e.code == ErrorCode::Duplicate => {
                    self.logs
                        .info(LogTopic::WatchFolders, format!("{shown}: {}", e.message));
                    pickup.outcome = WatchOutcome::Duplicate;
                    (folder.after_add == AfterAdd::Rename).then(|| with_suffix(&path, ".added"))
                }
                Err(e) => {
                    self.logs.warn(
                        LogTopic::WatchFolders,
                        format!("{shown} could not be added: {}", e.message),
                    );
                    pickup.outcome = WatchOutcome::Rejected;
                    pickup.error = Some(e.message.clone());
                    Some(with_suffix(&path, ".rejected"))
                }
            };
            let from = path.clone();
            let done = blocking(move || match target {
                Some(to) => std::fs::rename(&from, to),
                None => std::fs::remove_file(&from),
            })
            .await;
            let mut st = self.watch_state();
            if let Err(e) = done {
                self.logs.warn(
                    LogTopic::WatchFolders,
                    format!("{shown}: {e}; it is not taken again until it changes"),
                );
                pickup.error = Some(match pickup.error.take() {
                    Some(why) => format!("{why}; then {e}"),
                    None => format!("{e}; not taken again until it changes"),
                });
                st.stuck.insert(f.key);
            }
            st.recent.push_back(pickup);
            while st.recent.len() > KEEP_PICKUPS {
                st.recent.pop_front();
            }
        }
        // Forget stuck files that are gone or changed.
        self.watch_state().stuck.retain(|k| found.seen.contains(k));
    }

    /// Each watch folder's standing, and what their files became
    /// (`GET /watch-folders`).
    pub(crate) fn watch_status(&self) -> WatchStatus {
        let folders = self.settings().watch_folders;
        let st = self.watch_state();
        WatchStatus {
            folders: folders
                .iter()
                .map(|f| WatchFolderStatus {
                    path: f.path.clone(),
                    scanned: st.scanned.get(&f.path).copied(),
                    error: st.errors.get(&f.path).cloned(),
                })
                .collect(),
            recent: st.recent.iter().rev().cloned().collect(),
        }
    }

    fn watch_state(&self) -> std::sync::MutexGuard<'_, WatchState> {
        self.watch.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Log a folder's read error once, and when it is readable again.
    fn watch_folder_errors(&self, folders: &[WatchFolder], errors: Vec<(String, String)>) {
        let mut st = self.watch_state();
        let now: HashMap<String, String> = errors.into_iter().collect();
        for (path, e) in &now {
            if st.errors.get(path) != Some(e) {
                self.logs
                    .warn(LogTopic::WatchFolders, format!("watch folder {path}: {e}"));
            }
        }
        for path in st.errors.keys() {
            if !now.contains_key(path) && folders.iter().any(|f| &f.path == path) {
                self.logs.info(
                    LogTopic::WatchFolders,
                    format!("watch folder {path} is readable again"),
                );
            }
        }
        st.errors = now;
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn files_are_taken_when_settled_and_links_are_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("sub/deeper")).unwrap();
        for p in [
            "a.torrent",
            "b.MAGNET",
            "c.txt",
            ".hidden.torrent",
            "sub/d.torrent",
            "sub/deeper/e.torrent",
        ] {
            std::fs::write(root.join(p), b"x").unwrap();
        }
        std::os::unix::fs::symlink(root.join("sub"), root.join("link")).unwrap();
        let folder = |recursive| WatchFolder {
            path: root.to_string_lossy().into_owned(),
            recursive,
            options: Default::default(),
            after_add: AfterAdd::Rename,
        };
        let names = |s: &Scan| {
            let mut n: Vec<String> = s
                .found
                .iter()
                .map(|f| {
                    f.key
                        .0
                        .strip_prefix(root)
                        .unwrap()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect();
            n.sort();
            n
        };
        let later = SystemTime::now() + Duration::from_secs(10);
        assert_eq!(
            names(&scan(&[folder(false)], &HashSet::new(), later)),
            ["a.torrent", "b.MAGNET"]
        );
        assert_eq!(
            names(&scan(&[folder(true)], &HashSet::new(), later)),
            [
                "a.torrent",
                "b.MAGNET",
                "sub/d.torrent",
                "sub/deeper/e.torrent"
            ]
        );
        // Not settled yet.
        let s = scan(&[folder(false)], &HashSet::new(), SystemTime::now());
        assert!(s.found.is_empty());
        assert_eq!(s.seen.len(), 2);
        // A missing folder is an error, not a panic.
        let gone = WatchFolder {
            path: root.join("nope").to_string_lossy().into_owned(),
            ..folder(false)
        };
        assert_eq!(scan(&[gone], &HashSet::new(), later).errors.len(), 1);
    }

    #[test]
    fn magnet_files_hold_a_link() {
        let link = "magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567";
        let p = parse(
            Kind::Magnet,
            Some(format!("\u{feff}# saved\n  {link}\n").into_bytes()),
        )
        .unwrap();
        assert_eq!(p.name, "0123456789abcdef0123456789abcdef01234567");
        assert!(parse(Kind::Magnet, Some(b"nothing".to_vec())).is_err());
        assert!(parse(Kind::Torrent, None).is_err());
        assert_eq!(
            with_suffix(Path::new("/w/x.torrent"), ".added"),
            PathBuf::from("/w/x.torrent.added")
        );
    }
}
