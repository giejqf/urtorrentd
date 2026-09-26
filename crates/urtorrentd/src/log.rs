// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The daemon's main log and peer log: bounded in-memory ring buffers that
//! the API pages through by id.

use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::util::now;

/// Entries kept per log.
const CAPACITY: usize = 10_000;

/// Severity of a main-log entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LogLevel {
    /// Routine events.
    Info,
    /// Something went wrong but the daemon carried on.
    Warning,
    /// A failure that needs attention.
    Error,
}

/// One main-log entry.
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct LogEntry {
    /// Increasing id; pass the last one seen as `after` to get newer entries.
    pub id: u64,
    /// Unix seconds.
    pub time: u64,
    /// Severity.
    pub level: LogLevel,
    /// What happened.
    pub message: String,
}

/// Who banned or unbanned a peer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum PeerLogSource {
    /// The engine, on one torrent, for pieces that failed their hash; for
    /// as long as the torrent runs in this session.
    Engine,
    /// The settings (`banned_ips`, `POST /transfer/bans`): every torrent,
    /// until unbanned.
    Settings,
}

/// One peer-log entry (an address banned or unbanned).
#[derive(Debug, Clone, Serialize, ToSchema)]
pub struct PeerLogEntry {
    /// Increasing id; pass the last one seen as `after` to get newer entries.
    pub id: u64,
    /// Unix seconds.
    pub time: u64,
    /// The peer address.
    #[schema(value_type = String)]
    pub ip: IpAddr,
    /// Whether the address is now banned (`false`: the ban was lifted).
    pub banned: bool,
    /// Who banned or unbanned it.
    pub source: PeerLogSource,
    /// The torrent an engine ban is on (info-hash); `null` for the settings'.
    #[schema(required = true)]
    pub torrent: Option<String>,
    /// Why.
    pub reason: String,
}

struct Ring<T> {
    next_id: u64,
    entries: VecDeque<T>,
}

impl<T> Ring<T> {
    fn new() -> Ring<T> {
        Ring {
            next_id: 0,
            entries: VecDeque::new(),
        }
    }

    fn push(&mut self, make: impl FnOnce(u64) -> T) {
        let id = self.next_id;
        self.next_id += 1;
        if self.entries.len() == CAPACITY {
            self.entries.pop_front();
        }
        self.entries.push_back(make(id));
    }
}

/// The two logs.
pub struct Logs {
    main: Mutex<Ring<LogEntry>>,
    peers: Mutex<Ring<PeerLogEntry>>,
}

impl Default for Logs {
    fn default() -> Logs {
        Logs {
            main: Mutex::new(Ring::new()),
            peers: Mutex::new(Ring::new()),
        }
    }
}

impl Logs {
    /// Append to the main log (and emit the same line through `tracing`).
    pub fn log(&self, level: LogLevel, message: impl Into<String>) {
        let message = message.into();
        match level {
            LogLevel::Info => tracing::info!("{message}"),
            LogLevel::Warning => tracing::warn!("{message}"),
            LogLevel::Error => tracing::error!("{message}"),
        }
        if let Ok(mut ring) = self.main.lock() {
            ring.push(|id| LogEntry {
                id,
                time: now(),
                level,
                message,
            });
        }
    }

    /// Shorthand for an info entry.
    pub fn info(&self, message: impl Into<String>) {
        self.log(LogLevel::Info, message);
    }

    /// Shorthand for a warning entry.
    pub fn warn(&self, message: impl Into<String>) {
        self.log(LogLevel::Warning, message);
    }

    /// Record a ban or unban in the peer log.
    pub fn peer(
        &self,
        ip: IpAddr,
        banned: bool,
        source: PeerLogSource,
        torrent: Option<String>,
        reason: impl Into<String>,
    ) {
        let reason = reason.into();
        if let Ok(mut ring) = self.peers.lock() {
            ring.push(|id| PeerLogEntry {
                id,
                time: now(),
                ip,
                banned,
                source,
                torrent,
                reason,
            });
        }
    }

    /// Main-log entries with an id above `after` whose level is in `levels`
    /// (all levels when empty), oldest first.
    pub fn main_since(&self, after: Option<u64>, levels: &[LogLevel]) -> Vec<LogEntry> {
        let Ok(ring) = self.main.lock() else {
            return Vec::new();
        };
        ring.entries
            .iter()
            .filter(|e| after.is_none_or(|a| e.id > a))
            .filter(|e| levels.is_empty() || levels.contains(&e.level))
            .cloned()
            .collect()
    }

    /// Peer-log entries with an id above `after`, oldest first.
    pub fn peers_since(&self, after: Option<u64>) -> Vec<PeerLogEntry> {
        let Ok(ring) = self.peers.lock() else {
            return Vec::new();
        };
        ring.entries
            .iter()
            .filter(|e| after.is_none_or(|a| e.id > a))
            .cloned()
            .collect()
    }
}
