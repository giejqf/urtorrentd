// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Persistent state: one SQLite database, `<data dir>/urtorrentd.db`
//! (ADR 0004). WAL mode, `synchronous = FULL`, one transaction per change
//! set, so a bulk action over thousands of torrents is one commit.
//!
//! ```text
//! state        key -> value: settings, auth, totals (JSON), dht (library bytes)
//! categories   name, save_path, download_path
//! tags         name
//! torrents     hash, record (JSON), metainfo (.torrent), resume (library
//!              resume data, opaque), added (insertion order)
//! ```
//!
//! The schema version is SQLite's `user_version`; [`Store::open`] migrates
//! from any version this daemon ever wrote, and imports a 0.1.0 data
//! directory (JSON files) once. All functions here block; async callers go
//! through `util::blocking`.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rusqlite::{Connection, OptionalExtension, params};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::settings::ShareLimitAction;

/// Current record format (inside the `record` JSON).
pub const RECORD_FORMAT: u32 = 2;
/// Current schema version (`PRAGMA user_version`).
pub const SCHEMA_VERSION: i64 = 2;
/// The database file inside the data directory.
pub const DB_FILE: &str = "urtorrentd.db";

/// A per-torrent ratio limit.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case", tag = "mode", content = "value")]
pub enum RatioLimit {
    /// Use the global setting.
    #[default]
    Global,
    /// No limit for this torrent.
    Unlimited,
    /// This ratio.
    Limit(f64),
}

/// A per-torrent time limit (seconds).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case", tag = "mode", content = "value")]
pub enum TimeLimit {
    /// Use the global setting.
    #[default]
    Global,
    /// No limit for this torrent.
    Unlimited,
    /// This many seconds.
    Limit(u64),
}

/// A torrent's share limits.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize, ToSchema)]
pub struct ShareLimits {
    /// Ratio limit.
    #[serde(default)]
    #[schema(required = true)]
    pub ratio: RatioLimit,
    /// Seeding time limit.
    #[serde(default)]
    #[schema(required = true)]
    pub seeding_time: TimeLimit,
    /// Inactive seeding time limit.
    #[serde(default)]
    #[schema(required = true)]
    pub inactive_seeding_time: TimeLimit,
    /// The action; `null` = the global `share_limit_action`.
    #[serde(default)]
    #[schema(required = true)]
    pub action: Option<ShareLimitAction>,
}

/// Stop a torrent automatically once it reaches a point.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum StopCondition {
    /// Never.
    #[default]
    None,
    /// When its metadata is known (a `.torrent` is added stopped; a magnet
    /// stops when the metadata arrives).
    MetadataReceived,
    /// When the initial check of the files has finished.
    FilesChecked,
}

/// What the daemon keeps about a torrent beyond the metainfo and the
/// library's resume data (which holds the have-set, counters, activity
/// times, queue position, trackers, priorities and per-torrent settings).
/// Fields that format 1 had and the library now keeps (`sequential`,
/// `queue_position`, `last_activity`, `seen_complete`) are ignored on load.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TorrentRecord {
    /// Format version of this record.
    pub format: u32,
    /// Lowercase hex info-hash.
    pub info_hash: String,
    /// The magnet link, until the metadata has arrived.
    #[serde(default)]
    pub magnet: Option<String>,
    /// Where the content belongs (its final location).
    pub save_path: String,
    /// Where the content lives until the download finishes, if not the save path.
    #[serde(default)]
    pub download_path: Option<String>,
    /// Stopped by the user or a policy (not merely queued).
    #[serde(default)]
    pub stopped: bool,
    /// Category.
    #[serde(default)]
    pub category: Option<String>,
    /// Tags.
    #[serde(default)]
    pub tags: BTreeSet<String>,
    /// Display-name override.
    #[serde(default)]
    pub name: Option<String>,
    /// Comment override.
    #[serde(default)]
    pub comment: Option<String>,
    /// Automatic management: the save path follows the category.
    #[serde(default)]
    pub auto_management: bool,
    /// The first and last pieces of each wanted file come first.
    #[serde(default)]
    pub first_last_piece_priority: bool,
    /// Share limits.
    #[serde(default)]
    pub share_limits: ShareLimits,
    /// The URL the torrent was added from.
    #[serde(default)]
    pub source_url: Option<String>,
    /// A stop condition still waiting to fire.
    #[serde(default)]
    pub stop_condition: StopCondition,
    /// The top-level layout still to apply once a magnet's metadata arrives.
    #[serde(default)]
    pub content_layout: crate::model::ContentLayout,
    /// A magnet whose files are matched against `excluded_file_names` when
    /// its metadata arrives (the setting was on when it was added).
    #[serde(default)]
    pub exclude_files: bool,
}

