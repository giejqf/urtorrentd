// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The single consumer of `Session::events()` (AGENTS.md 4.4): keeps caches
//! fresh, feeds the main log, persists magnets' metadata and runs the
//! event-driven policies (stop conditions, download-path moves).

use std::sync::{Arc, Weak};

use urtorrent::{Event, EventStream, InfoHash, TorrentId};

use super::Daemon;
use crate::store::StopCondition;
use crate::util::{blocking, hex};

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

impl Daemon {
    fn hash_of(&self, id: TorrentId) -> Option<InfoHash> {
        self.state().by_id.get(&id).copied()
    }

    async fn on_event(self: &Arc<Self>, ev: Event) {
        match ev {
            Event::MetadataReceived { id } => self.on_metadata(id).await,
            Event::Checked { id, .. } => {
                self.fire_stop_condition(id, StopCondition::FilesChecked)
                    .await
            }
            Event::TorrentFinished { id } => self.on_finished(id).await,
            Event::TorrentError { id, error } => {
                if let Some(h) = self.hash_of(id) {
                    self.logs.log(
                        crate::log::LogLevel::Error,
                        format!(
                            "torrent {} stopped with an error: {error}",
                            self.name_of(&h)
                        ),
                    );
                }
            }
            Event::TrackerReply { id, .. }
            | Event::TrackerError { id, .. }
            | Event::ScrapeReply { id, .. } => {
                if let Some(h) = self.hash_of(id) {
                    self.invalidate_trackers(h);
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
                    e.trackers = None;
                    e.content = None;
                    e.availability = None;
                }
            }
            _ => {}
        }
    }

    /// A magnet's metadata arrived: keep the `.torrent`, apply the policies
    /// that needed it.
    async fn on_metadata(self: &Arc<Self>, id: TorrentId) {
        let Some(hash) = self.hash_of(id) else {
            return;
        };
        match self.session.torrent_file(id).await {
            Ok(Some(bytes)) => {
                let store = self.store.clone();
                let h = hex(&hash);
                if let Err(e) = blocking(move || store.save_torrent_file(&h, &bytes)).await {
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
                e.trackers = None;
            }
        }
        // Trackers from the settings only once we know the torrent is public
        // (AGENTS.md rule 2).
        if let Ok(status) = self.session.status(id).await
            && !status.private
        {
            let urls = self.settings().add_trackers;
            self.add_auto_trackers(id, &urls).await;
        }
        self.logs
            .info(format!("received metadata for {}", self.name_of(&hash)));
        self.fire_stop_condition(id, StopCondition::MetadataReceived)
            .await;
    }

    async fn fire_stop_condition(&self, id: TorrentId, reached: StopCondition) {
        let Some(hash) = self.hash_of(id) else {
            return;
        };
        let pending = self
            .state()
            .torrents
            .get(&hash)
            .map(|e| e.record.stop_condition);
        if pending != Some(reached) {
            return;
        }
        match self.stop_torrent(hash, id).await {
            Ok(()) => self.logs.info(format!(
                "stopped {} ({})",
                self.name_of(&hash),
                match reached {
                    StopCondition::MetadataReceived => "metadata received",
                    _ => "files checked",
                }
            )),
            Err(e) => self
                .logs
                .warn(format!("stop condition on {}: {e}", hex(&hash))),
        }
    }

    async fn on_finished(self: &Arc<Self>, id: TorrentId) {
        let Some(hash) = self.hash_of(id) else {
            return;
        };
        self.logs
            .info(format!("finished downloading {}", self.name_of(&hash)));
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
