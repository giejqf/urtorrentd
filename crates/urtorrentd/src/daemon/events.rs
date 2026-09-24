// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The single consumer of `Session::events()` (AGENTS.md 4.4): keeps caches
//! fresh, feeds the main and peer logs, stores magnets' metadata, saves
//! resume data at the moments that matter, and runs the event-driven
//! policies (held magnets, download-path moves).

use std::sync::{Arc, Weak};

use urtorrent::{ErrorKind, Event, EventStream, InfoHash, TorrentId};

use super::{Daemon, ResumeSave};
use crate::log::LogLevel;
use crate::model::TimelineKind;
use crate::stats::peers::PeerSample;
use crate::util::{blocking, hex, now};

pub(crate) async fn run(daemon: Weak<Daemon>, mut events: EventStream) {
    while let Some(ev) = events.recv().await {
        let Some(d) = daemon.upgrade() else {
            return;
        };
        if d.is_closed() {
            return;
        }
        d.on_event(ev).await;
    }
}

fn kind_text(kind: ErrorKind) -> &'static str {
    match kind {
        ErrorKind::ContentMissing => {
            "its files are missing; start it once they are back, or recheck"
        }
        ErrorKind::Io => "a disk error; start or recheck it to retry",
        ErrorKind::Metadata => "its metadata is unusable; remove it",
        _ => "an error",
    }
}

impl Daemon {
    fn hash_of(&self, id: TorrentId) -> Option<InfoHash> {
        self.state().by_id.get(&id).copied()
    }

    async fn on_event(self: &Arc<Self>, ev: Event) {
        match ev {
            Event::MetadataReceived { id } => self.on_metadata(id).await,
            Event::Checked { id, .. } => {
                if let Some(h) = self.hash_of(id) {
                    // Complete files lose the incomplete-file suffix (a check
                    // sends no `FileCompleted`), incomplete ones gain it.
                    self.apply_suffix(h, id).await;
                    // A fresh check result is worth keeping at once: a
                    // restart then skips the check.
                    self.save_resume(ResumeSave::One(h)).await;
                }
            }
            Event::FileCompleted { id, index, .. } => {
                if let Some(h) = self.hash_of(id) {
                    self.file_completed(h, id, index).await;
                }
            }
            Event::TorrentFinished { id } => self.on_finished(id).await,
            Event::TorrentError {
                id, error, kind, ..
            } => {
                if let Some(h) = self.hash_of(id) {
                    self.stats_event(h, TimelineKind::Error, Some(error.clone()));
                    self.logs.log(
                        LogLevel::Error,
                        format!(
                            "torrent {} stopped: {error} ({})",
                            self.name_of(&h),
                            kind_text(kind)
                        ),
                    );
                }
            }
            Event::PeerBanned { id, ip, reason, .. } => {
                let name = self.hash_of(id).map(|h| self.name_of(&h));
                self.logs.peer(
                    ip,
                    true,
                    match name {
                        Some(n) => format!("{reason} ({n})"),
                        None => reason,
                    },
                );
            }
            Event::PeerDisconnected { id, info, .. } => {
                if let (Some(h), Ok(stats)) = (self.hash_of(id), &self.stats) {
                    stats.peer_closed(now(), h, &PeerSample::of(&info), &|ip| self.geo.lookup(ip));
                }
            }
            Event::TrackerReply { url, .. } => {
                if let Ok(stats) = &self.stats {
                    stats.announce(now(), &url, true);
                }
            }
            Event::TrackerError { url, .. } => {
                if let Ok(stats) = &self.stats {
                    stats.announce(now(), &url, false);
                }
            }
            Event::ScrapeReply {
                id,
                complete,
                incomplete,
                downloaded,
                ..
            } => {
                if let (Some(h), Ok(stats)) = (self.hash_of(id), &self.stats) {
                    stats.scraped(h, complete, incomplete, downloaded);
                }
            }
            Event::PeerConnected { incoming: true, .. } => {
                self.state().incoming_seen = true;
            }
            Event::ExternalAddress { ip } => {
                self.logs.info(format!("external address detected: {ip}"));
            }
            Event::Lagged { dropped } => {
                self.logs.warn(format!(
                    "{dropped} engine events were dropped; refreshing all caches"
                ));
                let mut st = self.state();
                for e in st.torrents.values_mut() {
                    e.tracker_urls = None;
                    e.content = None;
                }
            }
            _ => {}
        }
    }

    /// A magnet's metadata arrived: keep the `.torrent`, then apply what
    /// waited for it.
    async fn on_metadata(self: &Arc<Self>, id: TorrentId) {
        let Some(hash) = self.hash_of(id) else {
            return;
        };
        self.stats_event(hash, TimelineKind::Metadata, None);
        match self.session.torrent_file(id).await {
            Ok(Some(bytes)) => {
                let store = self.store.clone();
                let h = hex(&hash);
                if let Err(e) = blocking(move || store.save_metainfo(&h, &bytes)).await {
                    self.logs
                        .warn(format!("saving metadata of {}: {e}", hex(&hash)));
                }
                let _ = self.update_record(hash, |r| r.magnet = None).await;
            }
            Ok(None) => {}
            Err(e) => self
                .logs
                .warn(format!("reading metadata of {}: {e}", hex(&hash))),
        }
        {
            let mut st = self.state();
            if let Some(e) = st.torrents.get_mut(&hash) {
                e.content = None;
                e.tracker_urls = None;
            }
        }
        let status = self.session.status(id).await;
        // Trackers from the settings only once we know the torrent is public
        // (AGENTS.md rule 2).
        if let Ok(s) = &status
            && !s.private
        {
            let urls = self.settings().add_trackers;
            self.add_auto_trackers(id, &urls).await;
        }
        self.logs
            .info(format!("received metadata for {}", self.name_of(&hash)));
        match status {
            Ok(s) if s.state == urtorrent::TorrentState::Held => {
                self.finish_hold(hash, id).await;
            }
            _ => {
                self.apply_suffix(hash, id).await;
                let first_last = self
                    .state()
                    .torrents
                    .get(&hash)
                    .is_some_and(|e| e.record.first_last_piece_priority);
                if first_last && let Err(e) = self.apply_first_last(id, true).await {
                    self.logs.warn(format!(
                        "{}: first and last pieces: {e}",
                        self.name_of(&hash)
                    ));
                }
            }
        }
    }

    async fn on_finished(self: &Arc<Self>, id: TorrentId) {
        let Some(hash) = self.hash_of(id) else {
            return;
        };
        self.logs
            .info(format!("finished downloading {}", self.name_of(&hash)));
        self.stats_event(hash, TimelineKind::Finished, None);
        self.save_resume(ResumeSave::One(hash)).await;
        let target = {
            let st = self.state();
            st.torrents
                .get(&hash)
                .filter(|e| e.record.download_path.is_some())
                .map(|e| (e.record.save_path.clone(), e.record.auto_management))
        };
        if let Some((save_path, managed)) = target {
            self.spawn_move(hash, id, save_path, managed);
        }
    }
}
