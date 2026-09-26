// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The daemon core: owns the urtorrent `Session`, the torrent registry
//! (info-hash ↔ `TorrentId` plus the daemon's own record per torrent), the
//! categories and tags, the policies, and persistence (AGENTS.md 4, ADR 0004).

mod add;
mod events;
mod filesearch;
mod net;
mod ops;
mod organize;
mod preview;
mod suffix;
mod tick;
pub(crate) mod view;
mod watched;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use tokio::sync::watch;
use tokio::task::JoinHandle;
use urtorrent::{AddTorrent, InfoHash, Session, TorrentId};

use crate::auth::{Auth, Credentials};
use crate::error::{ApiError, ApiResult};
use crate::geo::{self, GeoIp};
use crate::log::Logs;
use crate::model::{BulkFailure, BulkResult, Hashes, TimelineKind};
use crate::settings::{self, Settings, SettingsPatch};
use crate::stats::Stats;
use crate::store::{self, Categories, Store, Tags, TorrentRecord, Totals};
use crate::sync::SyncState;
use crate::util::{self, blocking, hex, now, parse_hash};
use crate::webhooks::{StoredWebhook, Webhooks};

pub(crate) use add::check_options as check_add_options;
pub use add::{content_renames, decode_base64, parse_metadata};
pub(crate) use ops::{MoveTo, parse_peer_ip};

/// A torrent's resume data is saved at most this often while it changes
/// (the engine's own cadence in file mode), and at once when it finishes, is
/// checked, or the daemon stops.
pub(crate) const RESUME_SAVE_EVERY: Duration = Duration::from_secs(60);

/// How the daemon is started.
#[derive(Debug, Clone)]
pub struct DaemonConfig {
    /// The data directory (created if missing).
    pub data_dir: PathBuf,
    /// Settings for the very first start (no settings stored yet); `None`
    /// uses the defaults with a random listen port.
    pub initial_settings: Option<Settings>,
}

