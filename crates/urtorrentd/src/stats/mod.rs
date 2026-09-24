// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Statistics (ADR 0005): traffic per torrent and for the session over time,
//! each torrent's days (its seeding history), and a timeline of what
//! happened to it.
//!
//! The tick hands every snapshot to [`Stats::observe`], which adds the
//! differences of the library's counters to in-memory buckets (never rate
//! times time, never interpolated: AGENTS.md rule 1). A flush writes them to
//! `stats.db` once a minute, and before every query, so the API sees
//! everything up to the last tick. Minute and hour buckets are written only
//! when bytes moved; a torrent's day is written when it ran or moved data.

pub(crate) mod db;
pub(crate) mod peers;
mod query;

use std::collections::{HashMap, HashSet};
use std::io;
use std::net::{IpAddr, SocketAddr};
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard};

use urtorrent::{InfoHash, SessionStats, TorrentStatus};

use crate::model::{StatsStep, TimelineKind, TorrentState};
use crate::util::{blocking, hex};
use db::{
    Batch, Day, EventRow, Meta, PeerTraffic, Retention, SessionTraffic, StatsDb, Totals, Traffic,
    max_opt,
};
use peers::{Conn, PeerKey};

/// Flushes happen at most this often from the tick, seconds.
const FLUSH_EVERY: u64 = 60;
/// Days in which only running time accumulated are written this often
/// (a busy seedbox has thousands of idle seeds), seconds.
const IDLE_DAYS_EVERY: u64 = 900;
/// Retention is applied this often, seconds.
const PRUNE_EVERY: u64 = 3600;

/// What the tick hands over for one torrent.
pub(crate) struct Sample<'a> {
    /// The torrent.
    pub hash: InfoHash,
    /// Its snapshot.
    pub status: &'a TorrentStatus,
    /// Its state as the API shows it.
    pub state: TorrentState,
    /// Its name as the API shows it.
    pub name: &'a str,
    /// Its counters started at zero in this run (added now, or restored
    /// without stored resume data), so the first observation counts in full.
    pub fresh: bool,
    /// Its share ratio as the API shows it.
    pub ratio: Option<f64>,
    /// Its category.
    pub category: Option<&'a str>,
    /// Its tags.
    pub tags: Vec<String>,
    /// Host of the tracker it works with now; `None` = none works (the
    /// last one recorded stays).
    pub tracker: Option<String>,
}

/// What the torrents table records about a torrent.
#[derive(Debug, Clone, PartialEq)]
struct TorrentMeta {
    name: String,
    size: u64,
    category: Option<String>,
    tags: Vec<String>,
    tracker: Option<String>,
}

/// The counters of the last observation.
#[derive(Debug, Clone, Copy, Default)]
struct Seen {
    downloaded: u64,
    uploaded: u64,
    active: u64,
    seeding: u64,
    /// The last state that was not a checking state.
    stable: Option<TorrentState>,
}

/// States recorded on the timeline (a check at every start would flood it).
fn stable(s: TorrentState) -> bool {
    !matches!(
        s,
        TorrentState::CheckingQueued | TorrentState::Checking | TorrentState::Unknown
    )
}

fn saturating_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

/// A timeline event not written yet: (time, torrent, kind, state, detail).
type Pending = (
    u64,
    InfoHash,
    TimelineKind,
    Option<TorrentState>,
    Option<String>,
);

/// What is observed and not written yet.
#[derive(Debug, Default)]
struct Acc {
    /// The recording period; `None` = not recording.
    period: Option<i64>,
    /// Counters are not comparable with the last ones (recording was off):
    /// the next observation only takes new baselines.
    rebase: bool,
    seen: HashMap<InfoHash, Seen>,
    session_seen: (u64, u64),
    meta: HashMap<InfoHash, TorrentMeta>,
    /// Tracker announces by host and bucket: (replies, errors).
    announces: HashMap<(String, StatsStep, u64), (u32, u32)>,
    /// Scrape results not folded into a day yet: (seeds, leechers,
    /// completed downloads).
    scrapes: HashMap<InfoHash, (u32, u32, u32)>,
    traffic: HashMap<(InfoHash, StatsStep, u64), Traffic>,
    /// Days, and whether data moved in them since the last flush.
    days: HashMap<(InfoHash, u64), (Day, bool)>,
    session: HashMap<(StatsStep, u64), SessionTraffic>,
    events: Vec<Pending>,
    last_flush: u64,
    last_idle_days: u64,
    last_prune: u64,
    /// When the recording period started: connections older than it are
    /// baselines.
    since: u64,
    /// Connections by torrent and address.
    conns: HashMap<InfoHash, HashMap<SocketAddr, Conn>>,
    /// Torrents whose counters moved since their peers were last sampled.
    active: HashSet<InfoHash>,
    /// Peer traffic by place, not written yet.
    peer_traffic: HashMap<PeerKey, PeerTraffic>,
    /// Addresses already counted per torrent and bucket.
    counted: HashMap<(InfoHash, StatsStep, u64), HashSet<IpAddr>>,
    /// Autonomous system names known, and those not written yet.
    asn_names: HashMap<u32, String>,
    asn_pending: Vec<(u32, String)>,
}

