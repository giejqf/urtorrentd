// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The incomplete-file suffix (qBittorrent's `.!qB`): a file that is not
//! complete carries it, a complete one does not. Names change only through
//! `Session::rename_file` (the library renames on disk, also under live
//! writes, and keeps the names in its resume data); the daemon never touches
//! the files itself (AGENTS.md rule 5).
//!
//! When names are brought in line: before a held torrent is released (no file
//! exists yet), after every check (a check finds complete files without a
//! `FileCompleted` event, and a recheck can find a file incomplete again),
//! when a magnet's metadata arrives, when a file completes, and for every
//! torrent when the setting changes.

use std::sync::Arc;

use urtorrent::{InfoHash, TorrentId};

use super::Daemon;
use crate::error::ApiResult;

/// The name a file should have: `old` removed if present, `new` appended if
/// the file is not complete.
pub(crate) fn wanted_name(
    path: &str,
    complete: bool,
    old: Option<&str>,
    new: Option<&str>,
) -> String {
    let base = old.and_then(|o| path.strip_suffix(o)).unwrap_or(path);
    match new {
        Some(n) if !complete => format!("{base}{n}"),
        _ => base.to_string(),
    }
}

impl Daemon {
    /// The suffix in force.
    pub(crate) fn incomplete_suffix(&self) -> Option<String> {
        self.state().settings.incomplete_file_suffix.clone()
    }

    fn is_moving(&self, hash: &InfoHash) -> bool {
        self.state().torrents.get(hash).is_some_and(|e| e.moving)
    }

    /// Rename a torrent's files so that `old` is gone and incomplete files
    /// carry `new`. Returns how many files were renamed.
    pub(crate) async fn reconcile_suffix(
        &self,
        hash: InfoHash,
        id: TorrentId,
        old: Option<&str>,
        new: Option<&str>,
    ) -> ApiResult<usize> {
        if self.is_moving(&hash) {
            return Ok(0);
        }
        let files = self.session.files(id).await?;
        let mut renamed = 0;
        for (index, f) in files.iter().enumerate() {
            let want = wanted_name(&f.path, f.done >= f.size, old, new);
            if want != f.path {
                self.session.rename_file(id, index, want).await?;
                renamed += 1;
            }
        }
        if renamed > 0 {
            self.invalidate_content(hash);
        }
        Ok(renamed)
    }

    /// [`Daemon::reconcile_suffix`] with the suffix in force, logging a
    /// failure instead of returning it (event-driven callers).
    pub(crate) async fn apply_suffix(&self, hash: InfoHash, id: TorrentId) {
        let Some(sfx) = self.incomplete_suffix() else {
            return;
        };
        if let Err(e) = self
            .reconcile_suffix(hash, id, Some(&sfx), Some(&sfx))
            .await
        {
            self.logs.warn(format!(
                "{}: incomplete-file suffix: {e}",
                self.name_of(&hash)
            ));
        }
    }

    /// A file completed: drop the suffix from its name.
    pub(crate) async fn file_completed(&self, hash: InfoHash, id: TorrentId, index: usize) {
        let Some(sfx) = self.incomplete_suffix() else {
            return;
        };
        if self.is_moving(&hash) {
            return;
        }
        let Ok(files) = self.session.files(id).await else {
            return;
        };
        let Some(base) = files
            .get(index)
            .and_then(|f| f.path.strip_suffix(sfx.as_str()))
        else {
            return;
        };
        match self.session.rename_file(id, index, base.to_string()).await {
            Ok(()) => self.invalidate_content(hash),
            Err(e) => self.logs.warn(format!(
                "{}: removing the incomplete-file suffix: {e}",
                self.name_of(&hash)
            )),
        }
    }

    /// The setting changed from `old` to `new`: rename the files of every
    /// torrent, in the background.
    pub(crate) fn spawn_suffix_change(self: &Arc<Self>, old: Option<String>, new: Option<String>) {
        let d = self.clone();
        tokio::spawn(async move {
            let torrents: Vec<(InfoHash, TorrentId)> =
                d.state().torrents.iter().map(|(h, e)| (*h, e.id)).collect();
            let mut renamed = 0usize;
            for (h, id) in torrents {
                match d
                    .reconcile_suffix(h, id, old.as_deref(), new.as_deref())
                    .await
                {
                    Ok(n) => renamed += n,
                    Err(e) => d
                        .logs
                        .warn(format!("{}: incomplete-file suffix: {e}", d.name_of(&h))),
                }
            }
            d.logs.info(format!(
                "incomplete-file suffix {}: {renamed} files renamed",
                match &new {
                    Some(s) => format!("set to {s:?}"),
                    None => "turned off".to_string(),
                }
            ));
        });
    }
}

#[cfg(test)]
mod tests {
    use super::wanted_name;

    #[test]
    fn names() {
        let s = Some(".!qB");
        assert_eq!(wanted_name("a/b.mkv", false, s, s), "a/b.mkv.!qB");
        assert_eq!(wanted_name("a/b.mkv.!qB", false, s, s), "a/b.mkv.!qB");
        assert_eq!(wanted_name("a/b.mkv.!qB", true, s, s), "a/b.mkv");
        assert_eq!(wanted_name("a/b.mkv", true, s, s), "a/b.mkv");
        // Turned off, or changed.
        assert_eq!(wanted_name("a/b.mkv.!qB", false, s, None), "a/b.mkv");
        assert_eq!(
            wanted_name("a/b.mkv.!qB", false, s, Some(".part")),
            "a/b.mkv.part"
        );
        assert_eq!(wanted_name("a/b.mkv", false, None, s), "a/b.mkv.!qB");
    }
}