/// Why the daemon could not start.
#[derive(Debug, thiserror::Error)]
pub enum StartError {
    /// The data directory or its database could not be read or written.
    #[error("data directory: {0}")]
    Io(#[from] std::io::Error),
    /// The stored settings are invalid.
    #[error("settings: {0}")]
    Settings(String),
    /// The engine did not start (io_uring unavailable, listen address in use, ...).
    #[error("engine: {0}")]
    Engine(#[from] urtorrent::Error),
    /// The HTTP client could not be built.
    #[error("http client: {0}")]
    Http(String),
}

/// Where the content sits relative to the save path, for list views.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct ContentLayoutInfo {
    /// The file (single-file torrents) or the top-level folder.
    pub content: String,
    /// The top-level folder, for multi-file torrents with one.
    pub root: Option<String>,
}

/// A torrent in the registry.
#[derive(Debug)]
pub(crate) struct Entry {
    pub id: TorrentId,
    pub record: TorrentRecord,
    /// The record changed since it was last written.
    pub dirty: bool,
    /// The torrent's own name as last seen (for log lines).
    pub name: Option<String>,
    /// Counters when first seen in this run (for the per-session figures).
    pub baseline: Option<(u64, u64)>,
    /// A storage move is running.
    pub moving: bool,
    /// Tracker URLs, for magnet links; `None` = refresh before use. Changes
    /// only when the list is edited or the metadata arrives.
    pub tracker_urls: Option<Vec<String>>,
    /// `None` = refresh before use.
    pub content: Option<ContentLayoutInfo>,
    /// When the resume data was last saved.
    pub resume_saved: Option<Instant>,
    /// What the stored resume data holds of the counters: as of the last
    /// save, or as first seen in this run when restored from that data.
    pub resume_mark: Option<ResumeMark>,
    /// Restored with stored resume data.
    pub resume_restored: bool,
    /// It has trackers (as of the last tick).
    pub has_trackers: bool,
    /// When it was last scraped for the statistics.
    pub last_scrape: Option<Instant>,
}

impl Entry {
    fn new(id: TorrentId, record: TorrentRecord) -> Entry {
        Entry {
            id,
            record,
            dirty: false,
            name: None,
            baseline: None,
            moving: false,
            tracker_urls: None,
            content: None,
            resume_saved: None,
            resume_mark: None,
            resume_restored: false,
            has_trackers: false,
            last_scrape: None,
        }
    }
}

/// Mutable daemon state (behind a plain mutex; never held across `.await`).
#[derive(Debug)]
pub(crate) struct State {
    pub settings: Settings,
    pub torrents: HashMap<InfoHash, Entry>,
    pub by_id: HashMap<TorrentId, InfoHash>,
    pub categories: Categories,
    pub tags: Tags,
    /// A peer has connected to us this run.
    pub incoming_seen: bool,
    /// All-time totals at the start of this run.
    pub base_totals: Totals,
    /// Metadata previews, by info-hash (not torrents of the session).
    pub previews: HashMap<InfoHash, preview::Preview>,
    /// Whether the alternative-limits window was open at the last look;
    /// `None` = not looked yet (the next look applies it).
    pub scheduled: Option<bool>,
}

/// Torrents found by a bulk selection, and the hashes not found.
pub(crate) type Selection = (Vec<(InfoHash, TorrentId)>, Vec<String>);

/// The running daemon.
pub struct Daemon {
    pub(crate) session: Session,
    pub(crate) store: Store,
    pub(crate) auth: Auth,
    pub(crate) logs: Logs,
    pub(crate) state: Mutex<State>,
    /// Serializes operations that change the registry or settings across awaits.
    pub(crate) ops: tokio::sync::Mutex<()>,
    /// Serializes record writes, so the newest record always lands last.
    pub(crate) persist_lock: tokio::sync::Mutex<()>,
    /// The settings the engine was built with (for restart-only fields).
    pub(crate) running: Settings,
    pub(crate) started_at: u64,
    pub(crate) temporary_password: Option<String>,
    pub(crate) http: reqwest::Client,
    pub(crate) sync: Mutex<SyncState>,
    /// The statistics recorder, or why `stats.db` could not be opened (the
    /// daemon runs without statistics then).
    pub(crate) stats: Result<Stats, String>,
    /// The GeoIP databases.
    pub(crate) geo: GeoIp,
    /// The webhooks.
    pub(crate) webhooks: Arc<Webhooks>,
    /// What the watch-folder scans remember.
    pub(crate) watch: Mutex<watched::WatchState>,
    /// RSS refreshes in flight.
    pub(crate) rss: Mutex<crate::rss::RssState>,
    /// The cookie jar, the fetched tracker list, the listen addresses.
    pub(crate) net: Mutex<net::NetState>,
    /// Serializes the RSS rules' read-modify-write (runs, saves, renames).
    pub(crate) rss_rules_lock: tokio::sync::Mutex<()>,
    /// The file paths the file search looks through.
    pub(crate) file_index: filesearch::FileIndex,
    shutdown_requested: watch::Sender<bool>,
    /// The shutdown asked for is a restart (`POST /app/restart`).
    restart: std::sync::atomic::AtomicBool,
    closed: watch::Sender<bool>,
    tasks: Mutex<Vec<JoinHandle<()>>>,
}

fn default_save_path(data_dir: &Path) -> String {
    match std::env::var_os("HOME") {
        Some(home) if !home.is_empty() => PathBuf::from(home).join("Downloads"),
        _ => data_dir.join("downloads"),
    }
    .to_string_lossy()
    .into_owned()
}

fn random_port() -> u16 {
    let r = util::random_bytes::<2>()
        .map(u16::from_le_bytes)
        .unwrap_or(0);
    20_000 + r % 45_000
}

/// The settings of a first start without `initial_settings`: the defaults
/// with a random listen port. `--initial-settings` patches these.
pub fn first_start_settings() -> Settings {
    Settings {
        listen_port: random_port(),
        ..Settings::default()
    }
}

impl Daemon {
    /// Open the data directory, start the engine, restore every torrent and
    /// start the background tasks.
    pub async fn start(cfg: DaemonConfig) -> Result<Arc<Daemon>, StartError> {
        let data_dir = cfg.data_dir.clone();
        let store = blocking(move || Store::open(data_dir)).await?;
        let loaded: Option<Settings> = {
            let s = store.clone();
            blocking(move || s.load(store::SETTINGS)).await?
        };
        let first_start = loaded.is_none();
        let mut settings = match (loaded, cfg.initial_settings) {
            (Some(s), _) => s,
            (None, Some(s)) => s,
            (None, None) => first_start_settings(),
        };
        if settings.save_path.is_empty() {
            settings.save_path = default_save_path(&cfg.data_dir);
        }
        if settings.random_port {
            settings.listen_port = random_port();
        }
        settings.validate().map_err(StartError::Settings)?;
        {
            let (s, v) = (store.clone(), settings.clone());
            blocking(move || s.save(store::SETTINGS, &v)).await?;
        }
        let (creds, categories, tags, totals, dht_state, hooks, cookies) = {
            let s = store.clone();
            blocking(move || {
                Ok((
                    s.load::<Credentials>(store::AUTH)?.unwrap_or_default(),
                    s.categories()?,
                    s.tags()?,
                    s.load::<Totals>(store::TOTALS)?.unwrap_or_default(),
                    s.load_dht()?,
                    s.load::<Vec<StoredWebhook>>(store::WEBHOOKS)?
                        .unwrap_or_default(),
                    s.load::<Vec<crate::model::Cookie>>(store::COOKIES)?
                        .unwrap_or_default(),
                ))
            })
            .await?
        };
        let webhooks = Webhooks::new(hooks).map_err(StartError::Http)?;
        let auth = Auth::new(creds);
        let temporary_password = auth.ensure_password()?;
        // Statistics are disposable: a database that cannot be opened turns
        // them off for this run, not the daemon.
        let stats = {
            let (dir, on) = (cfg.data_dir.clone(), settings.stats_enabled);
            blocking(move || Stats::open(&dir, on, now()))
                .await
                .map_err(|e| e.to_string())
        };

        let listening = crate::interfaces::listen_addresses(&settings);
        let session = settings.builder(dht_state).build().await?;
        settings::apply_bans(&session, &settings).await?;
        let events = session.events();
        let http = reqwest::Client::builder()
            .redirect(add::redirect_policy())
            .timeout(Duration::from_secs(60))
            .build()
            .map_err(|e| StartError::Http(e.to_string()))?;

        let imported = store.imported();
        let daemon = Arc::new(Daemon {
            session,
            store,
            auth,
            logs: Logs::default(),
            state: Mutex::new(State {
                settings: settings.clone(),
                torrents: HashMap::new(),
                by_id: HashMap::new(),
                categories,
                tags,
                incoming_seen: false,
                base_totals: totals,
                previews: HashMap::new(),
                scheduled: None,
            }),
            ops: tokio::sync::Mutex::new(()),
            persist_lock: tokio::sync::Mutex::new(()),
            running: settings,
            started_at: now(),
            temporary_password,
            http,
            sync: Mutex::new(SyncState::default()),
            stats,
            geo: GeoIp::default(),
            webhooks: Arc::new(webhooks),
            watch: Mutex::new(watched::WatchState::default()),
            rss: Mutex::new(crate::rss::RssState::default()),
            net: Mutex::new(net::NetState::new(cookies, listening)),
            rss_rules_lock: tokio::sync::Mutex::new(()),
            file_index: filesearch::FileIndex::default(),
            shutdown_requested: watch::channel(false).0,
            restart: std::sync::atomic::AtomicBool::new(false),
            closed: watch::channel(false).0,
            tasks: Mutex::new(Vec::new()),
        });
        daemon.logs.info(format!(
            "urtorrentd {} on urtorrent {} started (peer port {}){}",
            env!("CARGO_PKG_VERSION"),
            urtorrent::VERSION,
            daemon.session.listen_port(),
            if first_start { ", first start" } else { "" }
        ));
        {
            let s = daemon.settings();
            for e in daemon
                .geo
                .configure(s.geoip_database.as_deref(), s.geoip_asn_database.as_deref())
            {
                daemon.logs.warn(e);
            }
        }
        if let Err(e) = &daemon.stats {
            daemon.logs.warn(format!(
                "statistics are off for this run: {e} (delete {} to start over)",
                crate::stats::db::STATS_DB_FILE
            ));
        }
        if imported > 0 {
            daemon.logs.info(format!(
                "imported {imported} torrents from a 0.1 data directory (the old files are in imported-0.1/)"
            ));
        }
        daemon.restore().await;
        let pump = tokio::spawn(events::run(Arc::downgrade(&daemon), events));
        let tick = tokio::spawn(tick::run(Arc::downgrade(&daemon)));
        let index = daemon.spawn_file_index();
        if let Ok(mut t) = daemon.tasks.lock() {
            t.push(pump);
            t.push(tick);
            t.push(index);
        }
        Ok(daemon)
    }

