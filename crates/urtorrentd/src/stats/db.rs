// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The statistics database, `<data dir>/stats.db` (ADR 0005). It is kept
//! apart from `urtorrentd.db` because it is large, written every minute and
//! disposable (deleting it loses history, nothing else), so it runs with
//! `synchronous = NORMAL`. Every write is an additive upsert: partial
//! buckets from several flushes, or from two runs within one minute, add up.

use std::collections::{BTreeMap, HashMap};
use std::io;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, Transaction, params};
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::model::{StatsStep, TimelineKind, TorrentState};

/// The file in the data directory.
pub const STATS_DB_FILE: &str = "stats.db";
/// The schema version (`PRAGMA user_version`).
pub const STATS_SCHEMA_VERSION: i64 = 3;

fn db_err(e: rusqlite::Error) -> io::Error {
    io::Error::other(format!("statistics database: {e}"))
}

impl StatsStep {
    /// Every step, finest first.
    pub const ALL: [StatsStep; 3] = [StatsStep::Minute, StatsStep::Hour, StatsStep::Day];

    /// The bucket size in seconds.
    pub fn secs(self) -> u64 {
        match self {
            StatsStep::Minute => 60,
            StatsStep::Hour => 3600,
            StatsStep::Day => 86_400,
        }
    }

    /// The start of the bucket holding `t`.
    pub fn start(self, t: u64) -> u64 {
        t - t % self.secs()
    }
}

/// An enum as the string serde gives it (how kinds and states are stored).
fn tag<T: Serialize>(v: &T) -> String {
    match serde_json::to_value(v) {
        Ok(serde_json::Value::String(s)) => s,
        _ => String::new(),
    }
}

fn untag<T: DeserializeOwned>(s: &str) -> Option<T> {
    serde_json::from_value(serde_json::Value::String(s.to_string())).ok()
}

/// Traffic in one bucket.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Traffic {
    /// Payload bytes downloaded.
    pub downloaded: u64,
    /// Payload bytes uploaded.
    pub uploaded: u64,
    /// Most peers connected at once.
    pub peers_max: u32,
    /// Most seeds connected at once.
    pub seeds_max: u32,
}

impl Traffic {
    /// Merge another observation into this bucket.
    pub fn add(&mut self, o: &Traffic) {
        self.downloaded = self.downloaded.saturating_add(o.downloaded);
        self.uploaded = self.uploaded.saturating_add(o.uploaded);
        self.peers_max = self.peers_max.max(o.peers_max);
        self.seeds_max = self.seeds_max.max(o.seeds_max);
    }
}

/// The library's all-time counters at an observation.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Totals {
    /// Bytes downloaded.
    pub downloaded: u64,
    /// Bytes uploaded.
    pub uploaded: u64,
    /// Seconds running.
    pub active_time: u64,
    /// Seconds seeding.
    pub seeding_time: u64,
    /// Share ratio.
    pub ratio: Option<f64>,
}

/// One torrent's day.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct Day {
    /// Traffic that day.
    pub traffic: Traffic,
    /// Seconds running that day.
    pub active_time: u64,
    /// Seconds seeding that day.
    pub seeding_time: u64,
    /// The counters at the last observation.
    pub totals: Totals,
    /// Most seeders the trackers reported.
    pub swarm_seeds_max: Option<u32>,
    /// Most leechers the trackers reported.
    pub swarm_leechers_max: Option<u32>,
    /// Most completed downloads a scrape reported.
    pub swarm_completed_max: Option<u32>,
}

/// The larger of two optional values; `None` only if both are.
pub fn max_opt(a: Option<u32>, b: Option<u32>) -> Option<u32> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

/// Session-wide traffic in one bucket.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SessionTraffic {
    /// Payload bytes downloaded.
    pub downloaded: u64,
    /// Payload bytes uploaded.
    pub uploaded: u64,
    /// Most peers connected at once.
    pub peers_max: u32,
    /// Most connections at once.
    pub connections_max: u32,
    /// Most DHT nodes at once.
    pub dht_nodes_max: u32,
    /// Most torrents at once.
    pub torrents_max: u32,
}

impl SessionTraffic {
    /// Merge another observation into this bucket.
    pub fn add(&mut self, o: &SessionTraffic) {
        self.downloaded = self.downloaded.saturating_add(o.downloaded);
        self.uploaded = self.uploaded.saturating_add(o.uploaded);
        self.peers_max = self.peers_max.max(o.peers_max);
        self.connections_max = self.connections_max.max(o.connections_max);
        self.dht_nodes_max = self.dht_nodes_max.max(o.dht_nodes_max);
        self.torrents_max = self.torrents_max.max(o.torrents_max);
    }
}

/// Peer traffic with one place in one bucket.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct PeerTraffic {
    /// Payload bytes received.
    pub downloaded: u64,
    /// Payload bytes sent.
    pub uploaded: u64,
    /// Distinct addresses that moved data (within a run).
    pub peers: u32,
}

/// A timeline event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EventRow {
    /// When.
    pub t: u64,
    /// Info-hash (hex).
    pub hash: String,
    /// What happened.
    pub kind: TimelineKind,
    /// The new state (`State` events).
    pub state: Option<TorrentState>,
    /// The new directory or the error.
    pub detail: Option<String>,
}

/// A torrent's name and size, as last seen.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Meta {
    /// Name.
    pub name: Option<String>,
    /// Size of the content, bytes.
    pub size: Option<u64>,
    /// Category and tags; `None` = not known here (kept as recorded).
    pub groups: Option<(Option<String>, Vec<String>)>,
    /// Host of the tracker it works with; `None` = kept as recorded.
    pub tracker: Option<String>,
}

/// What one flush writes.
#[derive(Debug, Default)]
pub struct Batch {
    /// The recording period to extend: (id, now).
    pub period: Option<(i64, u64)>,
    /// Names and sizes of the torrents below (hex info-hash).
    pub meta: HashMap<String, Meta>,
    /// Per-torrent traffic: (hash, step, bucket start, traffic); minute and
    /// hour steps.
    pub traffic: Vec<(String, StatsStep, u64, Traffic)>,
    /// Per-torrent days: (hash, day start, day).
    pub days: Vec<(String, u64, Day)>,
    /// Session traffic: (step, bucket start, traffic).
    pub session: Vec<(StatsStep, u64, SessionTraffic)>,
    /// Timeline events.
    pub events: Vec<EventRow>,
    /// Peer traffic: (hash, step, bucket start, dimension, key, traffic);
    /// hour and day steps.
    pub peer_traffic: Vec<(String, StatsStep, u64, &'static str, String, PeerTraffic)>,
    /// Autonomous system names.
    pub asns: Vec<(u32, String)>,
    /// Tracker announces: (host, step, bucket start, replies, errors); hour
    /// and day steps.
    pub announces: Vec<(String, StatsStep, u64, u32, u32)>,
}

impl Batch {
    /// Nothing to write.
    pub fn is_empty(&self) -> bool {
        self.period.is_none()
            && self.traffic.is_empty()
            && self.days.is_empty()
            && self.session.is_empty()
            && self.events.is_empty()
            && self.peer_traffic.is_empty()
            && self.asns.is_empty()
            && self.announces.is_empty()
    }
}

/// How long each step is kept, seconds (`None` = forever).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Retention {
    /// Per-minute buckets.
    pub minute: Option<u64>,
    /// Per-hour buckets.
    pub hour: Option<u64>,
    /// Days, the timeline and the recording periods.
    pub day: Option<u64>,
}

impl Retention {
    /// How long `step` is kept.
    pub fn of(&self, step: StatsStep) -> Option<u64> {
        match step {
            StatsStep::Minute => self.minute,
            StatsStep::Hour => self.hour,
            StatsStep::Day => self.day,
        }
    }
}

/// A group's totals over a range: `(key, downloaded, uploaded, torrents)`;
/// `None` = no group.
pub type KeyTotals = (Option<String>, u64, u64, u32);

/// A tracker host's announces: `(host, replies, errors)`.
pub type HostAnnounces = (String, u64, u64);

/// A group's bucket: `(t, key, downloaded, uploaded)`.
pub type KeyBucket = (u64, Option<String>, u64, u64);

/// A tracker's bucket: `(t, host, down, up, replies, errors)`.
pub type HostBucket = (u64, Option<String>, u64, u64, u64, u64);

/// A torrent the database knows.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TorrentRow {
    /// Row id.
    pub id: i64,
    /// Info-hash (hex).
    pub hash: String,
    /// Name as last recorded.
    pub name: Option<String>,
    /// When it was removed.
    pub removed: Option<u64>,
}