impl Acc {
    /// Take what a flush writes: everything, or all but the days in which
    /// only running time accumulated.
    fn take(&mut self, now: u64, idle_days: bool) -> Batch {
        let mut b = Batch {
            period: self.period.map(|p| (p, now)),
            ..Default::default()
        };
        let mut hashes = Vec::new();
        for ((h, step, t), x) in self.traffic.drain() {
            hashes.push(h);
            b.traffic.push((hex(&h), step, t, x));
        }
        let mut keep = HashMap::new();
        for ((h, t), (d, moved)) in self.days.drain() {
            if moved || idle_days {
                hashes.push(h);
                b.days.push((hex(&h), t, d));
            } else {
                keep.insert((h, t), (d, false));
            }
        }
        self.days = keep;
        for ((step, t), x) in self.session.drain() {
            b.session.push((step, t, x));
        }
        for ((h, step, t, dim, key), x) in self.peer_traffic.drain() {
            hashes.push(h);
            b.peer_traffic.push((hex(&h), step, t, dim.tag(), key, x));
        }
        b.asns = std::mem::take(&mut self.asn_pending);
        for ((host, step, t), (replies, errors)) in self.announces.drain() {
            b.announces.push((host, step, t, replies, errors));
        }
        self.tidy_peers(now);
        for (t, h, kind, state, detail) in self.events.drain(..) {
            hashes.push(h);
            b.events.push(EventRow {
                t,
                hash: hex(&h),
                kind,
                state,
                detail,
            });
        }
        for h in hashes {
            if let Some(m) = self.meta.get(&h) {
                b.meta.entry(hex(&h)).or_insert_with(|| Meta {
                    name: Some(m.name.clone()),
                    size: Some(m.size),
                    groups: Some((m.category.clone(), m.tags.clone())),
                    tracker: m.tracker.clone(),
                });
            }
        }
        // Removed torrents are needed only for what this batch writes.
        let seen = &self.seen;
        self.meta.retain(|h, _| seen.contains_key(h));
        b
    }
}

/// When a flush runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Flush {
    /// From the tick: if [`FLUSH_EVERY`] passed.
    Due,
    /// Everything now (before a query, at shutdown).
    All,
}

/// The statistics recorder.
pub(crate) struct Stats {
    db: Arc<StatsDb>,
    acc: Mutex<Acc>,
    /// Flushes are written in order (days carry the latest totals).
    flush_lock: tokio::sync::Mutex<()>,
}

impl Stats {
    /// Open `stats.db` in `dir`, recording from `now` if `enabled`.
    pub(crate) fn open(dir: &Path, enabled: bool, now: u64) -> io::Result<Stats> {
        let db = StatsDb::open(dir)?;
        let period = if enabled {
            Some(db.start_period(now)?)
        } else {
            None
        };
        Ok(Stats {
            db: Arc::new(db),
            acc: Mutex::new(Acc {
                period,
                last_flush: now,
                last_idle_days: now,
                since: now,
                ..Default::default()
            }),
            flush_lock: tokio::sync::Mutex::new(()),
        })
    }

    fn acc(&self) -> MutexGuard<'_, Acc> {
        self.acc.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Whether recording is on.
    pub(crate) fn recording(&self) -> bool {
        self.acc().period.is_some()
    }

    /// The current recording period.
    pub(crate) fn period(&self) -> Option<i64> {
        self.acc().period
    }