    /// Re-add every stored torrent, in the order they were added (queue
    /// positions come back from the resume data).
    async fn restore(&self) {
        let store = self.store.clone();
        let stored = match blocking(move || store.load_torrents()).await {
            Ok(s) => s,
            Err(e) => {
                self.logs.warn(format!("reading saved torrents: {e}"));
                return;
            }
        };
        let mut restored = 0usize;
        for t in stored {
            let t = match t {
                Ok(t) => t,
                Err(e) => {
                    self.logs.warn(format!("unreadable torrent record {e}"));
                    continue;
                }
            };
            let record = t.record;
            let Some(hash) = parse_hash(&record.info_hash) else {
                self.logs.warn(format!(
                    "torrent record with a bad info-hash: {}",
                    record.info_hash
                ));
                continue;
            };
            let dir = record
                .download_path
                .clone()
                .unwrap_or_else(|| record.save_path.clone());
            let mut add = match (t.metainfo, &record.magnet) {
                (Some(b), _) => AddTorrent::metainfo(b, dir),
                (None, Some(m)) => {
                    AddTorrent::magnet(m.clone(), dir).hold_after_metadata(add::needs_hold(&record))
                }
                (None, None) => {
                    self.logs.warn(format!(
                        "torrent {} has neither metainfo nor a magnet link; skipped",
                        record.info_hash
                    ));
                    continue;
                }
            }
            .paused(record.stopped);
            let has_resume = t.resume.is_some();
            if let Some(r) = t.resume {
                add = add.resume_data(r);
            }
            match self.session.add_torrent(add).await {
                Ok(id) => {
                    self.insert(hash, id, record);
                    if has_resume && let Some(e) = self.state().torrents.get_mut(&hash) {
                        e.resume_restored = true;
                    }
                    restored += 1;
                }
                Err(e) => self.logs.warn(format!(
                    "could not restore torrent {}: {e}",
                    record.info_hash
                )),
            }
        }
        if restored > 0 {
            self.logs.info(format!("restored {restored} torrents"));
        }
    }

