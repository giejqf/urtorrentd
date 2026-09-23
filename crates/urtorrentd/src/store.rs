// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! On-disk state (AGENTS.md 4.8). One data directory:
//!
//! ```text
//! settings.json      Settings
//! auth.json          credentials (hashed)
//! categories.json    categories
//! tags.json          tags
//! totals.json        all-time transfer counters
//! dht.state          the DHT node's state (library bytes)
//! torrents/<hash>.torrent   the metainfo (absent while a magnet has no metadata)
//! torrents/<hash>.json      the daemon's record of the torrent
//! resume/<hash>.resume      engine-managed resume data (never read here)
//! ```
//!
//! Every write is atomic (`util::atomic_write`). All functions here block;
//! async callers go through `util::blocking`.

use std::collections::{BTreeMap, BTreeSet};
use std::io;
use std::path::{Path, PathBuf};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::settings::ShareLimitAction;
use crate::util::{atomic_write, remove_file};

/// Current record format.
pub const RECORD_FORMAT: u32 = 1;

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
    /// When a magnet link's metadata has arrived (a `.torrent` is added stopped).
    MetadataReceived,
    /// When the initial check of the files has finished.
    FilesChecked,
}

/// What the daemon keeps about a torrent beyond the metainfo and the
/// engine's resume data.
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
    /// Sequential download (the library persists it too but does not report
    /// it in its status; docs/gaps.md).
    #[serde(default)]
    pub sequential: bool,
    /// Share limits.
    #[serde(default)]
    pub share_limits: ShareLimits,
    /// The URL the torrent was added from.
    #[serde(default)]
    pub source_url: Option<String>,
    /// Queue position when last saved (restores the order on restart).
    #[serde(default)]
    pub queue_position: Option<usize>,
    /// Last time payload moved, unix seconds.
    #[serde(default)]
    pub last_activity: Option<u64>,
    /// Last time a complete copy was seen (ours or a peer's), unix seconds.
    #[serde(default)]
    pub seen_complete: Option<u64>,
    /// A stop condition still waiting to fire.
    #[serde(default)]
    pub stop_condition: StopCondition,
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

/// The data directory.
#[derive(Debug, Clone)]
pub struct Store {
    root: PathBuf,
}

impl Store {
    /// Open (and create) a data directory.
    pub fn open(root: impl Into<PathBuf>) -> io::Result<Store> {
        let root = root.into();
        std::fs::create_dir_all(root.join("torrents"))?;
        std::fs::create_dir_all(root.join("resume"))?;
        Ok(Store { root })
    }

    /// The directory itself.
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Where the engine keeps resume files.
    pub fn resume_dir(&self) -> PathBuf {
        self.root.join("resume")
    }

    fn file(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }

    /// Read a JSON file; `None` if it does not exist.
    pub fn load<T: DeserializeOwned>(&self, name: &str) -> io::Result<Option<T>> {
        read_json(&self.file(name))
    }

    /// Write a JSON file atomically.
    pub fn save<T: Serialize>(&self, name: &str, value: &T) -> io::Result<()> {
        write_json(&self.file(name), value)
    }

    /// The DHT state, if saved.
    pub fn load_dht(&self) -> io::Result<Option<Vec<u8>>> {
        read_optional(&self.file("dht.state"))
    }

    /// Save the DHT state.
    pub fn save_dht(&self, bytes: &[u8]) -> io::Result<()> {
        atomic_write(&self.file("dht.state"), bytes)
    }

    fn torrent_path(&self, hash: &str) -> PathBuf {
        self.root.join("torrents").join(format!("{hash}.torrent"))
    }

    fn record_path(&self, hash: &str) -> PathBuf {
        self.root.join("torrents").join(format!("{hash}.json"))
    }

    /// Save a torrent's metainfo.
    pub fn save_torrent_file(&self, hash: &str, bytes: &[u8]) -> io::Result<()> {
        atomic_write(&self.torrent_path(hash), bytes)
    }

    /// A torrent's metainfo, if saved.
    pub fn load_torrent_file(&self, hash: &str) -> io::Result<Option<Vec<u8>>> {
        read_optional(&self.torrent_path(hash))
    }

    /// Save a torrent's record.
    pub fn save_record(&self, record: &TorrentRecord) -> io::Result<()> {
        write_json(&self.record_path(&record.info_hash), record)
    }

    /// Every saved record, in no particular order. Unreadable records are
    /// returned as errors next to their file name rather than aborting the load.
    pub fn load_records(&self) -> io::Result<Vec<Result<TorrentRecord, String>>> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(self.root.join("torrents"))? {
            let path = entry?.path();
            if path.extension().is_none_or(|e| e != "json") {
                continue;
            }
            out.push(match read_json::<TorrentRecord>(&path) {
                Ok(Some(r)) => Ok(r),
                Ok(None) => continue,
                Err(e) => Err(format!("{}: {e}", path.display())),
            });
        }
        Ok(out)
    }

    /// Delete everything kept for a torrent: record, metainfo and the engine's
    /// resume file (which a plain removal leaves behind, AGENTS.md 4.8).
    pub fn delete_torrent(&self, hash: &str) -> io::Result<()> {
        remove_file(&self.record_path(hash))?;
        remove_file(&self.torrent_path(hash))?;
        remove_file(&self.resume_dir().join(format!("{hash}.resume")))
    }
}

/// Categories file name.
pub const CATEGORIES: &str = "categories.json";
/// Tags file name.
pub const TAGS: &str = "tags.json";
/// Settings file name.
pub const SETTINGS: &str = "settings.json";
/// Credentials file name.
pub const AUTH: &str = "auth.json";
/// Totals file name.
pub const TOTALS: &str = "totals.json";

/// Categories as stored.
pub type Categories = BTreeMap<String, Category>;
/// Tags as stored.
pub type Tags = BTreeSet<String>;

fn read_optional(path: &Path) -> io::Result<Option<Vec<u8>>> {
    match std::fs::read(path) {
        Ok(b) => Ok(Some(b)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> io::Result<Option<T>> {
    match read_optional(path)? {
        Some(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e)),
        None => Ok(None),
    }
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    let bytes = serde_json::to_vec_pretty(value).map_err(io::Error::other)?;
    atomic_write(path, &bytes)
}