/// A recording period.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Period {
    /// Row id.
    pub id: i64,
    /// Start.
    pub started: u64,
    /// Last write.
    pub last_seen: u64,
    /// Clean end.
    pub stopped: Option<u64>,
}

/// Coverage and size.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Info {
    /// File size, bytes.
    pub size: u64,
    /// Torrents known.
    pub torrents: u64,
    /// Of those, the ones removed from the session.
    pub removed: u64,
    /// Oldest session bucket per step (minute, hour, day).
    pub oldest: [Option<u64>; 3],
}

struct Known {
    id: i64,
    meta: Meta,
}

struct Writer {
    conn: Connection,
    ids: HashMap<String, Known>,
}

/// The statistics database: one connection writes, another reads (WAL lets
/// queries run while a flush writes).
pub struct StatsDb {
    writer: Mutex<Writer>,
    reader: Mutex<Connection>,
}

fn connect(path: &Path) -> io::Result<Connection> {
    let conn = Connection::open(path).map_err(db_err)?;
    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(db_err)?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(db_err)?;
    conn.busy_timeout(std::time::Duration::from_secs(10))
        .map_err(db_err)?;
    Ok(conn)
}

/// Version 1 (0.5.0).
const SCHEMA_V1: &str = "CREATE TABLE torrents (
                 id INTEGER PRIMARY KEY,
                 hash TEXT NOT NULL UNIQUE,
                 name TEXT,
                 size INTEGER,
                 removed INTEGER
             );
             CREATE TABLE traffic (
                 torrent INTEGER NOT NULL,
                 step INTEGER NOT NULL,
                 t INTEGER NOT NULL,
                 downloaded INTEGER NOT NULL,
                 uploaded INTEGER NOT NULL,
                 peers_max INTEGER NOT NULL,
                 seeds_max INTEGER NOT NULL,
                 PRIMARY KEY (torrent, step, t)
             ) WITHOUT ROWID;
             CREATE INDEX traffic_by_time ON traffic (step, t);
             CREATE TABLE daily (
                 torrent INTEGER NOT NULL,
                 t INTEGER NOT NULL,
                 downloaded INTEGER NOT NULL,
                 uploaded INTEGER NOT NULL,
                 peers_max INTEGER NOT NULL,
                 seeds_max INTEGER NOT NULL,
                 active_time INTEGER NOT NULL,
                 seeding_time INTEGER NOT NULL,
                 downloaded_total INTEGER NOT NULL,
                 uploaded_total INTEGER NOT NULL,
                 active_time_total INTEGER NOT NULL,
                 seeding_time_total INTEGER NOT NULL,
                 ratio REAL,
                 swarm_seeds_max INTEGER,
                 swarm_leechers_max INTEGER,
                 PRIMARY KEY (torrent, t)
             ) WITHOUT ROWID;
             CREATE INDEX daily_by_time ON daily (t);
             CREATE TABLE session (
                 step INTEGER NOT NULL,
                 t INTEGER NOT NULL,
                 downloaded INTEGER NOT NULL,
                 uploaded INTEGER NOT NULL,
                 peers_max INTEGER NOT NULL,
                 connections_max INTEGER NOT NULL,
                 dht_nodes_max INTEGER NOT NULL,
                 torrents_max INTEGER NOT NULL,
                 PRIMARY KEY (step, t)
             ) WITHOUT ROWID;
             CREATE TABLE events (
                 id INTEGER PRIMARY KEY,
                 t INTEGER NOT NULL,
                 torrent INTEGER NOT NULL,
                 kind TEXT NOT NULL,
                 state TEXT,
                 detail TEXT
             );
             CREATE INDEX events_by_time ON events (t);
             CREATE INDEX events_by_torrent ON events (torrent, t);
             CREATE TABLE periods (
                 id INTEGER PRIMARY KEY,
                 started INTEGER NOT NULL,
                 last_seen INTEGER NOT NULL,
                 stopped INTEGER
             );";

/// Version 2 (0.6.0): peer traffic by place.
const SCHEMA_V2: &str = "CREATE TABLE peer_traffic (
                 torrent INTEGER NOT NULL,
                 step INTEGER NOT NULL,
                 t INTEGER NOT NULL,
                 dim TEXT NOT NULL,
                 key TEXT NOT NULL,
                 downloaded INTEGER NOT NULL,
                 uploaded INTEGER NOT NULL,
                 peers INTEGER NOT NULL,
                 PRIMARY KEY (torrent, step, t, dim, key)
             ) WITHOUT ROWID;
             CREATE INDEX peer_traffic_by_time ON peer_traffic (step, dim, t);
             CREATE TABLE asns (asn INTEGER PRIMARY KEY, name TEXT NOT NULL);";

/// Version 3 (0.7.0): torrents' groups, tracker announces, completed
/// downloads from scrapes.
const SCHEMA_V3: &str = "ALTER TABLE torrents ADD COLUMN category TEXT;
     ALTER TABLE torrents ADD COLUMN tags TEXT;
     ALTER TABLE torrents ADD COLUMN tracker TEXT;
     ALTER TABLE daily ADD COLUMN swarm_completed_max INTEGER;
     CREATE TABLE announces (
         host TEXT NOT NULL,
         step INTEGER NOT NULL,
         t INTEGER NOT NULL,
         replies INTEGER NOT NULL,
         errors INTEGER NOT NULL,
         PRIMARY KEY (host, step, t)
     ) WITHOUT ROWID;
     CREATE INDEX announces_by_time ON announces (step, t);";

/// Bring the schema to [`STATS_SCHEMA_VERSION`].
fn migrate(conn: &mut Connection) -> io::Result<()> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(db_err)?;
    if version > STATS_SCHEMA_VERSION {
        return Err(io::Error::other(format!(
            "the statistics database has schema version {version}, newer than this daemon's {STATS_SCHEMA_VERSION}"
        )));
    }
    let tx = conn.transaction().map_err(db_err)?;
    if version < 1 {
        tx.execute_batch(SCHEMA_V1).map_err(db_err)?;
    }
    if version < 2 {
        tx.execute_batch(SCHEMA_V2).map_err(db_err)?;
    }
    if version < 3 {
        tx.execute_batch(SCHEMA_V3).map_err(db_err)?;
    }
    tx.pragma_update(None, "user_version", STATS_SCHEMA_VERSION)
        .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

/// The torrent's row id, created or updated with `meta` when needed.
fn ensure(
    tx: &Transaction<'_>,
    ids: &HashMap<String, Known>,
    new: &mut HashMap<String, Known>,
    hash: &str,
    meta: Option<&Meta>,
) -> rusqlite::Result<i64> {
    if let Some(k) = new.get(hash).or_else(|| ids.get(hash)) {
        let current = meta.is_none_or(|m| {
            (m.name.is_none() || m.name == k.meta.name)
                && (m.size.is_none() || m.size == k.meta.size)
                && (m.groups.is_none() || m.groups == k.meta.groups)
                && (m.tracker.is_none() || m.tracker == k.meta.tracker)
        });
        if current {
            return Ok(k.id);
        }
    }
    let m = meta.cloned().unwrap_or_default();
    let (category, tags) = match &m.groups {
        Some((c, t)) => (
            c.clone(),
            Some(serde_json::to_string(t).unwrap_or_default()),
        ),
        None => (None, None),
    };
    let known = tx.query_row(
        "INSERT INTO torrents (hash, name, size, category, tags, tracker)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(hash) DO UPDATE SET
             name = coalesce(excluded.name, name),
             size = coalesce(excluded.size, size),
             category = CASE WHEN ?7 THEN excluded.category ELSE category END,
             tags = CASE WHEN ?7 THEN excluded.tags ELSE tags END,
             tracker = coalesce(excluded.tracker, tracker)
         RETURNING id, name, size, category, tags, tracker",
        params![
            hash,
            m.name,
            m.size,
            category,
            tags,
            m.tracker,
            m.groups.is_some()
        ],
        known_row,
    )?;
    let id = known.id;
    new.insert(hash.to_string(), known);
    Ok(id)
}

/// A `torrents` row as the writer caches it: `id, name, size, category,
/// tags, tracker`.
fn known_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Known> {
    let tags: Option<String> = r.get(4)?;
    Ok(Known {
        id: r.get(0)?,
        meta: Meta {
            name: r.get(1)?,
            size: r.get(2)?,
            groups: tags.map(|t| {
                (
                    r.get::<_, Option<String>>(3).ok().flatten(),
                    serde_json::from_str(&t).unwrap_or_default(),
                )
            }),
            tracker: r.get(5)?,
        },
    })
}