    pub(crate) fn state(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub(crate) fn insert(&self, hash: InfoHash, id: TorrentId, record: TorrentRecord) {
        let mut st = self.state();
        st.by_id.insert(id, hash);
        st.torrents.insert(hash, Entry::new(id, record));
    }

    /// The engine session (for tests and embedding).
    pub fn session(&self) -> &Session {
        &self.session
    }

    /// The main and peer logs.
    pub fn logs(&self) -> &Logs {
        &self.logs
    }

    /// The API user name.
    pub fn auth_username(&self) -> String {
        self.auth.credentials().username
    }

    /// The temporary password of this run, if no password is configured.
    pub fn temporary_password(&self) -> Option<&str> {
        self.temporary_password.as_deref()
    }

    /// The settings in force.
    pub fn settings(&self) -> Settings {
        self.state().settings.clone()
    }

    /// Change settings: validate, apply what can change live, persist.
    pub async fn update_settings(self: &Arc<Self>, patch: SettingsPatch) -> ApiResult<Settings> {
        let _ops = self.ops.lock().await;
        let old = self.settings();
        let new = old.patched(patch);
        new.validate().map_err(ApiError::bad_request)?;
        for (name, old_path, new_path) in [
            ("geoip_database", &old.geoip_database, &new.geoip_database),
            (
                "geoip_asn_database",
                &old.geoip_asn_database,
                &new.geoip_asn_database,
            ),
        ] {
            if let Some(p) = new_path
                && new_path != old_path
            {
                geo::check(p).map_err(|e| ApiError::bad_request(format!("{name}: {e}")))?;
            }
        }
        if let Err(e) = settings::apply_live(&self.session, &old, &new).await {
            // Undo whatever part went through before the failure.
            let _ = settings::apply_live(&self.session, &new, &old).await;
            return Err(e.into());
        }
        if (
            old.listen_port,
            old.listen_v4,
            old.listen_v6,
            &old.listen_interface,
        ) != (
            new.listen_port,
            new.listen_v4,
            new.listen_v6,
            &new.listen_interface,
        ) {
            self.set_listening(crate::interfaces::listen_addresses(&new));
        }
        {
            let (s, v) = (self.store.clone(), new.clone());
            blocking(move || s.save(store::SETTINGS, &v)).await?;
        }
        let save_path_changed = old.save_path != new.save_path;
        if (&old.geoip_database, &old.geoip_asn_database)
            != (&new.geoip_database, &new.geoip_asn_database)
        {
            for e in self.geo.configure(
                new.geoip_database.as_deref(),
                new.geoip_asn_database.as_deref(),
            ) {
                self.logs.warn(e);
            }
        }
        if old.stats_enabled != new.stats_enabled
            && let Ok(stats) = &self.stats
        {
            let retention = crate::stats::db::Retention {
                minute: new.stats_minute_retention,
                hour: new.stats_hour_retention,
                day: new.stats_day_retention,
            };
            if let Err(e) = stats
                .set_recording(new.stats_enabled, now(), retention)
                .await
            {
                self.logs.warn(format!("statistics: {e}"));
            }
        }
        if old.incomplete_file_suffix != new.incomplete_file_suffix {
            self.spawn_suffix_change(
                old.incomplete_file_suffix.clone(),
                new.incomplete_file_suffix.clone(),
            );
        }
        {
            let mut st = self.state();
            if old.alt_speed_schedule != new.alt_speed_schedule {
                st.scheduled = None;
            }
            st.settings = new.clone();
        }
        for ip in new
            .banned_ips
            .iter()
            .filter(|ip| !old.banned_ips.contains(ip))
        {
            self.logs.peer(
                *ip,
                true,
                crate::log::PeerLogSource::Settings,
                None,
                "banned in the settings",
            );
        }
        for ip in old
            .banned_ips
            .iter()
            .filter(|ip| !new.banned_ips.contains(ip))
        {
            self.logs.peer(
                *ip,
                false,
                crate::log::PeerLogSource::Settings,
                None,
                "unbanned in the settings",
            );
        }
        if save_path_changed {
            // Automatically managed torrents follow the default save path
            // through their category.
            self.relocate_managed(None).await;
        }
        Ok(new)
    }

    /// A torrent's lifecycle event: the timeline (while statistics are
    /// recorded) and the webhooks that want it.
    pub(crate) async fn lifecycle(
        &self,
        hash: InfoHash,
        kind: TimelineKind,
        detail: Option<String>,
    ) {
        let summary = self.hook_summary(hash, kind).await;
        self.lifecycle_with(hash, kind, detail, summary);
    }

    /// The torrent's list row for the webhooks, if one wants `kind`.
    pub(crate) async fn hook_summary(
        &self,
        hash: InfoHash,
        kind: TimelineKind,
    ) -> Option<crate::model::TorrentSummary> {
        let event = webhook_event(kind)?;
        if !self.webhooks.wanted(event) {
            return None;
        }
        let id = self.state().torrents.get(&hash)?.id;
        let s = self.session.status(id).await.ok()?;
        let st = self.state();
        let e = st.torrents.get(&hash)?;
        Some(view::summary(&s, e, &st))
    }

    /// [`Daemon::lifecycle`] with the row read before (a removal).
    pub(crate) fn lifecycle_with(
        &self,
        hash: InfoHash,
        kind: TimelineKind,
        detail: Option<String>,
        summary: Option<crate::model::TorrentSummary>,
    ) {
        if let Ok(stats) = &self.stats {
            stats.event(now(), hash, kind, detail.clone());
        }
        if let Some(event) = webhook_event(kind)
            && self.webhooks.wanted(event)
        {
            self.webhooks
                .fire(Webhooks::payload(event, Some(hex(&hash)), summary, detail));
        }
    }

    /// Store the webhooks.
    pub(crate) async fn save_webhooks(&self) -> ApiResult<()> {
        let (s, hooks) = (self.store.clone(), self.webhooks.stored());
        blocking(move || s.save(store::WEBHOOKS, &hooks)).await?;
        Ok(())
    }

    /// Ask the process to shut down (the `/app/shutdown` endpoint, and the
    /// signal handler, so open event streams end before the server drains).
    pub fn request_shutdown(&self) {
        let _ = self.shutdown_requested.send(true);
    }

    /// Ask the process to shut down gracefully and then start again (the
    /// binary re-executes itself with the same arguments).
    pub fn request_restart(&self) {
        self.restart
            .store(true, std::sync::atomic::Ordering::SeqCst);
        self.request_shutdown();
    }

    /// Whether the shutdown asked for is a restart.
    pub fn restart_requested(&self) -> bool {
        self.restart.load(std::sync::atomic::Ordering::SeqCst)
    }

    /// Watch for a shutdown request (open event streams end on it, so the
    /// HTTP server's graceful shutdown does not wait for them).
    pub(crate) fn shutdown_watch(&self) -> watch::Receiver<bool> {
        self.shutdown_requested.subscribe()
    }

    /// Resolves once a shutdown was requested through the API.
    pub async fn shutdown_requested(&self) {
        let mut rx = self.shutdown_requested.subscribe();
        let _ = rx.wait_for(|v| *v).await;
    }

    /// Whether `shutdown` has run.
    pub fn is_closed(&self) -> bool {
        *self.closed.borrow()
    }

    /// Stop: save resume data, records, totals and the DHT state, then stop
    /// the engine (trackers hear `stopped`). Idempotent.
    pub async fn shutdown(&self) {
        if self.closed.send_replace(true) {
            return;
        }
        let _ = self.shutdown_requested.send_replace(true);
        let _ops = self.ops.lock().await;
        if let Ok(tasks) = self.tasks.lock() {
            for t in tasks.iter() {
                t.abort();
            }
        }
        self.save_resume(ResumeSave::Changed).await;
        if let Err(e) = self.flush_records().await {
            self.logs.warn(format!("saving torrent records: {e}"));
        }
        self.save_totals().await;
        if let Ok(stats) = &self.stats
            && let Err(e) = stats.stop(now(), self.stats_retention()).await
        {
            self.logs.warn(format!("saving statistics: {e}"));
        }
        if let Ok(Some(dht)) = self.session.dht_state().await {
            let s = self.store.clone();
            if let Err(e) = blocking(move || s.save_dht(&dht)).await {
                self.logs.warn(format!("saving the DHT state: {e}"));
            }
        }
        if let Err(e) = self.session.shutdown().await {
            self.logs.warn(format!("engine shutdown: {e}"));
        }
        self.logs.info("stopped");
    }

    /// Change a torrent's record in memory; [`Daemon::flush_records`] writes
    /// it (bulk actions change many and write them in one transaction).
    pub(crate) fn edit_record(
        &self,
        hash: InfoHash,
        f: impl FnOnce(&mut TorrentRecord),
    ) -> ApiResult<()> {
        let mut st = self.state();
        let e = st
            .torrents
            .get_mut(&hash)
            .ok_or_else(|| ApiError::torrent_not_found(&hex(&hash)))?;
        f(&mut e.record);
        e.dirty = true;
        Ok(())
    }

    /// Change a torrent's record and write it.
    pub(crate) async fn update_record(
        &self,
        hash: InfoHash,
        f: impl FnOnce(&mut TorrentRecord),
    ) -> ApiResult<()> {
        self.edit_record(hash, f)?;
        self.flush_records().await
    }

    /// Write every changed record, in one transaction.
    pub(crate) async fn flush_records(&self) -> ApiResult<()> {
        let _g = self.persist_lock.lock().await;
        let records: Vec<(InfoHash, TorrentRecord)> = {
            let mut st = self.state();
            st.torrents
                .iter_mut()
                .filter(|(_, e)| e.dirty)
                .map(|(h, e)| {
                    e.dirty = false;
                    (*h, e.record.clone())
                })
                .collect()
        };
        if records.is_empty() {
            return Ok(());
        }
        let s = self.store.clone();
        let batch: Vec<TorrentRecord> = records.iter().map(|(_, r)| r.clone()).collect();
        if let Err(e) = blocking(move || s.save_records(&batch)).await {
            // Try again next time.
            let mut st = self.state();
            for (h, _) in &records {
                if let Some(e) = st.torrents.get_mut(h) {
                    e.dirty = true;
                }
            }
            return Err(e.into());
        }
        Ok(())
    }

    /// Fetch and store resume data (which syncs the torrent's files first,
    /// so it never claims data that is not on disk).
    pub(crate) async fn save_resume(&self, which: ResumeSave) {
        let Ok(statuses) = self.session.statuses().await else {
            return;
        };
        let now = Instant::now();
        let due: Vec<(InfoHash, TorrentId, ResumeMark)> = {
            let st = self.state();
            statuses
                .iter()
                .filter(|s| s.has_metadata && s.state != urtorrent::TorrentState::Held)
                .filter_map(|s| {
                    let e = st.torrents.get(&s.info_hash)?;
                    let pick = match which {
                        ResumeSave::One(h) => h == s.info_hash,
                        _ => which.picks(
                            s.needs_resume_save,
                            ResumeMark::of(s),
                            e.resume_mark,
                            e.resume_saved.map(|t| now.duration_since(t)),
                        ),
                    };
                    pick.then_some((s.info_hash, e.id, ResumeMark::of(s)))
                })
                .collect()
        };
        if due.is_empty() {
            return;
        }
        let mut items = Vec::with_capacity(due.len());
        for (h, id, mark) in due {
            match self.session.resume_data(id).await {
                Ok(bytes) => {
                    items.push((hex(&h), bytes));
                    if let Some(e) = self.state().torrents.get_mut(&h) {
                        e.resume_saved = Some(now);
                        // The data may hold newer counters than the status
                        // read before it; that only costs one more save.
                        e.resume_mark = Some(mark);
                    }
                }
                Err(e) => tracing::debug!("resume data of {}: {e}", hex(&h)),
            }
        }
        let s = self.store.clone();
        if let Err(e) = blocking(move || s.save_resume(&items)).await {
            self.logs.warn(format!("saving resume data: {e}"));
        }
    }

    /// Write the all-time totals.
    pub(crate) async fn save_totals(&self) {
        let Ok(stats) = self.session.stats().await else {
            return;
        };
        let base = self.state().base_totals;
        let totals = Totals {
            downloaded: base.downloaded.saturating_add(stats.downloaded),
            uploaded: base.uploaded.saturating_add(stats.uploaded),
        };
        let s = self.store.clone();
        if let Err(e) = blocking(move || s.save(store::TOTALS, &totals)).await {
            self.logs.warn(format!("saving totals: {e}"));
        }
    }

    /// The torrent id for an info-hash string, or 404.
    pub(crate) fn resolve(&self, hash: &str) -> ApiResult<(InfoHash, TorrentId)> {
        let h = parse_hash(hash)
            .ok_or_else(|| ApiError::bad_request(format!("{hash:?} is not an info-hash")))?;
        let id = self
            .state()
            .torrents
            .get(&h)
            .map(|e| e.id)
            .ok_or_else(|| ApiError::torrent_not_found(hash))?;
        Ok((h, id))
    }

    /// Resolve a bulk selection: the torrents found and the hashes not found.
    pub(crate) fn select(&self, hashes: &Hashes) -> ApiResult<Selection> {
        let st = self.state();
        match hashes {
            Hashes::All(_) => {
                let mut all: Vec<(InfoHash, TorrentId)> =
                    st.torrents.iter().map(|(h, e)| (*h, e.id)).collect();
                all.sort();
                Ok((all, Vec::new()))
            }
            Hashes::List(list) => {
                let mut found = Vec::new();
                let mut missing = Vec::new();
                for s in list {
                    let h = parse_hash(s).ok_or_else(|| {
                        ApiError::bad_request(format!("{s:?} is not an info-hash"))
                    })?;
                    match st.torrents.get(&h) {
                        Some(e) if !found.iter().any(|(x, _)| *x == h) => found.push((h, e.id)),
                        Some(_) => {}
                        None => missing.push(s.to_ascii_lowercase()),
                    }
                }
                Ok((found, missing))
            }
        }
    }

    /// Run `f` for every selected torrent and report per torrent; the
    /// records it changed are written in one transaction at the end.
    pub(crate) async fn bulk<F, Fut>(&self, hashes: &Hashes, f: F) -> ApiResult<BulkResult>
    where
        F: Fn(InfoHash, TorrentId) -> Fut,
        Fut: std::future::Future<Output = ApiResult<()>>,
    {
        let (found, not_found) = self.select(hashes)?;
        let mut out = BulkResult {
            not_found,
            ..BulkResult::default()
        };
        for (h, id) in found {
            match f(h, id).await {
                Ok(()) => out.applied.push(hex(&h)),
                Err(e) => out.failed.push(BulkFailure {
                    hash: hex(&h),
                    error: e.detail(),
                }),
            }
        }
        self.flush_records().await?;
        Ok(out)
    }
}

/// The webhook event of a timeline kind (state changes have none).
fn webhook_event(kind: TimelineKind) -> Option<crate::model::WebhookEvent> {
    use crate::model::WebhookEvent as W;
    match kind {
        TimelineKind::Added => Some(W::Added),
        TimelineKind::Metadata => Some(W::Metadata),
        TimelineKind::Finished => Some(W::Finished),
        TimelineKind::Moved => Some(W::Moved),
        TimelineKind::Error => Some(W::Error),
        TimelineKind::Removed => Some(W::Removed),
        TimelineKind::State => None,
    }
}

/// Which torrents' resume data to save.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ResumeSave {
    /// Changed ones not saved within [`RESUME_SAVE_EVERY`]: marked by the
    /// library, or with transfer counters that moved (the library does not
    /// mark those, so a seed's upload would otherwise wait for a shutdown).
    Due,
    /// Every one that changed at all, activity times included (shutdown).
    Changed,
    /// This one, changed or not.
    One(InfoHash),
}

/// The counters resume data carries that do not set `needs_resume_save`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ResumeMark {
    downloaded: u64,
    uploaded: u64,
    active_time: Duration,
}