/// A category.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
pub struct Category {
    /// Save path for its automatically managed torrents: absolute, or relative
    /// to the default save path; `null` = `<default save path>/<category name>`.
    #[serde(default)]
    #[schema(required = true)]
    pub save_path: Option<String>,
    /// Download path for its automatically managed torrents (absolute or
    /// relative to the default download path); `null` = the global download path.
    #[serde(default)]
    #[schema(required = true)]
    pub download_path: Option<String>,
}

/// All-time transfer counters.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize)]
pub struct Totals {
    /// Payload bytes downloaded, across runs.
    pub downloaded: u64,
    /// Payload bytes uploaded, across runs.
    pub uploaded: u64,
}

/// A torrent as stored.
#[derive(Debug, Clone)]
pub struct StoredTorrent {
    /// The daemon's record.
    pub record: TorrentRecord,
    /// The `.torrent`, once known.
    pub metainfo: Option<Vec<u8>>,
    /// The library's resume data, once saved.
    pub resume: Option<Vec<u8>>,
}

/// Categories as stored.
pub type Categories = BTreeMap<String, Category>;
/// Tags as stored.
pub type Tags = BTreeSet<String>;

/// Keys of the `state` table.
pub const SETTINGS: &str = "settings";
/// Credentials key.
pub const AUTH: &str = "auth";
/// Totals key.
pub const TOTALS: &str = "totals";
/// Key of the webhooks in `state`.
pub const WEBHOOKS: &str = "webhooks";
/// Key of the cookie jar in `state`.
pub const COOKIES: &str = "cookies";
const DHT: &str = "dht";

pub(crate) fn db_err(e: rusqlite::Error) -> io::Error {
    io::Error::other(format!("database: {e}"))
}

fn json_err(e: serde_json::Error) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e)
}

/// The database.
#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
    conn: Arc<Mutex<Connection>>,
    imported: usize,
}

impl Store {
    /// Open (create, migrate) the database in `root`, importing a 0.1.0
    /// data directory the first time.
    pub fn open(root: impl Into<PathBuf>) -> io::Result<Store> {
        let root = root.into();
        std::fs::create_dir_all(&root)?;
        let path = root.join(DB_FILE);
        let fresh = !path.exists();
        let mut conn = Connection::open(&path).map_err(db_err)?;
        conn.pragma_update(None, "journal_mode", "WAL")
            .map_err(db_err)?;
        conn.pragma_update(None, "synchronous", "FULL")
            .map_err(db_err)?;
        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(db_err)?;
        migrate(&mut conn)?;
        let mut store = Store {
            root,
            conn: Arc::new(Mutex::new(conn)),
            imported: 0,
        };
        if fresh {
            store.imported = crate::store::legacy::import(&store)?;
        }
        Ok(store)
    }

    /// The data directory.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Torrents imported from a 0.1.0 data directory by this `open`.
    pub fn imported(&self) -> usize {
        self.imported
    }

    fn conn(&self) -> MutexGuard<'_, Connection> {
        self.conn.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn get_state(&self, key: &str) -> io::Result<Option<Vec<u8>>> {
        self.conn()
            .query_row("SELECT value FROM state WHERE key = ?1", [key], |r| {
                r.get::<_, Vec<u8>>(0)
            })
            .optional()
            .map_err(db_err)
    }