/// The host of a tracker URL (`udp://tracker.example.org:1337/announce` is
/// `tracker.example.org`). Only the host is ever stored: private trackers'
/// URLs carry the user's passkey.
pub fn tracker_host(url: &str) -> Option<String> {
    let rest = url.split_once("://")?.1;
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = match host_port.strip_prefix('[') {
        Some(v6) => v6.split(']').next()?,
        None => match host_port.rsplit_once(':') {
            Some((h, port)) if port.bytes().all(|b| b.is_ascii_digit()) => h,
            _ => host_port,
        },
    };
    let host = host.trim().to_ascii_lowercase();
    (!host.is_empty() && host.len() <= 253 && !host.contains(char::is_whitespace)).then_some(host)
}

impl StatsDb {
    /// Open (create, migrate) `stats.db` in `dir`.
    pub fn open(dir: &Path) -> io::Result<StatsDb> {
        std::fs::create_dir_all(dir)?;
        let path = dir.join(STATS_DB_FILE);
        let mut conn = connect(&path)?;
        migrate(&mut conn)?;
        let mut ids = HashMap::new();
        {
            let mut stmt = conn
                .prepare("SELECT hash, id, name, size, category, tags, tracker FROM torrents")
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |r| {
                    let hash: String = r.get(0)?;
                    let tags: Option<String> = r.get(5)?;
                    Ok((
                        hash,
                        Known {
                            id: r.get(1)?,
                            meta: Meta {
                                name: r.get(2)?,
                                size: r.get(3)?,
                                groups: tags.map(|t| {
                                    (
                                        r.get::<_, Option<String>>(4).ok().flatten(),
                                        serde_json::from_str(&t).unwrap_or_default(),
                                    )
                                }),
                                tracker: r.get(6)?,
                            },
                        },
                    ))
                })
                .map_err(db_err)?;
            for row in rows {
                let (h, k) = row.map_err(db_err)?;
                ids.insert(h, k);
            }
        }
        let reader = connect(&path)?;
        Ok(StatsDb {
            writer: Mutex::new(Writer { conn, ids }),
            reader: Mutex::new(reader),
        })
    }

    fn writer(&self) -> MutexGuard<'_, Writer> {
        self.writer.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn reader(&self) -> MutexGuard<'_, Connection> {
        self.reader.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Start a recording period; returns its id.
    pub fn start_period(&self, now: u64) -> io::Result<i64> {
        let w = self.writer();
        w.conn
            .query_row(
                "INSERT INTO periods (started, last_seen) VALUES (?1, ?1) RETURNING id",
                params![now],
                |r| r.get(0),
            )
            .map_err(db_err)
    }

    /// End a recording period cleanly.
    pub fn end_period(&self, id: i64, now: u64) -> io::Result<()> {
        let w = self.writer();
        w.conn
            .execute(
                "UPDATE periods SET last_seen = ?2, stopped = ?2 WHERE id = ?1",
                params![id, now],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// Write a batch in one transaction.
    pub fn write(&self, b: &Batch) -> io::Result<()> {
        if b.is_empty() {
            return Ok(());
        }
        let mut w = self.writer();
        let Writer { conn, ids } = &mut *w;
        let mut new = HashMap::new();
        let tx = conn.transaction().map_err(db_err)?;
        {
            if let Some((id, now)) = b.period {
                tx.execute(
                    "UPDATE periods SET last_seen = max(last_seen, ?2) WHERE id = ?1",
                    params![id, now],
                )
                .map_err(db_err)?;
            }
            let mut traffic = tx
                .prepare_cached(
                    "INSERT INTO traffic (torrent, step, t, downloaded, uploaded, peers_max, seeds_max)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(torrent, step, t) DO UPDATE SET
                         downloaded = downloaded + excluded.downloaded,
                         uploaded = uploaded + excluded.uploaded,
                         peers_max = max(peers_max, excluded.peers_max),
                         seeds_max = max(seeds_max, excluded.seeds_max)",
                )
                .map_err(db_err)?;
            for (hash, step, t, x) in &b.traffic {
                let id = ensure(&tx, ids, &mut new, hash, b.meta.get(hash)).map_err(db_err)?;
                traffic
                    .execute(params![
                        id,
                        step.secs(),
                        t,
                        x.downloaded,
                        x.uploaded,
                        x.peers_max,
                        x.seeds_max
                    ])
                    .map_err(db_err)?;
            }
            let mut daily = tx
                .prepare_cached(
                    "INSERT INTO daily (torrent, t, downloaded, uploaded, peers_max, seeds_max,
                         active_time, seeding_time, downloaded_total, uploaded_total,
                         active_time_total, seeding_time_total, ratio, swarm_seeds_max,
                         swarm_leechers_max, swarm_completed_max)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
                     ON CONFLICT(torrent, t) DO UPDATE SET
                         downloaded = downloaded + excluded.downloaded,
                         uploaded = uploaded + excluded.uploaded,
                         peers_max = max(peers_max, excluded.peers_max),
                         seeds_max = max(seeds_max, excluded.seeds_max),
                         active_time = active_time + excluded.active_time,
                         seeding_time = seeding_time + excluded.seeding_time,
                         downloaded_total = excluded.downloaded_total,
                         uploaded_total = excluded.uploaded_total,
                         active_time_total = excluded.active_time_total,
                         seeding_time_total = excluded.seeding_time_total,
                         ratio = excluded.ratio,
                         swarm_seeds_max = max(coalesce(swarm_seeds_max, excluded.swarm_seeds_max),
                                               coalesce(excluded.swarm_seeds_max, swarm_seeds_max)),
                         swarm_leechers_max = max(coalesce(swarm_leechers_max, excluded.swarm_leechers_max),
                                                  coalesce(excluded.swarm_leechers_max, swarm_leechers_max)),
                         swarm_completed_max = max(coalesce(swarm_completed_max, excluded.swarm_completed_max),
                                                   coalesce(excluded.swarm_completed_max, swarm_completed_max))",
                )
                .map_err(db_err)?;
            for (hash, t, d) in &b.days {
                let id = ensure(&tx, ids, &mut new, hash, b.meta.get(hash)).map_err(db_err)?;
                daily
                    .execute(params![
                        id,
                        t,
                        d.traffic.downloaded,
                        d.traffic.uploaded,
                        d.traffic.peers_max,
                        d.traffic.seeds_max,
                        d.active_time,
                        d.seeding_time,
                        d.totals.downloaded,
                        d.totals.uploaded,
                        d.totals.active_time,
                        d.totals.seeding_time,
                        d.totals.ratio,
                        d.swarm_seeds_max,
                        d.swarm_leechers_max,
                        d.swarm_completed_max
                    ])
                    .map_err(db_err)?;
            }
            let mut session = tx
                .prepare_cached(
                    "INSERT INTO session (step, t, downloaded, uploaded, peers_max,
                         connections_max, dht_nodes_max, torrents_max)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(step, t) DO UPDATE SET
                         downloaded = downloaded + excluded.downloaded,
                         uploaded = uploaded + excluded.uploaded,
                         peers_max = max(peers_max, excluded.peers_max),
                         connections_max = max(connections_max, excluded.connections_max),
                         dht_nodes_max = max(dht_nodes_max, excluded.dht_nodes_max),
                         torrents_max = max(torrents_max, excluded.torrents_max)",
                )
                .map_err(db_err)?;
            for (step, t, x) in &b.session {
                session
                    .execute(params![
                        step.secs(),
                        t,
                        x.downloaded,
                        x.uploaded,
                        x.peers_max,
                        x.connections_max,
                        x.dht_nodes_max,
                        x.torrents_max
                    ])
                    .map_err(db_err)?;
            }
            let mut peer = tx
                .prepare_cached(
                    "INSERT INTO peer_traffic (torrent, step, t, dim, key, downloaded, uploaded, peers)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                     ON CONFLICT(torrent, step, t, dim, key) DO UPDATE SET
                         downloaded = downloaded + excluded.downloaded,
                         uploaded = uploaded + excluded.uploaded,
                         peers = peers + excluded.peers",
                )
                .map_err(db_err)?;
            for (hash, step, t, dim, key, x) in &b.peer_traffic {
                let id = ensure(&tx, ids, &mut new, hash, b.meta.get(hash)).map_err(db_err)?;
                peer.execute(params![
                    id,
                    step.secs(),
                    t,
                    dim,
                    key,
                    x.downloaded,
                    x.uploaded,
                    x.peers
                ])
                .map_err(db_err)?;
            }
            for (host, step, t, replies, errors) in &b.announces {
                tx.execute(
                    "INSERT INTO announces (host, step, t, replies, errors) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(host, step, t) DO UPDATE SET
                         replies = replies + excluded.replies,
                         errors = errors + excluded.errors",
                    params![host, step.secs(), t, replies, errors],
                )
                .map_err(db_err)?;
            }
            for (asn, name) in &b.asns {
                tx.execute(
                    "INSERT INTO asns (asn, name) VALUES (?1, ?2)
                     ON CONFLICT(asn) DO UPDATE SET name = excluded.name",
                    params![asn, name],
                )
                .map_err(db_err)?;
            }
            for e in &b.events {
                let id =
                    ensure(&tx, ids, &mut new, &e.hash, b.meta.get(&e.hash)).map_err(db_err)?;
                tx.execute(
                    "INSERT INTO events (t, torrent, kind, state, detail) VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![e.t, id, tag(&e.kind), e.state.map(|s| tag(&s)), e.detail],
                )
                .map_err(db_err)?;
                match e.kind {
                    TimelineKind::Added => tx.execute(
                        "UPDATE torrents SET removed = NULL WHERE id = ?1",
                        params![id],
                    ),
                    TimelineKind::Removed => tx.execute(
                        "UPDATE torrents SET removed = ?2 WHERE id = ?1",
                        params![id, e.t],
                    ),
                    _ => Ok(0),
                }
                .map_err(db_err)?;
            }
        }
        tx.commit().map_err(db_err)?;
        ids.extend(new);
        Ok(())
    }

    /// Delete what is older than the retention allows, then torrents that
    /// were removed and have nothing left. Returns the rows deleted.
    pub fn prune(&self, now: u64, r: &Retention) -> io::Result<usize> {
        let mut w = self.writer();
        let Writer { conn, ids } = &mut *w;
        let tx = conn.transaction().map_err(db_err)?;
        let mut n = 0;
        let mut gone = Vec::new();
        {
            let cutoff = |keep: u64| now.saturating_sub(keep);
            for step in [StatsStep::Minute, StatsStep::Hour] {
                if let Some(keep) = r.of(step) {
                    n += tx
                        .execute(
                            "DELETE FROM traffic WHERE step = ?1 AND t < ?2",
                            params![step.secs(), cutoff(keep)],
                        )
                        .map_err(db_err)?;
                }
            }
            for step in [StatsStep::Hour, StatsStep::Day] {
                if let Some(keep) = r.of(step) {
                    for sql in [
                        "DELETE FROM peer_traffic WHERE step = ?1 AND t < ?2",
                        "DELETE FROM announces WHERE step = ?1 AND t < ?2",
                    ] {
                        n += tx
                            .execute(sql, params![step.secs(), cutoff(keep)])
                            .map_err(db_err)?;
                    }
                }
            }
            for step in StatsStep::ALL {
                if let Some(keep) = r.of(step) {
                    n += tx
                        .execute(
                            "DELETE FROM session WHERE step = ?1 AND t < ?2",
                            params![step.secs(), cutoff(keep)],
                        )
                        .map_err(db_err)?;
                }
            }
            if let Some(keep) = r.day {
                let c = cutoff(keep);
                for sql in [
                    "DELETE FROM daily WHERE t < ?1",
                    "DELETE FROM events WHERE t < ?1",
                    "DELETE FROM periods WHERE last_seen < ?1",
                ] {
                    n += tx.execute(sql, params![c]).map_err(db_err)?;
                }
            }
            let mut stmt = tx
                .prepare(
                    "DELETE FROM torrents WHERE removed IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM traffic WHERE torrent = torrents.id)
                       AND NOT EXISTS (SELECT 1 FROM daily WHERE torrent = torrents.id)
                       AND NOT EXISTS (SELECT 1 FROM events WHERE torrent = torrents.id)
                       AND NOT EXISTS (SELECT 1 FROM peer_traffic WHERE torrent = torrents.id)
                     RETURNING hash",
                )
                .map_err(db_err)?;
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(0))
                .map_err(db_err)?;
            for h in rows {
                gone.push(h.map_err(db_err)?);
            }
        }
        tx.commit().map_err(db_err)?;
        n += gone.len();
        for h in gone {
            ids.remove(&h);
        }
        Ok(n)
    }

    /// Delete a torrent's history. Returns whether there was any.
    pub fn purge(&self, hash: &str) -> io::Result<bool> {
        let mut w = self.writer();
        let Writer { conn, ids } = &mut *w;
        let tx = conn.transaction().map_err(db_err)?;
        let id: Option<i64> = tx
            .query_row(
                "SELECT id FROM torrents WHERE hash = ?1",
                params![hash],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let Some(id) = id else {
            return Ok(false);
        };
        for sql in [
            "DELETE FROM traffic WHERE torrent = ?1",
            "DELETE FROM daily WHERE torrent = ?1",
            "DELETE FROM events WHERE torrent = ?1",
            "DELETE FROM peer_traffic WHERE torrent = ?1",
            "DELETE FROM torrents WHERE id = ?1",
        ] {
            tx.execute(sql, params![id]).map_err(db_err)?;
        }
        tx.commit().map_err(db_err)?;
        ids.remove(hash);
        Ok(true)
    }

    /// Delete everything recorded, and start a recording period at `now`
    /// when `recording`; the file shrinks (`VACUUM`). Returns the new
    /// period.
    pub fn clear(&self, now: u64, recording: bool) -> io::Result<Option<i64>> {
        let mut w = self.writer();
        let Writer { conn, ids } = &mut *w;
        let tx = conn.transaction().map_err(db_err)?;
        for table in [
            "traffic",
            "daily",
            "session",
            "events",
            "peer_traffic",
            "announces",
            "asns",
            "torrents",
            "periods",
        ] {
            tx.execute(&format!("DELETE FROM {table}"), [])
                .map_err(db_err)?;
        }
        let period = if recording {
            Some(
                tx.query_row(
                    "INSERT INTO periods (started, last_seen) VALUES (?1, ?1) RETURNING id",
                    params![now],
                    |r| r.get(0),
                )
                .map_err(db_err)?,
            )
        } else {
            None
        };
        tx.commit().map_err(db_err)?;
        ids.clear();
        conn.execute_batch("VACUUM").map_err(db_err)?;
        Ok(period)
    }

    /// Delete the history of every torrent removed from the session; the
    /// file shrinks (`VACUUM`). Returns how many torrents that was.
    pub fn purge_removed(&self) -> io::Result<u64> {
        let mut w = self.writer();
        let Writer { conn, ids } = &mut *w;
        let tx = conn.transaction().map_err(db_err)?;
        let hashes: Vec<String> = {
            let mut stmt = tx
                .prepare("SELECT hash FROM torrents WHERE removed IS NOT NULL")
                .map_err(db_err)?;
            let rows = stmt.query_map([], |r| r.get(0)).map_err(db_err)?;
            rows.collect::<rusqlite::Result<_>>().map_err(db_err)?
        };
        for table in ["traffic", "daily", "events", "peer_traffic"] {
            tx.execute(
                &format!(
                    "DELETE FROM {table} WHERE torrent IN
                     (SELECT id FROM torrents WHERE removed IS NOT NULL)"
                ),
                [],
            )
            .map_err(db_err)?;
        }
        tx.execute("DELETE FROM torrents WHERE removed IS NOT NULL", [])
            .map_err(db_err)?;
        tx.commit().map_err(db_err)?;
        for h in &hashes {
            ids.remove(h);
        }
        if !hashes.is_empty() {
            conn.execute_batch("VACUUM").map_err(db_err)?;
        }
        Ok(u64::try_from(hashes.len()).unwrap_or(u64::MAX))
    }

    /// A torrent by info-hash.
    pub fn torrent(&self, hash: &str) -> io::Result<Option<TorrentRow>> {
        self.reader()
            .query_row(
                "SELECT id, hash, name, removed FROM torrents WHERE hash = ?1",
                params![hash],
                |r| {
                    Ok(TorrentRow {
                        id: r.get(0)?,
                        hash: r.get(1)?,
                        name: r.get(2)?,
                        removed: r.get(3)?,
                    })
                },
            )
            .optional()
            .map_err(db_err)
    }

    /// A torrent's traffic, oldest first.
    pub fn traffic(
        &self,
        torrent: i64,
        step: StatsStep,
        from: u64,
        to: u64,
    ) -> io::Result<Vec<(u64, Traffic)>> {
        let conn = self.reader();
        let map = |r: &rusqlite::Row<'_>| {
            Ok((
                r.get(0)?,
                Traffic {
                    downloaded: r.get(1)?,
                    uploaded: r.get(2)?,
                    peers_max: r.get(3)?,
                    seeds_max: r.get(4)?,
                },
            ))
        };
        let rows = if step == StatsStep::Day {
            // Days with traffic; days with only running time are in `days`.
            let mut stmt = conn
                .prepare_cached(
                    "SELECT t, downloaded, uploaded, peers_max, seeds_max FROM daily
                     WHERE torrent = ?1 AND t BETWEEN ?2 AND ?3
                       AND (downloaded > 0 OR uploaded > 0) ORDER BY t",
                )
                .map_err(db_err)?;
            stmt.query_map(params![torrent, from, to], map)
                .map_err(db_err)?
                .collect::<rusqlite::Result<Vec<_>>>()
        } else {
            let mut stmt = conn
                .prepare_cached(
                    "SELECT t, downloaded, uploaded, peers_max, seeds_max FROM traffic
                     WHERE torrent = ?1 AND step = ?2 AND t BETWEEN ?3 AND ?4 ORDER BY t",
                )
                .map_err(db_err)?;
            stmt.query_map(params![torrent, step.secs(), from, to], map)
                .map_err(db_err)?
                .collect::<rusqlite::Result<Vec<_>>>()
        };
        rows.map_err(db_err)
    }

    /// A torrent's days, oldest first.
    pub fn days(&self, torrent: i64, from: u64, to: u64) -> io::Result<Vec<(u64, Day)>> {
        let conn = self.reader();
        let mut stmt = conn
            .prepare_cached(
                "SELECT t, downloaded, uploaded, peers_max, seeds_max, active_time, seeding_time,
                     downloaded_total, uploaded_total, active_time_total, seeding_time_total,
                     ratio, swarm_seeds_max, swarm_leechers_max, swarm_completed_max
                 FROM daily WHERE torrent = ?1 AND t BETWEEN ?2 AND ?3 ORDER BY t",
            )
            .map_err(db_err)?;
        stmt.query_map(params![torrent, from, to], |r| {
            Ok((
                r.get(0)?,
                Day {
                    traffic: Traffic {
                        downloaded: r.get(1)?,
                        uploaded: r.get(2)?,
                        peers_max: r.get(3)?,
                        seeds_max: r.get(4)?,
                    },
                    active_time: r.get(5)?,
                    seeding_time: r.get(6)?,
                    totals: Totals {
                        downloaded: r.get(7)?,
                        uploaded: r.get(8)?,
                        active_time: r.get(9)?,
                        seeding_time: r.get(10)?,
                        ratio: r.get(11)?,
                    },
                    swarm_seeds_max: r.get(12)?,
                    swarm_leechers_max: r.get(13)?,
                    swarm_completed_max: r.get(14)?,
                },
            ))
        })
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)
    }

    /// Session traffic, oldest first.
    pub fn session(
        &self,
        step: StatsStep,
        from: u64,
        to: u64,
    ) -> io::Result<Vec<(u64, SessionTraffic)>> {
        let conn = self.reader();
        let mut stmt = conn
            .prepare_cached(
                "SELECT t, downloaded, uploaded, peers_max, connections_max, dht_nodes_max,
                     torrents_max
                 FROM session WHERE step = ?1 AND t BETWEEN ?2 AND ?3 ORDER BY t",
            )
            .map_err(db_err)?;
        stmt.query_map(params![step.secs(), from, to], |r| {
            Ok((
                r.get(0)?,
                SessionTraffic {
                    downloaded: r.get(1)?,
                    uploaded: r.get(2)?,
                    peers_max: r.get(3)?,
                    connections_max: r.get(4)?,
                    dht_nodes_max: r.get(5)?,
                    torrents_max: r.get(6)?,
                },
            ))
        })
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)
    }

    /// Torrents ranked by traffic over a range, highest first.
    pub fn top(
        &self,
        step: StatsStep,
        from: u64,
        to: u64,
        by_upload: bool,
        limit: u32,
    ) -> io::Result<Vec<(TorrentRow, Traffic)>> {
        let conn = self.reader();
        let (table, step_filter) = if step == StatsStep::Day {
            ("daily", "")
        } else {
            ("traffic", "AND x.step = ?4")
        };
        let order = if by_upload {
            "up DESC, down DESC"
        } else {
            "down DESC, up DESC"
        };
        let sql = format!(
            "SELECT tr.id, tr.hash, tr.name, tr.removed, sum(x.downloaded) AS down,
                 sum(x.uploaded) AS up
             FROM {table} x JOIN torrents tr ON tr.id = x.torrent
             WHERE x.t BETWEEN ?1 AND ?2 {step_filter}
             GROUP BY x.torrent HAVING down > 0 OR up > 0
             ORDER BY {order}, tr.hash LIMIT ?3"
        );
        let mut stmt = conn.prepare_cached(&sql).map_err(db_err)?;
        let map = |r: &rusqlite::Row<'_>| {
            Ok((
                TorrentRow {
                    id: r.get(0)?,
                    hash: r.get(1)?,
                    name: r.get(2)?,
                    removed: r.get(3)?,
                },
                Traffic {
                    downloaded: r.get(4)?,
                    uploaded: r.get(5)?,
                    peers_max: 0,
                    seeds_max: 0,
                },
            ))
        };
        let rows = if step == StatsStep::Day {
            stmt.query_map(params![from, to, limit], map)
        } else {
            stmt.query_map(params![from, to, limit, step.secs()], map)
        };
        rows.map_err(db_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_err)
    }

    /// Timeline events, newest first.
    pub fn timeline(
        &self,
        torrent: Option<i64>,
        from: u64,
        to: u64,
        limit: u32,
    ) -> io::Result<Vec<(EventRow, Option<String>)>> {
        let conn = self.reader();
        let mut stmt = conn
            .prepare_cached(
                "SELECT e.t, tr.hash, tr.name, e.kind, e.state, e.detail
                 FROM events e JOIN torrents tr ON tr.id = e.torrent
                 WHERE (?1 IS NULL OR e.torrent = ?1) AND e.t BETWEEN ?2 AND ?3
                 ORDER BY e.t DESC, e.id DESC LIMIT ?4",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![torrent, from, to, limit], |r| {
                Ok((
                    r.get::<_, u64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Option<String>>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (t, hash, name, kind, state, detail) = row.map_err(db_err)?;
            // A kind this daemon does not know (a newer one wrote it) is skipped.
            let Some(kind) = untag::<TimelineKind>(&kind) else {
                continue;
            };
            let state = state.and_then(|s| untag::<TorrentState>(&s));
            out.push((
                EventRow {
                    t,
                    hash,
                    kind,
                    state,
                    detail,
                },
                name,
            ));
        }
        Ok(out)
    }

    /// Recording periods overlapping a range, oldest first.
    pub fn periods(&self, from: u64, to: u64) -> io::Result<Vec<Period>> {
        let conn = self.reader();
        let mut stmt = conn
            .prepare_cached(
                "SELECT id, started, last_seen, stopped FROM periods
                 WHERE started <= ?2 AND last_seen >= ?1 ORDER BY started",
            )
            .map_err(db_err)?;
        stmt.query_map(params![from, to], |r| {
            Ok(Period {
                id: r.get(0)?,
                started: r.get(1)?,
                last_seen: r.get(2)?,
                stopped: r.get(3)?,
            })
        })
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)
    }

    /// Peer traffic by place over a range, ranked; `(key, downloaded,
    /// uploaded, most peers in one bucket)`. `torrent` `None` = all.
    #[allow(clippy::too_many_arguments)]
    pub fn places(
        &self,
        torrent: Option<i64>,
        step: StatsStep,
        dim: &str,
        from: u64,
        to: u64,
        by_upload: bool,
        limit: u32,
    ) -> io::Result<Vec<(String, u64, u64, u32)>> {
        let conn = self.reader();
        let order = if by_upload {
            "up DESC, down DESC"
        } else {
            "down DESC, up DESC"
        };
        let sql = format!(
            "SELECT key, sum(d) AS down, sum(u) AS up, max(p) FROM (
                 SELECT key, t, sum(downloaded) AS d, sum(uploaded) AS u, sum(peers) AS p
                 FROM peer_traffic
                 WHERE step = ?1 AND dim = ?2 AND t BETWEEN ?3 AND ?4
                   AND (?5 IS NULL OR torrent = ?5)
                 GROUP BY key, t)
             GROUP BY key ORDER BY {order}, key LIMIT ?6"
        );
        let mut stmt = conn.prepare_cached(&sql).map_err(db_err)?;
        stmt.query_map(params![step.secs(), dim, from, to, torrent, limit], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)
    }

    /// The buckets of some places; `(t, key, downloaded, uploaded, peers)`,
    /// oldest first.
    pub fn place_series(
        &self,
        torrent: Option<i64>,
        step: StatsStep,
        dim: &str,
        from: u64,
        to: u64,
        keys: &[String],
    ) -> io::Result<Vec<(u64, String, PeerTraffic)>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.reader();
        let wanted = serde_json::to_string(keys).unwrap_or_else(|_| "[]".into());
        let mut stmt = conn
            .prepare_cached(
                "SELECT t, key, sum(downloaded), sum(uploaded), sum(peers) FROM peer_traffic
                 WHERE step = ?1 AND dim = ?2 AND t BETWEEN ?3 AND ?4
                   AND (?5 IS NULL OR torrent = ?5)
                   AND key IN (SELECT value FROM json_each(?6))
                 GROUP BY t, key ORDER BY t, key",
            )
            .map_err(db_err)?;
        stmt.query_map(params![step.secs(), dim, from, to, torrent, wanted], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                PeerTraffic {
                    downloaded: r.get(2)?,
                    uploaded: r.get(3)?,
                    peers: r.get(4)?,
                },
            ))
        })
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)
    }

    /// Bytes attributed to peers (all places) and the torrents' traffic,
    /// over a range: `((down, up), (down, up))`.
    pub fn attribution(
        &self,
        torrent: Option<i64>,
        step: StatsStep,
        dim: &str,
        from: u64,
        to: u64,
    ) -> io::Result<((u64, u64), (u64, u64))> {
        let conn = self.reader();
        let attributed = conn
            .query_row(
                "SELECT coalesce(sum(downloaded), 0), coalesce(sum(uploaded), 0) FROM peer_traffic
                 WHERE step = ?1 AND dim = ?2 AND t BETWEEN ?3 AND ?4
                   AND (?5 IS NULL OR torrent = ?5)",
                params![step.secs(), dim, from, to, torrent],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .map_err(db_err)?;
        let traffic = if step == StatsStep::Day {
            conn.query_row(
                "SELECT coalesce(sum(downloaded), 0), coalesce(sum(uploaded), 0) FROM daily
                 WHERE t BETWEEN ?1 AND ?2 AND (?3 IS NULL OR torrent = ?3)",
                params![from, to, torrent],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        } else {
            conn.query_row(
                "SELECT coalesce(sum(downloaded), 0), coalesce(sum(uploaded), 0) FROM traffic
                 WHERE step = ?1 AND t BETWEEN ?2 AND ?3 AND (?4 IS NULL OR torrent = ?4)",
                params![step.secs(), from, to, torrent],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
        }
        .map_err(db_err)?;
        Ok((attributed, traffic))
    }

    /// The traffic table of a step and its filter (`:step`).
    fn source(step: StatsStep) -> (&'static str, &'static str) {
        if step == StatsStep::Day {
            ("daily", "")
        } else {
            ("traffic", "AND x.step = :step")
        }
    }

    /// The group key and join: category, or tag (one row per tag; `NULL`
    /// for none).
    fn group_key(tags: bool) -> (&'static str, &'static str) {
        if tags {
            (
                "j.value",
                "LEFT JOIN json_each(coalesce(tr.tags, '[]')) AS j ON 1",
            )
        } else {
            ("tr.category", "")
        }
    }

    /// Torrents' traffic by category (`tags` false) or tag, by the
    /// membership last recorded, ranked: `(key, down, up, torrents)`; `None`
    /// = no category / no tag.
    pub fn groups(
        &self,
        tags: bool,
        step: StatsStep,
        from: u64,
        to: u64,
        by_upload: bool,
        limit: u32,
    ) -> io::Result<Vec<KeyTotals>> {
        let conn = self.reader();
        let (table, step_filter) = Self::source(step);
        let (key, join) = Self::group_key(tags);
        let order = if by_upload {
            "up DESC, down DESC"
        } else {
            "down DESC, up DESC"
        };
        let sql = format!(
            "SELECT {key} AS k, sum(x.downloaded) AS down, sum(x.uploaded) AS up,
                 count(DISTINCT x.torrent)
             FROM {table} x JOIN torrents tr ON tr.id = x.torrent {join}
             WHERE x.t BETWEEN :from AND :to {step_filter}
             GROUP BY k HAVING down > 0 OR up > 0
             ORDER BY {order}, k LIMIT :limit"
        );
        let secs = step.secs();
        let mut p: Vec<(&str, &dyn rusqlite::ToSql)> =
            vec![(":from", &from), (":to", &to), (":limit", &limit)];
        if !step_filter.is_empty() {
            p.push((":step", &secs));
        }
        let mut stmt = conn.prepare_cached(&sql).map_err(db_err)?;
        stmt.query_map(p.as_slice(), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)
    }

    /// The buckets of some groups: `(t, key, down, up)`, oldest first.
    pub fn group_series(
        &self,
        tags: bool,
        step: StatsStep,
        from: u64,
        to: u64,
        keys: &[Option<String>],
    ) -> io::Result<Vec<KeyBucket>> {
        if keys.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.reader();
        let (table, step_filter) = Self::source(step);
        let (key, join) = Self::group_key(tags);
        let named: Vec<&String> = keys.iter().flatten().collect();
        let wanted = serde_json::to_string(&named).unwrap_or_else(|_| "[]".into());
        let none = keys.iter().any(Option::is_none);
        let sql = format!(
            "SELECT x.t, {key} AS k, sum(x.downloaded), sum(x.uploaded)
             FROM {table} x JOIN torrents tr ON tr.id = x.torrent {join}
             WHERE x.t BETWEEN :from AND :to {step_filter}
               AND (k IN (SELECT value FROM json_each(:keys)) OR (:none AND k IS NULL))
             GROUP BY x.t, k ORDER BY x.t, k"
        );
        let secs = step.secs();
        let mut p: Vec<(&str, &dyn rusqlite::ToSql)> = vec![
            (":from", &from),
            (":to", &to),
            (":keys", &wanted),
            (":none", &none),
        ];
        if !step_filter.is_empty() {
            p.push((":step", &secs));
        }
        let mut stmt = conn.prepare_cached(&sql).map_err(db_err)?;
        stmt.query_map(p.as_slice(), |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(db_err)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(db_err)
    }

    /// Per tracker host over a range: the torrents' traffic by the tracker
    /// they last worked with, `(host, down, up, torrents)` (`None` = no
    /// working tracker recorded), and the announces, `(host, replies,
    /// errors)`.
    pub fn trackers(
        &self,
        step: StatsStep,
        from: u64,
        to: u64,
    ) -> io::Result<(Vec<KeyTotals>, Vec<HostAnnounces>)> {
        let conn = self.reader();
        let (table, step_filter) = Self::source(step);
        let sql = format!(
            "SELECT tr.tracker, sum(x.downloaded), sum(x.uploaded), count(DISTINCT x.torrent)
             FROM {table} x JOIN torrents tr ON tr.id = x.torrent
             WHERE x.t BETWEEN :from AND :to {step_filter}
             GROUP BY tr.tracker"
        );
        let secs = step.secs();
        let mut p: Vec<(&str, &dyn rusqlite::ToSql)> = vec![(":from", &from), (":to", &to)];
        if !step_filter.is_empty() {
            p.push((":step", &secs));
        }
        let mut stmt = conn.prepare_cached(&sql).map_err(db_err)?;
        let traffic = stmt
            .query_map(p.as_slice(), |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .map_err(db_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_err)?;
        let mut stmt = conn
            .prepare_cached(
                "SELECT host, sum(replies), sum(errors) FROM announces
                 WHERE step = ?1 AND t BETWEEN ?2 AND ?3 GROUP BY host",
            )
            .map_err(db_err)?;
        let announces = stmt
            .query_map(params![step.secs(), from, to], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .map_err(db_err)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(db_err)?;
        Ok((traffic, announces))
    }

    /// The buckets of some trackers (`None` = no working tracker), oldest
    /// first: the traffic of the torrents working with each, and its
    /// announces.
    pub fn tracker_series(
        &self,
        step: StatsStep,
        from: u64,
        to: u64,
        hosts: &[Option<String>],
    ) -> io::Result<Vec<HostBucket>> {
        if hosts.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.reader();
        let (table, step_filter) = Self::source(step);
        let named: Vec<&String> = hosts.iter().flatten().collect();
        let wanted = serde_json::to_string(&named).unwrap_or_else(|_| "[]".into());
        let none = hosts.iter().any(Option::is_none);
        let sql = format!(
            "SELECT x.t, tr.tracker AS k, sum(x.downloaded), sum(x.uploaded)
             FROM {table} x JOIN torrents tr ON tr.id = x.torrent
             WHERE x.t BETWEEN :from AND :to {step_filter}
               AND (k IN (SELECT value FROM json_each(:keys)) OR (:none AND k IS NULL))
             GROUP BY x.t, k"
        );
        let secs = step.secs();
        let mut p: Vec<(&str, &dyn rusqlite::ToSql)> = vec![
            (":from", &from),
            (":to", &to),
            (":keys", &wanted),
            (":none", &none),
        ];
        if !step_filter.is_empty() {
            p.push((":step", &secs));
        }
        let mut out: BTreeMap<(u64, Option<String>), HostBucket> = BTreeMap::new();
        let mut stmt = conn.prepare_cached(&sql).map_err(db_err)?;
        let traffic = stmt
            .query_map(p.as_slice(), |r| {
                Ok((
                    r.get::<_, u64>(0)?,
                    r.get::<_, Option<String>>(1)?,
                    r.get::<_, u64>(2)?,
                    r.get::<_, u64>(3)?,
                ))
            })
            .map_err(db_err)?;
        for row in traffic {
            let (t, k, down, up) = row.map_err(db_err)?;
            out.insert((t, k.clone()), (t, k, down, up, 0, 0));
        }
        let mut stmt = conn
            .prepare_cached(
                "SELECT t, host, replies, errors FROM announces
                 WHERE step = ?1 AND t BETWEEN ?2 AND ?3
                   AND host IN (SELECT value FROM json_each(?4))",
            )
            .map_err(db_err)?;
        let announces = stmt
            .query_map(params![step.secs(), from, to, wanted], |r| {
                Ok((
                    r.get::<_, u64>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, u64>(2)?,
                    r.get::<_, u64>(3)?,
                ))
            })
            .map_err(db_err)?;
        for row in announces {
            let (t, host, replies, errors) = row.map_err(db_err)?;
            let k = Some(host);
            let b = out.entry((t, k.clone())).or_insert((t, k, 0, 0, 0, 0));
            b.4 += replies;
            b.5 += errors;
        }
        Ok(out.into_values().collect())
    }

    /// Per torrent (hex hash), the bytes uploaded and seconds seeding on the
    /// days starting at or after `from`.
    pub fn seeding_since(&self, from: u64) -> io::Result<HashMap<String, (u64, u64)>> {
        let conn = self.reader();
        let mut stmt = conn
            .prepare_cached(
                "SELECT tr.hash, sum(x.uploaded), sum(x.seeding_time)
                 FROM daily x JOIN torrents tr ON tr.id = x.torrent
                 WHERE x.t >= ?1 GROUP BY x.torrent",
            )
            .map_err(db_err)?;
        let rows = stmt
            .query_map(params![from], |r| Ok((r.get(0)?, (r.get(1)?, r.get(2)?))))
            .map_err(db_err)?;
        rows.collect::<rusqlite::Result<HashMap<_, _>>>()
            .map_err(db_err)
    }

    /// When recording first started (the oldest period kept).
    pub fn first_recorded(&self) -> io::Result<Option<u64>> {
        self.reader()
            .query_row("SELECT min(started) FROM periods", [], |r| r.get(0))
            .map_err(db_err)
    }

    /// Names of autonomous systems.
    pub fn asn_names(&self, asns: &[u32]) -> io::Result<HashMap<u32, String>> {
        let conn = self.reader();
        let mut stmt = conn
            .prepare_cached("SELECT name FROM asns WHERE asn = ?1")
            .map_err(db_err)?;
        let mut out = HashMap::new();
        for asn in asns {
            if let Some(name) = stmt
                .query_row(params![asn], |r| r.get::<_, String>(0))
                .optional()
                .map_err(db_err)?
            {
                out.insert(*asn, name);
            }
        }
        Ok(out)
    }

    /// Size and coverage.
    pub fn info(&self) -> io::Result<Info> {
        let conn = self.reader();
        let pages: u64 = conn
            .pragma_query_value(None, "page_count", |r| r.get(0))
            .map_err(db_err)?;
        let page_size: u64 = conn
            .pragma_query_value(None, "page_size", |r| r.get(0))
            .map_err(db_err)?;
        let (torrents, removed): (u64, u64) = conn
            .query_row("SELECT count(*), count(removed) FROM torrents", [], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .map_err(db_err)?;
        let mut oldest = [None; 3];
        for (i, step) in StatsStep::ALL.into_iter().enumerate() {
            oldest[i] = conn
                .query_row(
                    "SELECT min(t) FROM session WHERE step = ?1",
                    params![step.secs()],
                    |r| r.get(0),
                )
                .map_err(db_err)?;
        }
        Ok(Info {
            size: pages.saturating_mul(page_size),
            torrents,
            removed,
            oldest,
        })
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    const H1: &str = "1111111111111111111111111111111111111111";
    const H2: &str = "2222222222222222222222222222222222222222";

    fn traffic(down: u64, up: u64, peers: u32) -> Traffic {
        Traffic {
            downloaded: down,
            uploaded: up,
            peers_max: peers,
            seeds_max: 0,
        }
    }

    fn meta(name: &str) -> HashMap<String, Meta> {
        [(
            H1.to_string(),
            Meta {
                name: Some(name.to_string()),
                size: Some(100),
                ..Default::default()
            },
        )]
        .into()
    }

    #[test]
    fn writes_add_up_and_prune_by_retention() {
        let dir = tempfile::tempdir().unwrap();
        let db = StatsDb::open(dir.path()).unwrap();
        let p = db.start_period(1_000).unwrap();
        // Two flushes of the same minute and hour add up; maxima stay maxima.
        for (down, up, peers) in [(10, 5, 3), (7, 1, 2)] {
            let b = Batch {
                period: Some((p, 1_100)),
                meta: meta("one"),
                traffic: vec![
                    (
                        H1.into(),
                        StatsStep::Minute,
                        1_020,
                        traffic(down, up, peers),
                    ),
                    (H1.into(), StatsStep::Hour, 0, traffic(down, up, peers)),
                ],
                ..Default::default()
            };
            db.write(&b).unwrap();
        }
        let t = db.torrent(H1).unwrap().unwrap();
        assert_eq!(t.name.as_deref(), Some("one"));
        assert_eq!(
            db.traffic(t.id, StatsStep::Minute, 0, 5_000).unwrap(),
            vec![(1_020, traffic(17, 6, 3))]
        );
        assert_eq!(
            db.traffic(t.id, StatsStep::Hour, 0, 5_000).unwrap(),
            vec![(0, traffic(17, 6, 3))]
        );
        // Days: sums for traffic and time, the last totals, swarm maxima.
        let day = |up: u64, active: u64, total: u64, swarm: Option<u32>| Day {
            traffic: traffic(0, up, 1),
            active_time: active,
            seeding_time: active,
            totals: Totals {
                uploaded: total,
                ratio: Some(total as f64 / 100.0),
                ..Default::default()
            },
            swarm_seeds_max: swarm,
            swarm_leechers_max: None,
            swarm_completed_max: None,
        };
        for d in [day(5, 60, 105, Some(4)), day(1, 30, 106, None)] {
            db.write(&Batch {
                days: vec![(H1.into(), 0, d)],
                ..Default::default()
            })
            .unwrap();
        }
        let days = db.days(t.id, 0, 0).unwrap();
        assert_eq!(days.len(), 1);
        let d = days[0].1;
        assert_eq!(d.traffic.uploaded, 6);
        assert_eq!(d.active_time, 90);
        assert_eq!(d.totals.uploaded, 106);
        assert_eq!(d.totals.ratio, Some(1.06));
        assert_eq!(d.swarm_seeds_max, Some(4));
        assert_eq!(d.swarm_leechers_max, None);

        // Ranking over whichever step.
        db.write(&Batch {
            traffic: vec![(H2.into(), StatsStep::Hour, 3_600, traffic(0, 50, 1))],
            ..Default::default()
        })
        .unwrap();
        let top = db.top(StatsStep::Hour, 0, 7_200, true, 10).unwrap();
        assert_eq!(
            top.iter()
                .map(|(t, x)| (t.hash.as_str(), x.uploaded))
                .collect::<Vec<_>>(),
            vec![(H2, 50), (H1, 6)]
        );
        let top = db.top(StatsStep::Hour, 0, 7_200, false, 1).unwrap();
        assert_eq!(top[0].0.hash, H1);

        // Minutes go after their retention, hours and days stay.
        let r = Retention {
            minute: Some(3_000),
            hour: Some(100_000),
            day: None,
        };
        assert_eq!(db.prune(4_100, &r).unwrap(), 1);
        assert!(
            db.traffic(t.id, StatsStep::Minute, 0, 5_000)
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            db.traffic(t.id, StatsStep::Hour, 0, 5_000).unwrap().len(),
            1
        );
        assert_eq!(db.periods(0, 5_000).unwrap().len(), 1);
    }

    #[test]
    fn removed_torrents_keep_their_history_until_it_expires() {
        let dir = tempfile::tempdir().unwrap();
        let db = StatsDb::open(dir.path()).unwrap();
        let ev = |t, kind| EventRow {
            t,
            hash: H1.into(),
            kind,
            state: None,
            detail: None,
        };
        db.write(&Batch {
            meta: meta("gone"),
            days: vec![(H1.into(), 0, Day::default())],
            events: vec![
                ev(10, TimelineKind::Added),
                EventRow {
                    state: Some(TorrentState::Seeding),
                    ..ev(20, TimelineKind::State)
                },
                ev(30, TimelineKind::Removed),
            ],
            ..Default::default()
        })
        .unwrap();
        let t = db.torrent(H1).unwrap().unwrap();
        assert_eq!(t.removed, Some(30));
        let tl = db.timeline(Some(t.id), 0, 100, 10).unwrap();
        assert_eq!(
            tl.iter().map(|(e, _)| e.kind).collect::<Vec<_>>(),
            vec![
                TimelineKind::Removed,
                TimelineKind::State,
                TimelineKind::Added
            ]
        );
        assert_eq!(tl[1].0.state, Some(TorrentState::Seeding));
        assert_eq!(tl[0].1.as_deref(), Some("gone"));

        // Still referenced: kept. Once the history expires, the torrent goes.
        let r = Retention {
            day: Some(1_000),
            ..Default::default()
        };
        db.prune(500, &r).unwrap();
        assert!(db.torrent(H1).unwrap().is_some());
        db.prune(200_000, &r).unwrap();
        assert!(db.torrent(H1).unwrap().is_none());

        // Re-added: the same hash gets a new row and `removed` is cleared.
        db.write(&Batch {
            events: vec![ev(300_000, TimelineKind::Added)],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(db.torrent(H1).unwrap().unwrap().removed, None);
        assert!(db.purge(H1).unwrap());
        assert!(!db.purge(H1).unwrap());
        assert!(db.torrent(H1).unwrap().is_none());
    }

    #[test]
    fn tracker_hosts_never_keep_passkeys() {
        let h = |u: &str| tracker_host(u);
        assert_eq!(
            h("https://tracker.example.org/abcdef0123456789/announce").as_deref(),
            Some("tracker.example.org")
        );
        assert_eq!(
            h("udp://Tracker.Example.org:1337/announce").as_deref(),
            Some("tracker.example.org")
        );
        assert_eq!(
            h("http://user:pass@t.example:80/a?passkey=x").as_deref(),
            Some("t.example")
        );
        assert_eq!(
            h("http://[2001:db8::1]:6969/announce").as_deref(),
            Some("2001:db8::1")
        );
        assert_eq!(h("not a url"), None);
        assert_eq!(h("http:///announce"), None);
    }

    #[test]
    fn traffic_by_group_and_tracker() {
        let dir = tempfile::tempdir().unwrap();
        let db = StatsDb::open(dir.path()).unwrap();
        let meta = |cat: Option<&str>, tags: &[&str], tracker: &str| Meta {
            name: Some("x".into()),
            size: Some(1),
            groups: Some((
                cat.map(str::to_string),
                tags.iter().map(|t| t.to_string()).collect(),
            )),
            tracker: Some(tracker.into()),
        };
        let h3 = "3333333333333333333333333333333333333333";
        db.write(&Batch {
            meta: [
                (
                    H1.to_string(),
                    meta(Some("linux"), &["iso", "big"], "t.one"),
                ),
                (H2.to_string(), meta(Some("linux"), &["iso"], "t.two")),
                (h3.to_string(), meta(None, &[], "t.two")),
            ]
            .into(),
            traffic: vec![
                (H1.into(), StatsStep::Hour, 0, traffic(0, 10, 1)),
                (H2.into(), StatsStep::Hour, 0, traffic(5, 20, 1)),
                (h3.into(), StatsStep::Hour, 3_600, traffic(0, 1, 1)),
            ],
            announces: vec![
                ("t.one".into(), StatsStep::Hour, 0, 3, 1),
                ("t.gone".into(), StatsStep::Hour, 0, 0, 4),
            ],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            db.groups(false, StatsStep::Hour, 0, 7_200, true, 10)
                .unwrap(),
            vec![(Some("linux".into()), 5, 30, 2), (None, 0, 1, 1)]
        );
        assert_eq!(
            db.groups(true, StatsStep::Hour, 0, 7_200, true, 10)
                .unwrap(),
            vec![
                (Some("iso".into()), 5, 30, 2),
                (Some("big".into()), 0, 10, 1),
                (None, 0, 1, 1)
            ]
        );
        let series = db
            .group_series(true, StatsStep::Hour, 0, 7_200, &[Some("big".into()), None])
            .unwrap();
        assert_eq!(
            series,
            vec![(0, Some("big".into()), 0, 10), (3_600, None, 0, 1)]
        );
        let (by_tracker, announces) = db.trackers(StatsStep::Hour, 0, 7_200).unwrap();
        let mut by_tracker = by_tracker;
        by_tracker.sort();
        assert_eq!(
            by_tracker,
            vec![
                (Some("t.one".into()), 0, 10, 1),
                (Some("t.two".into()), 5, 21, 2)
            ]
        );
        let mut announces = announces;
        announces.sort();
        assert_eq!(
            announces,
            vec![("t.gone".into(), 0, 4), ("t.one".into(), 3, 1)]
        );
        // A category change moves the torrent's history with it.
        db.write(&Batch {
            meta: [(H2.to_string(), meta(Some("iso"), &[], "t.two"))].into(),
            traffic: vec![(H2.into(), StatsStep::Hour, 0, traffic(0, 0, 0))],
            ..Default::default()
        })
        .unwrap();
        assert_eq!(
            db.groups(false, StatsStep::Hour, 0, 7_200, true, 1)
                .unwrap(),
            vec![(Some("iso".into()), 5, 20, 1)]
        );
    }

    #[test]
    fn a_version_1_database_is_migrated() {
        let dir = tempfile::tempdir().unwrap();
        {
            let c = Connection::open(dir.path().join(STATS_DB_FILE)).unwrap();
            c.execute_batch(SCHEMA_V1).unwrap();
            c.pragma_update(None, "user_version", 1).unwrap();
            c.execute(
                "INSERT INTO torrents (hash, name, size) VALUES (?1, 'old', 1)",
                params![H1],
            )
            .unwrap();
        }
        let db = StatsDb::open(dir.path()).unwrap();
        assert_eq!(
            db.torrent(H1).unwrap().unwrap().name.as_deref(),
            Some("old")
        );
        db.write(&Batch {
            peer_traffic: vec![(
                H1.into(),
                StatsStep::Hour,
                3_600,
                "country",
                "NZ".into(),
                PeerTraffic {
                    downloaded: 1,
                    uploaded: 2,
                    peers: 1,
                },
            )],
            asns: vec![(64_500, "Test Net".into())],
            ..Default::default()
        })
        .unwrap();
        let t = db.torrent(H1).unwrap().unwrap();
        assert_eq!(
            db.places(Some(t.id), StatsStep::Hour, "country", 0, 7_200, true, 10)
                .unwrap(),
            vec![("NZ".to_string(), 1, 2, 1)]
        );
        assert_eq!(db.asn_names(&[64_500]).unwrap()[&64_500], "Test Net");
    }

    #[test]
    fn a_newer_schema_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        {
            let c = Connection::open(dir.path().join(STATS_DB_FILE)).unwrap();
            c.pragma_update(None, "user_version", 99).unwrap();
        }
        let e = StatsDb::open(dir.path()).err().unwrap();
        assert!(e.to_string().contains("schema version 99"), "{e}");
    }
}