impl ResumeMark {
    pub(crate) fn of(s: &urtorrent::TorrentStatus) -> ResumeMark {
        ResumeMark {
            downloaded: s.downloaded,
            uploaded: s.uploaded,
            active_time: s.active_time,
        }
    }
}

impl ResumeSave {
    /// Whether a torrent is saved: `marked` is the library's flag, `stored`
    /// what the stored data holds (unknown = changed), `since` the time
    /// since the last save in this run.
    fn picks(
        self,
        marked: bool,
        now: ResumeMark,
        stored: Option<ResumeMark>,
        since: Option<Duration>,
    ) -> bool {
        match self {
            ResumeSave::Due => {
                let moved = stored
                    .is_none_or(|m| m.downloaded != now.downloaded || m.uploaded != now.uploaded);
                (marked || moved) && since.is_none_or(|d| d >= RESUME_SAVE_EVERY)
            }
            ResumeSave::Changed => marked || stored != Some(now),
            ResumeSave::One(_) => true,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::{RESUME_SAVE_EVERY, ResumeMark, ResumeSave};

    fn mark(down: u64, up: u64, active: u64) -> ResumeMark {
        ResumeMark {
            downloaded: down,
            uploaded: up,
            active_time: Duration::from_secs(active),
        }
    }

    #[test]
    fn resume_saves_follow_changes() {
        let stored = Some(mark(10, 20, 100));
        let long = Some(RESUME_SAVE_EVERY);
        let short = Some(Duration::from_secs(5));
        let due = ResumeSave::Due;
        // Marked by the library, or a seed's upload moved: due once a minute.
        assert!(due.picks(true, mark(10, 20, 100), stored, long));
        assert!(due.picks(false, mark(10, 25, 160), stored, long));
        assert!(!due.picks(false, mark(10, 25, 160), stored, short));
        // Only the activity time moved: not worth a save of its own.
        assert!(!due.picks(false, mark(10, 20, 160), stored, long));
        // Never saved, and not restored from stored data.
        assert!(due.picks(false, mark(0, 0, 0), None, None));
        // Shutdown: anything that changed, activity time included.
        let changed = ResumeSave::Changed;
        assert!(changed.picks(false, mark(10, 20, 160), stored, short));
        assert!(changed.picks(true, mark(10, 20, 100), stored, short));
        assert!(!changed.picks(false, mark(10, 20, 100), stored, short));
        assert!(changed.picks(false, mark(10, 20, 100), None, None));
    }
}