    fn put_state(&self, key: &str, value: &[u8]) -> io::Result<()> {
        self.conn()
            .execute(
                "INSERT INTO state (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![key, value],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// A JSON value of the `state` table; `None` if absent.
    pub fn load<T: DeserializeOwned>(&self, key: &str) -> io::Result<Option<T>> {
        match self.get_state(key)? {
            Some(b) => serde_json::from_slice(&b).map(Some).map_err(json_err),
            None => Ok(None),
        }
    }

    /// Store a JSON value in the `state` table.
    pub fn save<T: Serialize>(&self, key: &str, value: &T) -> io::Result<()> {
        let bytes = serde_json::to_vec(value).map_err(json_err)?;
        self.put_state(key, &bytes)
    }

    /// The DHT state, if saved.
    pub fn load_dht(&self) -> io::Result<Option<Vec<u8>>> {
        self.get_state(DHT)
    }

    /// Save the DHT state.
    pub fn save_dht(&self, bytes: &[u8]) -> io::Result<()> {
        self.put_state(DHT, bytes)
    }

    /// The categories.
    pub fn categories(&self) -> io::Result<Categories> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT name, save_path, download_path FROM categories")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    Category {
                        save_path: r.get(1)?,
                        download_path: r.get(2)?,
                    },
                ))
            })
            .map_err(db_err)?;
        rows.collect::<Result<Categories, _>>().map_err(db_err)
    }

    /// Replace the categories.
    pub fn save_categories(&self, cats: &Categories) -> io::Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err)?;
        tx.execute("DELETE FROM categories", []).map_err(db_err)?;
        for (name, c) in cats {
            tx.execute(
                "INSERT INTO categories (name, save_path, download_path) VALUES (?1, ?2, ?3)",
                params![name, c.save_path, c.download_path],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)
    }

    /// The tags.
    pub fn tags(&self) -> io::Result<Tags> {
        let conn = self.conn();
        let mut stmt = conn.prepare("SELECT name FROM tags").map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(db_err)?;
        rows.collect::<Result<Tags, _>>().map_err(db_err)
    }

    /// Replace the tags.
    pub fn save_tags(&self, tags: &Tags) -> io::Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err)?;
        tx.execute("DELETE FROM tags", []).map_err(db_err)?;
        for t in tags {
            tx.execute("INSERT INTO tags (name) VALUES (?1)", [t])
                .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)
    }

    /// Every torrent, in the order they were added. Records that do not
    /// parse come back as errors next to their hash.
    pub fn load_torrents(&self) -> io::Result<Vec<Result<StoredTorrent, String>>> {
        let conn = self.conn();
        let mut stmt = conn
            .prepare("SELECT hash, record, metainfo, resume FROM torrents ORDER BY added")
            .map_err(db_err)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<Vec<u8>>>(2)?,
                    r.get::<_, Option<Vec<u8>>>(3)?,
                ))
            })
            .map_err(db_err)?;
        let mut out = Vec::new();
        for row in rows {
            let (hash, record, metainfo, resume) = row.map_err(db_err)?;
            out.push(match serde_json::from_str::<TorrentRecord>(&record) {
                Ok(record) => Ok(StoredTorrent {
                    record,
                    metainfo,
                    resume,
                }),
                Err(e) => Err(format!("{hash}: {e}")),
            });
        }
        Ok(out)
    }

    /// Store a new torrent (replacing any old row for the same info-hash,
    /// resume data included).
    pub fn insert_torrent(
        &self,
        record: &TorrentRecord,
        metainfo: Option<&[u8]>,
    ) -> io::Result<()> {
        let json = serde_json::to_string(record).map_err(json_err)?;
        self.conn()
            .execute(
                "INSERT OR REPLACE INTO torrents (hash, record, metainfo, resume, added)
                 VALUES (?1, ?2, ?3, NULL, (SELECT COALESCE(MAX(added), 0) + 1 FROM torrents))",
                params![record.info_hash, json, metainfo],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// Update records, in one transaction.
    pub fn save_records(&self, records: &[TorrentRecord]) -> io::Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err)?;
        for r in records {
            let json = serde_json::to_string(r).map_err(json_err)?;
            tx.execute(
                "UPDATE torrents SET record = ?2 WHERE hash = ?1",
                params![r.info_hash, json],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)
    }

    /// Store a torrent's `.torrent` (a magnet's metadata arrived).
    pub fn save_metainfo(&self, hash: &str, bytes: &[u8]) -> io::Result<()> {
        self.conn()
            .execute(
                "UPDATE torrents SET metainfo = ?2 WHERE hash = ?1",
                params![hash, bytes],
            )
            .map_err(db_err)?;
        Ok(())
    }

    /// Store resume data, in one transaction.
    pub fn save_resume(&self, items: &[(String, Vec<u8>)]) -> io::Result<()> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err)?;
        for (hash, bytes) in items {
            tx.execute(
                "UPDATE torrents SET resume = ?2 WHERE hash = ?1",
                params![hash, bytes],
            )
            .map_err(db_err)?;
        }
        tx.commit().map_err(db_err)
    }

    /// Forget a torrent.
    pub fn delete_torrent(&self, hash: &str) -> io::Result<()> {
        self.conn()
            .execute("DELETE FROM torrents WHERE hash = ?1", [hash])
            .map_err(db_err)?;
        Ok(())
    }

    /// Client data: the given keys (those present), or every key.
    pub fn client_data(
        &self,
        keys: Option<&[String]>,
    ) -> io::Result<BTreeMap<String, serde_json::Value>> {
        let conn = self.conn();
        let mut out = BTreeMap::new();
        let mut put = |k: String, v: String| {
            if let Ok(v) = serde_json::from_str(&v) {
                out.insert(k, v);
            }
        };
        match keys {
            Some(keys) => {
                let mut stmt = conn
                    .prepare_cached("SELECT value FROM client_data WHERE key = ?1")
                    .map_err(db_err)?;
                for k in keys {
                    if let Some(v) = stmt
                        .query_row([k], |r| r.get::<_, String>(0))
                        .optional()
                        .map_err(db_err)?
                    {
                        put(k.clone(), v);
                    }
                }
            }
            None => {
                let mut stmt = conn
                    .prepare_cached("SELECT key, value FROM client_data ORDER BY key")
                    .map_err(db_err)?;
                let rows = stmt
                    .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
                    .map_err(db_err)?;
                for row in rows {
                    let (k, v) = row.map_err(db_err)?;
                    put(k, v);
                }
            }
        }
        Ok(out)
    }

    /// Store client data (`null` removes a key), in one transaction that
    /// is undone (`InvalidInput`) if more than `max_keys` keys would remain.
    pub fn store_client_data(
        &self,
        changes: &BTreeMap<String, serde_json::Value>,
        max_keys: u64,
    ) -> io::Result<()> {
        self.transaction(|tx| {
            for (k, v) in changes {
                if v.is_null() {
                    tx.execute("DELETE FROM client_data WHERE key = ?1", [k])
                        .map_err(db_err)?;
                } else {
                    tx.execute(
                        "INSERT INTO client_data (key, value) VALUES (?1, ?2)
                         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        params![k, v.to_string()],
                    )
                    .map_err(db_err)?;
                }
            }
            let n: u64 = tx
                .query_row("SELECT count(*) FROM client_data", [], |r| r.get(0))
                .map_err(db_err)?;
            if n > max_keys {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("{max_keys} keys at most"),
                ));
            }
            Ok(())
        })
    }

    /// Read with the connection.
    pub(crate) fn read<T>(&self, f: impl FnOnce(&Connection) -> io::Result<T>) -> io::Result<T> {
        f(&self.conn())
    }

    /// Run `f` in one transaction.
    pub(crate) fn transaction<T>(
        &self,
        f: impl FnOnce(&rusqlite::Transaction<'_>) -> io::Result<T>,
    ) -> io::Result<T> {
        let mut conn = self.conn();
        let tx = conn.transaction().map_err(db_err)?;
        let out = f(&tx)?;
        tx.commit().map_err(db_err)?;
        Ok(out)
    }
}