    /// Add one tick's snapshots.
    pub(crate) fn observe(&self, t: u64, samples: &[Sample<'_>], session: Option<&SessionStats>) {
        let mut a = self.acc();
        if a.period.is_none() {
            return;
        }
        let rebase = std::mem::take(&mut a.rebase);
        let (minute, hour, day) = (
            StatsStep::Minute.start(t),
            StatsStep::Hour.start(t),
            StatsStep::Day.start(t),
        );
        for s in samples {
            let st = s.status;
            let now = Seen {
                downloaded: st.downloaded,
                uploaded: st.uploaded,
                active: st.active_time.as_secs(),
                seeding: st.seeding_time.as_secs(),
                stable: stable(s.state).then_some(s.state),
            };
            let prev = a.seen.get(&s.hash).copied();
            let base = match prev {
                Some(p) if !rebase => p,
                None if s.fresh && !rebase => Seen {
                    downloaded: 0,
                    uploaded: 0,
                    active: 0,
                    seeding: 0,
                    stable: None,
                },
                _ => now,
            };
            // A counter that went back (the torrent was re-added) restarts.
            let delta = |cur: u64, old: u64| cur.saturating_sub(old);
            let (down, up) = (
                delta(now.downloaded, base.downloaded),
                delta(now.uploaded, base.uploaded),
            );
            let (active, seeding) = (
                delta(now.active, base.active),
                delta(now.seeding, base.seeding),
            );
            let old_state = prev.and_then(|p| p.stable);
            if let (Some(new), Some(old)) = (now.stable, old_state)
                && new != old
            {
                a.events
                    .push((t, s.hash, TimelineKind::State, Some(new), None));
            }
            a.seen.insert(
                s.hash,
                Seen {
                    stable: now.stable.or(old_state),
                    ..now
                },
            );
            let old = a.meta.get(&s.hash);
            let tracker = s
                .tracker
                .clone()
                .or_else(|| old.and_then(|m| m.tracker.clone()));
            let changed = old.is_none_or(|m| {
                m.name != s.name
                    || m.size != st.total_size
                    || m.category.as_deref() != s.category
                    || m.tags != s.tags
                    || m.tracker != tracker
            });
            if changed {
                a.meta.insert(
                    s.hash,
                    TorrentMeta {
                        name: s.name.to_string(),
                        size: st.total_size,
                        category: s.category.map(str::to_string),
                        tags: s.tags.clone(),
                        tracker,
                    },
                );
            }
            let traffic = Traffic {
                downloaded: down,
                uploaded: up,
                peers_max: saturating_u32(st.peers),
                seeds_max: saturating_u32(st.seeds),
            };
            let moved = down > 0 || up > 0;
            if moved {
                a.active.insert(s.hash);
                for (step, t) in [(StatsStep::Minute, minute), (StatsStep::Hour, hour)] {
                    a.traffic
                        .entry((s.hash, step, t))
                        .or_default()
                        .add(&traffic);
                }
            }
            let scrape = a.scrapes.remove(&s.hash);
            if moved || active > 0 || seeding > 0 || scrape.is_some() {
                let (d, day_moved) = a.days.entry((s.hash, day)).or_default();
                if let Some((seeds, leechers, completed)) = scrape {
                    d.swarm_seeds_max = max_opt(d.swarm_seeds_max, Some(seeds));
                    d.swarm_leechers_max = max_opt(d.swarm_leechers_max, Some(leechers));
                    d.swarm_completed_max = max_opt(d.swarm_completed_max, Some(completed));
                }
                d.traffic.add(&traffic);
                d.active_time += active;
                d.seeding_time += seeding;
                d.totals = Totals {
                    downloaded: now.downloaded,
                    uploaded: now.uploaded,
                    active_time: now.active,
                    seeding_time: now.seeding,
                    ratio: s.ratio,
                };
                d.swarm_seeds_max = max_opt(d.swarm_seeds_max, st.swarm_seeders);
                d.swarm_leechers_max = max_opt(d.swarm_leechers_max, st.swarm_leechers);
                *day_moved |= moved;
            }
        }
        if let Some(ss) = session {
            let (down0, up0) = if rebase {
                (ss.downloaded, ss.uploaded)
            } else {
                a.session_seen
            };
            let x = SessionTraffic {
                downloaded: ss.downloaded.saturating_sub(down0),
                uploaded: ss.uploaded.saturating_sub(up0),
                peers_max: saturating_u32(ss.peers),
                connections_max: saturating_u32(ss.connections),
                dht_nodes_max: saturating_u32(ss.dht_nodes),
                torrents_max: saturating_u32(ss.torrents),
            };
            a.session_seen = (ss.downloaded, ss.uploaded);
            for step in StatsStep::ALL {
                a.session.entry((step, step.start(t))).or_default().add(&x);
            }
        }
    }

    /// Record a timeline event.
    pub(crate) fn event(&self, t: u64, hash: InfoHash, kind: TimelineKind, detail: Option<String>) {
        let mut a = self.acc();
        if a.period.is_some() {
            a.events.push((t, hash, kind, None, detail));
        }
    }

    /// A tracker answered an announce (`ok`) or failed to.
    pub(crate) fn announce(&self, t: u64, url: &str, ok: bool) {
        let Some(host) = db::tracker_host(url) else {
            return;
        };
        let mut a = self.acc();
        if a.period.is_none() {
            return;
        }
        for step in [StatsStep::Hour, StatsStep::Day] {
            let e = a
                .announces
                .entry((host.clone(), step, step.start(t)))
                .or_default();
            if ok {
                e.0 = e.0.saturating_add(1);
            } else {
                e.1 = e.1.saturating_add(1);
            }
        }
    }

    /// A scrape answered: the swarm's seeds, leechers and completed
    /// downloads (the most of several trackers' answers is kept).
    pub(crate) fn scraped(&self, hash: InfoHash, seeds: u32, leechers: u32, completed: u32) {
        let mut a = self.acc();
        if a.period.is_some() {
            let e = a.scrapes.entry(hash).or_default();
            *e = (e.0.max(seeds), e.1.max(leechers), e.2.max(completed));
        }
    }

    /// A torrent left the session: a later add of the same hash starts from
    /// zero.
    pub(crate) fn forget(&self, hash: &InfoHash) {
        let mut a = self.acc();
        a.seen.remove(hash);
        a.conns.remove(hash);
        a.active.remove(hash);
        a.counted.retain(|(h, _, _), _| h != hash);
    }

    /// Write what was observed (see [`Flush`]), and apply the retention
    /// when it is due.
    pub(crate) async fn flush(
        &self,
        now: u64,
        mode: Flush,
        retention: Retention,
    ) -> io::Result<()> {
        let _order = self.flush_lock.lock().await;
        let (batch, prune) = {
            let mut a = self.acc();
            if mode == Flush::Due && now < a.last_flush + FLUSH_EVERY {
                return Ok(());
            }
            a.last_flush = now;
            let idle_days = mode == Flush::All || now >= a.last_idle_days + IDLE_DAYS_EVERY;
            if idle_days {
                a.last_idle_days = now;
            }
            let prune = now >= a.last_prune + PRUNE_EVERY;
            if prune {
                a.last_prune = now;
            }
            (a.take(now, idle_days), prune)
        };
        let db = self.db.clone();
        blocking(move || {
            db.write(&batch)?;
            if prune {
                db.prune(now, &retention)?;
            }
            Ok(())
        })
        .await
    }

    /// Turn recording on or off. Off writes what is pending and ends the
    /// period; on starts a new one, with fresh baselines.
    pub(crate) async fn set_recording(
        &self,
        on: bool,
        now: u64,
        retention: Retention,
    ) -> io::Result<()> {
        if on == self.recording() {
            return Ok(());
        }
        if on {
            let db = self.db.clone();
            let id = blocking(move || db.start_period(now)).await?;
            let mut a = self.acc();
            a.period = Some(id);
            a.rebase = true;
            a.since = now;
            a.seen.clear();
            a.conns.clear();
            a.counted.clear();
            a.active.clear();
            Ok(())
        } else {
            self.stop(now, retention).await
        }
    }

    /// Write what is pending and end the recording period (shutdown).
    pub(crate) async fn stop(&self, now: u64, retention: Retention) -> io::Result<()> {
        self.flush(now, Flush::All, retention).await?;
        let period = self.acc().period.take();
        if let Some(id) = period {
            let db = self.db.clone();
            blocking(move || db.end_period(id, now)).await?;
        }
        Ok(())
    }

    /// The database, for queries.
    pub(crate) fn db(&self) -> Arc<StatsDb> {
        self.db.clone()
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn buckets_are_aligned() {
        assert_eq!(StatsStep::Minute.start(3_725), 3_720);
        assert_eq!(StatsStep::Hour.start(3_725), 3_600);
        assert_eq!(StatsStep::Day.start(90_000), 86_400);
    }

    #[test]
    fn checking_is_not_a_timeline_state() {
        assert!(!stable(TorrentState::Checking));
        assert!(!stable(TorrentState::CheckingQueued));
        assert!(stable(TorrentState::Seeding));
        assert!(stable(TorrentState::Stopped));
    }
}