/// Bring the schema to [`SCHEMA_VERSION`].
fn migrate(conn: &mut Connection) -> io::Result<()> {
    let version: i64 = conn
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(db_err)?;
    if version > SCHEMA_VERSION {
        return Err(io::Error::other(format!(
            "the database has schema version {version}, newer than this daemon's {SCHEMA_VERSION}"
        )));
    }
    let tx = conn.transaction().map_err(db_err)?;
    if version < 1 {
        tx.execute_batch(
            "CREATE TABLE state (key TEXT PRIMARY KEY, value BLOB NOT NULL);
             CREATE TABLE categories (name TEXT PRIMARY KEY, save_path TEXT, download_path TEXT);
             CREATE TABLE tags (name TEXT PRIMARY KEY);
             CREATE TABLE torrents (
                 hash TEXT PRIMARY KEY,
                 record TEXT NOT NULL,
                 metainfo BLOB,
                 resume BLOB,
                 added INTEGER NOT NULL
             );",
        )
        .map_err(db_err)?;
    }
    if version < 2 {
        // 0.10.0: RSS and the client data store.
        tx.execute_batch(
            "CREATE TABLE rss_folders (path TEXT PRIMARY KEY);
             CREATE TABLE rss_feeds (
                 id INTEGER PRIMARY KEY,
                 url TEXT NOT NULL UNIQUE,
                 name TEXT,
                 folder TEXT,
                 refresh_interval INTEGER,
                 title TEXT,
                 last_refresh INTEGER,
                 error TEXT,
                 etag TEXT,
                 last_modified TEXT
             );
             CREATE TABLE rss_articles (
                 feed INTEGER NOT NULL,
                 id TEXT NOT NULL,
                 seq INTEGER NOT NULL,
                 date INTEGER,
                 title TEXT NOT NULL,
                 link TEXT,
                 torrent_url TEXT,
                 description TEXT,
                 author TEXT,
                 size INTEGER,
                 read INTEGER NOT NULL DEFAULT 0,
                 downloaded INTEGER NOT NULL DEFAULT 0,
                 PRIMARY KEY (feed, id)
             );
             CREATE INDEX rss_articles_by_seq ON rss_articles (feed, seq);
             CREATE TABLE rss_rules (name TEXT PRIMARY KEY, rule TEXT NOT NULL);
             CREATE TABLE client_data (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
        )
        .map_err(db_err)?;
    }
    tx.pragma_update(None, "user_version", SCHEMA_VERSION)
        .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

/// Importing a 0.1.0 data directory (JSON files, torrents/, resume/).
mod legacy {
    use std::io;
    use std::path::Path;

    use rusqlite::params;

    use super::{Categories, Store, Tags, TorrentRecord, db_err, json_err};

    /// Where the imported files are moved.
    pub const IMPORTED_DIR: &str = "imported-0.1";

    fn read(path: &Path) -> io::Result<Option<Vec<u8>>> {
        match std::fs::read(path) {
            Ok(b) => Ok(Some(b)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }

    /// Import whatever a 0.1.0 daemon left in the data directory, in one
    /// transaction, then move those files to `imported-0.1/`. Returns the
    /// number of torrents imported.
    pub fn import(store: &Store) -> io::Result<usize> {
        let root = store.root().to_path_buf();
        let json_files = [
            "settings.json",
            "auth.json",
            "totals.json",
            "categories.json",
            "tags.json",
        ];
        let torrents_dir = root.join("torrents");
        let any = json_files.iter().any(|f| root.join(f).exists()) || torrents_dir.is_dir();
        if !any {
            return Ok(0);
        }
        let mut records = Vec::new();
        if torrents_dir.is_dir() {
            for entry in std::fs::read_dir(&torrents_dir)? {
                let path = entry?.path();
                if path.extension().is_some_and(|e| e == "json") {
                    let bytes = std::fs::read(&path)?;
                    let mut rec: TorrentRecord =
                        serde_json::from_slice(&bytes).map_err(json_err)?;
                    rec.format = super::RECORD_FORMAT;
                    let metainfo = read(&torrents_dir.join(format!("{}.torrent", rec.info_hash)))?;
                    let resume = read(
                        &root
                            .join("resume")
                            .join(format!("{}.resume", rec.info_hash)),
                    )?;
                    records.push((rec, metainfo, resume));
                }
            }
        }
        records.sort_by(|a, b| a.0.info_hash.cmp(&b.0.info_hash));
        let n = records.len();
        store.transaction(|tx| {
            for (key, file) in [
                (super::SETTINGS, "settings.json"),
                (super::AUTH, "auth.json"),
                (super::TOTALS, "totals.json"),
            ] {
                if let Some(b) = read(&root.join(file))? {
                    tx.execute(
                        "INSERT OR REPLACE INTO state (key, value) VALUES (?1, ?2)",
                        params![key, b],
                    )
                    .map_err(db_err)?;
                }
            }
            if let Some(b) = read(&root.join("dht.state"))? {
                tx.execute(
                    "INSERT OR REPLACE INTO state (key, value) VALUES (?1, ?2)",
                    params![super::DHT, b],
                )
                .map_err(db_err)?;
            }
            if let Some(b) = read(&root.join("categories.json"))? {
                let cats: Categories = serde_json::from_slice(&b).map_err(json_err)?;
                for (name, c) in cats {
                    tx.execute(
                        "INSERT OR REPLACE INTO categories (name, save_path, download_path) VALUES (?1, ?2, ?3)",
                        params![name, c.save_path, c.download_path],
                    )
                    .map_err(db_err)?;
                }
            }
            if let Some(b) = read(&root.join("tags.json"))? {
                let tags: Tags = serde_json::from_slice(&b).map_err(json_err)?;
                for t in tags {
                    tx.execute("INSERT OR REPLACE INTO tags (name) VALUES (?1)", [t])
                        .map_err(db_err)?;
                }
            }
            for (i, (rec, metainfo, resume)) in records.iter().enumerate() {
                let json = serde_json::to_string(rec).map_err(json_err)?;
                tx.execute(
                    "INSERT OR REPLACE INTO torrents (hash, record, metainfo, resume, added)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    params![rec.info_hash, json, metainfo, resume, i64::try_from(i).unwrap_or(i64::MAX)],
                )
                .map_err(db_err)?;
            }
            Ok(())
        })?;
        // Committed: move the old files aside (kept, not deleted).
        let dest = root.join(IMPORTED_DIR);
        std::fs::create_dir_all(&dest)?;
        for name in json_files
            .iter()
            .copied()
            .chain(["dht.state", "torrents", "resume"])
        {
            let from = root.join(name);
            if from.exists() {
                std::fs::rename(&from, dest.join(name))?;
            }
        }
        Ok(n)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn record(hash: &str) -> TorrentRecord {
        TorrentRecord {
            format: RECORD_FORMAT,
            info_hash: hash.into(),
            magnet: None,
            save_path: "/srv".into(),
            download_path: None,
            stopped: false,
            category: None,
            tags: BTreeSet::new(),
            name: None,
            comment: None,
            auto_management: false,
            first_last_piece_priority: false,
            share_limits: ShareLimits::default(),
            source_url: None,
            stop_condition: StopCondition::None,
            content_layout: crate::model::ContentLayout::Original,
            exclude_files: false,
        }
    }

    #[test]
    fn round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store
            .save("settings", &serde_json::json!({"a": 1}))
            .unwrap();
        assert_eq!(
            store.load::<serde_json::Value>("settings").unwrap(),
            Some(serde_json::json!({"a": 1}))
        );
        store.save_dht(b"dht").unwrap();
        let mut cats = Categories::new();
        cats.insert("tv".into(), Category::default());
        store.save_categories(&cats).unwrap();
        store
            .save_tags(&["x".to_string()].into_iter().collect())
            .unwrap();

        store.insert_torrent(&record("bb"), Some(b"meta")).unwrap();
        store.insert_torrent(&record("aa"), None).unwrap();
        let mut r = record("bb");
        r.stopped = true;
        store.save_records(&[r]).unwrap();
        store
            .save_resume(&[("bb".into(), b"resume".to_vec())])
            .unwrap();
        store.save_metainfo("aa", b"meta2").unwrap();
        drop(store);

        let store = Store::open(dir.path()).unwrap();
        assert_eq!(store.load_dht().unwrap(), Some(b"dht".to_vec()));
        assert!(store.categories().unwrap().contains_key("tv"));
        assert!(store.tags().unwrap().contains("x"));
        let ts: Vec<StoredTorrent> = store
            .load_torrents()
            .unwrap()
            .into_iter()
            .map(|t| t.unwrap())
            .collect();
        assert_eq!(ts.len(), 2);
        assert_eq!(ts[0].record.info_hash, "bb", "insertion order");
        assert!(ts[0].record.stopped);
        assert_eq!(ts[0].resume.as_deref(), Some(&b"resume"[..]));
        assert_eq!(ts[1].metainfo.as_deref(), Some(&b"meta2"[..]));
        store.delete_torrent("bb").unwrap();
        assert_eq!(store.load_torrents().unwrap().len(), 1);
    }

    #[test]
    fn imports_a_0_1_data_dir() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("torrents")).unwrap();
        std::fs::create_dir_all(root.join("resume")).unwrap();
        std::fs::write(root.join("settings.json"), br#"{"save_path": "/srv"}"#).unwrap();
        std::fs::write(root.join("tags.json"), br#"["old"]"#).unwrap();
        std::fs::write(
            root.join("categories.json"),
            br#"{"tv": {"save_path": "/tv", "download_path": null}}"#,
        )
        .unwrap();
        // A 0.1.0 record, with fields this version no longer keeps.
        std::fs::write(
            root.join("torrents/cc.json"),
            br#"{"format": 1, "info_hash": "cc", "save_path": "/srv", "stopped": true,
                 "sequential": true, "queue_position": 3, "last_activity": 5}"#,
        )
        .unwrap();
        std::fs::write(root.join("torrents/cc.torrent"), b"meta").unwrap();
        std::fs::write(root.join("resume/cc.resume"), b"resume").unwrap();

        let store = Store::open(root).unwrap();
        assert_eq!(store.imported(), 1);
        assert_eq!(
            store.load::<serde_json::Value>(SETTINGS).unwrap().unwrap()["save_path"],
            "/srv"
        );
        assert!(store.tags().unwrap().contains("old"));
        assert_eq!(
            store.categories().unwrap()["tv"].save_path.as_deref(),
            Some("/tv")
        );
        let t = store.load_torrents().unwrap().pop().unwrap().unwrap();
        assert!(t.record.stopped);
        assert_eq!(t.record.format, RECORD_FORMAT);
        assert_eq!(t.metainfo.as_deref(), Some(&b"meta"[..]));
        assert_eq!(t.resume.as_deref(), Some(&b"resume"[..]));
        assert!(!root.join("settings.json").exists());
        assert!(root.join("imported-0.1/torrents/cc.json").exists());

        // Opening again imports nothing more.
        drop(store);
        let store = Store::open(root).unwrap();
        assert_eq!(store.imported(), 0);
        assert_eq!(store.load_torrents().unwrap().len(), 1);
    }
}
