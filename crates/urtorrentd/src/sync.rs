// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Incremental sync (AGENTS.md 4.6), polled (`GET /sync`) or pushed as
//! server-sent events (`GET /events`). The daemon builds a snapshot at most
//! every [`MIN_INTERVAL`], however many clients there are, and keeps the
//! fingerprints of the last [`KEEP`] snapshots. A client passes the `rev` it
//! holds; if that snapshot is still kept it gets only what changed, otherwise
//! everything. Polling keeps no per-client state; a stream keeps only the
//! last `rev` and transfer state it sent.
//!
//! A snapshot holds each torrent's row as last *published*, which is not
//! always the row now, so that a diff stays small with many torrents:
//!
//! - A row's clocks (`Row::without_clocks`: seconds running and seeding,
//!   the next announce, the last activity, the last complete copy seen,
//!   popularity) tick every second on every running torrent. A change to
//!   them alone is published once a minute per torrent, at a second of the
//!   minute of its own (from its hash), so about a sixtieth of the torrents
//!   go out each second instead of all of them.
//! - Any other change is published at once, [`MAX_ROWS`] torrents per
//!   snapshot at most (in turn, by hash); the rest follow in the next ones.
//!   New torrents and removals always go at once.
//! - After a pause of [`LONG_PAUSE`] without snapshots (a script polling now
//!   and then), everything is published as it is now.
//!
//! What is published is always the daemon's own values, only up to a minute
//! old for the clocks (charter rule 1).

use std::collections::hash_map::DefaultHasher;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::convert::Infallible;
use std::hash::{Hash, Hasher};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::response::sse::Event;
use futures_util::Stream;
use serde::Serialize;
use tokio::sync::watch;
use tokio::time::{Interval, MissedTickBehavior};

use crate::daemon::Daemon;
use crate::error::ApiResult;
use crate::model::{SyncResponse, TorrentSummary, TransferInfo};
use crate::store::Category;

/// Snapshots are rebuilt at most this often.
pub const MIN_INTERVAL: Duration = Duration::from_millis(500);
/// Snapshots whose fingerprints are kept for diffs.
pub const KEEP: usize = 16;
/// A stream looks for changes this often (and sends only when there are).
pub const PUSH_INTERVAL: Duration = Duration::from_secs(1);
/// A row whose clocks alone changed is published this often.
pub const CLOCK_REFRESH: Duration = Duration::from_secs(60);
/// Changed rows published in one snapshot at most.
pub const MAX_ROWS: usize = 1_000;
/// Without a snapshot for this long, the next publishes everything as it is.
pub const LONG_PAUSE: Duration = Duration::from_secs(5);

fn fingerprint<T: Serialize>(v: &T) -> u64 {
    let mut h = DefaultHasher::new();
    serde_json::to_vec(v).unwrap_or_default().hash(&mut h);
    h.finish()
}

/// Rows whose clocks are due take up to this many places of a snapshot's
/// [`MAX_ROWS`] before changed rows, so that a stream of changes never holds
/// them back.
const CLOCK_SHARE: usize = MAX_ROWS / 4;

/// A list row as published to clients.
pub(crate) trait Row: Serialize {
    /// The row with its clocks (the fields that change with time alone)
    /// cleared.
    fn without_clocks(&self) -> Self;
}

impl Row for TorrentSummary {
    fn without_clocks(&self) -> Self {
        Self {
            active_time: 0,
            seeding_time: 0,
            next_announce_in: None,
            last_activity: None,
            seen_complete: None,
            popularity: None,
            ..self.clone()
        }
    }
}

/// A row as published, with what decides when it is published again.
#[derive(Debug)]
struct Published<R> {
    row: Arc<R>,
    /// Fingerprint of the row without its clocks.
    main: u64,
    /// Fingerprint of the row as published.
    print: u64,
    /// When it was published.
    at: Instant,
}

impl<R: Serialize> Published<R> {
    fn new(row: R, main: u64, at: Instant) -> Self {
        Self {
            print: fingerprint(&row),
            row: Arc::new(row),
            main,
            at,
        }
    }
}

impl<R> Clone for Published<R> {
    fn clone(&self) -> Self {
        Self {
            row: self.row.clone(),
            main: self.main,
            print: self.print,
            at: self.at,
        }
    }
}

/// The minute of a row's clocks: it turns at a second of its own (from its
/// key, a hash), so that the rows' clock refreshes spread over the minute.
fn clock_minute(key: &str, at: Instant, epoch: Instant) -> u128 {
    let period = CLOCK_REFRESH.as_millis();
    let phase = key
        .get(..8)
        .and_then(|h| u32::from_str_radix(h, 16).ok())
        .map_or(0, |x| (u128::from(x) * period) >> 32);
    (at.saturating_duration_since(epoch).as_millis() + phase) / period
}

/// A row that has changed since it was published.
struct Candidate<R> {
    key: String,
    row: R,
    main: u64,
    old: Published<R>,
}

/// The rows to publish now, from those published before and those now (the
/// module's documentation says which), and where the next snapshot's turn of
/// changed rows starts.
fn publish<R: Row>(
    before: &BTreeMap<String, Published<R>>,
    now_rows: BTreeMap<String, R>,
    now: Instant,
    epoch: Instant,
    everything: bool,
    turn: Option<&str>,
) -> (BTreeMap<String, Published<R>>, Option<String>) {
    let mut out = BTreeMap::new();
    // Rows changed beyond their clocks (in key order), and rows whose clocks
    // are due.
    let mut changed = Vec::new();
    let mut due = Vec::new();
    for (key, row) in now_rows {
        let main = fingerprint(&row.without_clocks());
        let Some(old) = before.get(&key).filter(|_| !everything) else {
            out.insert(key, Published::new(row, main, now));
            continue;
        };
        if old.main != main {
            changed.push(Candidate {
                key,
                row,
                main,
                old: old.clone(),
            });
        } else if clock_minute(&key, now, epoch) > clock_minute(&key, old.at, epoch) {
            due.push(Candidate {
                key,
                row,
                main,
                old: old.clone(),
            });
        } else {
            out.insert(key, old.clone());
        }
    }
    let mut room = MAX_ROWS;
    let mut place = |c: Candidate<R>, out: &mut BTreeMap<String, Published<R>>| {
        if room == 0 {
            out.insert(c.key, c.old);
            return false;
        }
        room -= 1;
        out.insert(c.key, Published::new(c.row, c.main, now));
        true
    };
    // Clocks the longest waiting first, some before the changed rows.
    due.sort_by_key(|c| c.old.at);
    let later = due.split_off(due.len().min(CLOCK_SHARE));
    for c in due {
        place(c, &mut out);
    }
    // Changed rows in turn, from the one after the last published.
    let start = turn.map_or(0, |t| changed.partition_point(|c| c.key.as_str() <= t));
    changed.rotate_left(start);
    let (mut last, mut deferred) = (None, false);
    for c in changed {
        let key = c.key.clone();
        if place(c, &mut out) {
            last = Some(key);
        } else {
            deferred = true;
        }
    }
    for c in later {
        place(c, &mut out);
    }
    (out, if deferred { last } else { None })
}

/// Fingerprints of one snapshot.
#[derive(Debug, Default)]
struct Prints {
    rev: u64,
    torrents: HashMap<String, u64>,
    categories: HashMap<String, u64>,
    tags: u64,
}

/// The newest snapshot in full.
#[derive(Debug)]
struct Latest {
    built: Instant,
    torrents: BTreeMap<String, Published<TorrentSummary>>,
    categories: BTreeMap<String, Category>,
    tags: Vec<String>,
    transfer: TransferInfo,
}

/// Sync state shared by all clients.
#[derive(Debug, Default)]
pub struct SyncState {
    next_rev: u64,
    kept: VecDeque<Arc<Prints>>,
    latest: Option<Arc<Latest>>,
    /// Where the next snapshot's turn of changed rows starts.
    turn: Option<String>,
    /// The first snapshot: the rows' clock minutes count from it.
    epoch: Option<Instant>,
}

impl Daemon {
    /// Everything, or the changes since `rev`.
    pub(crate) async fn sync(&self, rev: Option<u64>) -> ApiResult<SyncResponse> {
        let (latest, prints) = self.snapshot().await?;
        let base = rev.and_then(|r| {
            let s = self.sync.lock().ok()?;
            s.kept.iter().find(|p| p.rev == r).cloned()
        });
        let mut out = SyncResponse {
            rev: prints.rev,
            full: base.is_none(),
            torrents: BTreeMap::new(),
            torrents_removed: Vec::new(),
            categories: BTreeMap::new(),
            categories_removed: Vec::new(),
            tags: None,
            transfer: latest.transfer.clone(),
        };
        match base {
            None => {
                out.torrents = latest
                    .torrents
                    .iter()
                    .map(|(h, p)| (h.clone(), (*p.row).clone()))
                    .collect();
                out.categories = latest.categories.clone();
                out.tags = Some(latest.tags.clone());
            }
            Some(old) => {
                for (h, p) in &latest.torrents {
                    if old.torrents.get(h) != prints.torrents.get(h) {
                        out.torrents.insert(h.clone(), (*p.row).clone());
                    }
                }
                out.torrents_removed = old
                    .torrents
                    .keys()
                    .filter(|h| !prints.torrents.contains_key(*h))
                    .cloned()
                    .collect();
                out.torrents_removed.sort();
                for (n, c) in &latest.categories {
                    if old.categories.get(n) != prints.categories.get(n) {
                        out.categories.insert(n.clone(), c.clone());
                    }
                }
                out.categories_removed = old
                    .categories
                    .keys()
                    .filter(|n| !prints.categories.contains_key(*n))
                    .cloned()
                    .collect();
                out.categories_removed.sort();
                if old.tags != prints.tags {
                    out.tags = Some(latest.tags.clone());
                }
            }
        }
        Ok(out)
    }

    /// The current snapshot, rebuilt if older than [`MIN_INTERVAL`].
    async fn snapshot(&self) -> ApiResult<(Arc<Latest>, Arc<Prints>)> {
        {
            let s = self
                .sync
                .lock()
                .map_err(|_| crate::error::ApiError::internal("sync state poisoned"))?;
            if let (Some(l), Some(p)) = (&s.latest, s.kept.back())
                && l.built.elapsed() < MIN_INTERVAL
            {
                return Ok((l.clone(), p.clone()));
            }
        }
        // One build at a time, each from the one before; a caller that waited
        // takes the snapshot just built.
        let _build = self.sync_build.lock().await;
        {
            let s = self
                .sync
                .lock()
                .map_err(|_| crate::error::ApiError::internal("sync state poisoned"))?;
            if let (Some(l), Some(p)) = (&s.latest, s.kept.back())
                && l.built.elapsed() < MIN_INTERVAL
            {
                return Ok((l.clone(), p.clone()));
            }
        }
        let rows = self.summaries().await?;
        let transfer = self.transfer_info().await?;
        let categories = self.categories();
        let tags: Vec<String> = self.tags().into_iter().collect();
        let now_rows: BTreeMap<String, TorrentSummary> =
            rows.into_iter().map(|t| (t.hash.clone(), t)).collect();
        let now = Instant::now();
        let (before, turn, epoch) = {
            let mut s = self
                .sync
                .lock()
                .map_err(|_| crate::error::ApiError::internal("sync state poisoned"))?;
            let epoch = *s.epoch.get_or_insert(now);
            (s.latest.clone(), s.turn.clone(), epoch)
        };
        let empty = BTreeMap::new();
        let everything = before
            .as_ref()
            .is_none_or(|l| now.saturating_duration_since(l.built) >= LONG_PAUSE);
        let (torrents, turn) = publish(
            before.as_ref().map_or(&empty, |l| &l.torrents),
            now_rows,
            now,
            epoch,
            everything,
            turn.as_deref(),
        );
        let mut prints = Prints {
            rev: 0,
            torrents: torrents.iter().map(|(h, p)| (h.clone(), p.print)).collect(),
            categories: categories
                .iter()
                .map(|(n, c)| (n.clone(), fingerprint(c)))
                .collect(),
            tags: fingerprint(&tags),
        };
        let latest = Arc::new(Latest {
            built: now,
            torrents,
            categories: categories.into_iter().collect(),
            tags,
            transfer,
        });
        let mut s = self
            .sync
            .lock()
            .map_err(|_| crate::error::ApiError::internal("sync state poisoned"))?;
        s.next_rev += 1;
        s.turn = turn;
        prints.rev = s.next_rev;
        let prints = Arc::new(prints);
        s.kept.push_back(prints.clone());
        while s.kept.len() > KEEP {
            s.kept.pop_front();
        }
        s.latest = Some(latest.clone());
        Ok((latest, prints))
    }
}

/// Whether a diff carries anything the client does not have.
fn has_changes(r: &SyncResponse, last_transfer: Option<&TransferInfo>) -> bool {
    r.full
        || !r.torrents.is_empty()
        || !r.torrents_removed.is_empty()
        || !r.categories.is_empty()
        || !r.categories_removed.is_empty()
        || r.tags.is_some()
        || last_transfer != Some(&r.transfer)
}

struct StreamState {
    daemon: Arc<Daemon>,
    /// The revision the client holds.
    rev: Option<u64>,
    /// The transfer state last sent.
    last_transfer: Option<TransferInfo>,
    interval: Interval,
    shutdown: watch::Receiver<bool>,
    /// The login session the stream was opened with, if any: the stream
    /// ends with it, and keeps it alive while it is open.
    session: Option<String>,
}

/// Server-sent events: a `sync` event (id = the revision, data = a
/// [`SyncResponse`]) at once, then whenever something changed, checked every
/// [`PUSH_INTERVAL`]. Nothing is queued: each event is computed when the
/// connection can take it, so a slow client gets the latest diff, not a
/// backlog. The stream ends when the daemon shuts down, and when the login
/// session it was opened with ends (sign-out, new credentials, expiry); an
/// open stream is use of its session, so a page that only watches is not
/// signed out.
pub(crate) fn event_stream(
    daemon: Arc<Daemon>,
    rev: Option<u64>,
    session: Option<String>,
) -> impl Stream<Item = Result<Event, Infallible>> {
    let mut interval = tokio::time::interval(PUSH_INTERVAL);
    interval.set_missed_tick_behavior(MissedTickBehavior::Skip);
    let shutdown = daemon.shutdown_watch();
    let state = StreamState {
        daemon,
        rev,
        last_transfer: None,
        interval,
        shutdown,
        session,
    };
    futures_util::stream::unfold(state, |mut s| async move {
        loop {
            // The first tick of a tokio interval completes at once.
            tokio::select! {
                _ = s.interval.tick() => {}
                _ = s.shutdown.wait_for(|stop| *stop) => return None,
            }
            if s.daemon.is_closed() {
                return None;
            }
            if let Some(sid) = &s.session {
                let timeout = s.daemon.state().settings.api_session_timeout;
                if !s
                    .daemon
                    .auth
                    .touch_session(sid, Duration::from_secs(timeout), None)
                {
                    return None;
                }
            }
            let Ok(resp) = s.daemon.sync(s.rev).await else {
                continue;
            };
            let changed = has_changes(&resp, s.last_transfer.as_ref());
            s.rev = Some(resp.rev);
            if !changed {
                continue;
            }
            s.last_transfer = Some(resp.transfer.clone());
            let event = Event::default()
                .event("sync")
                .id(resp.rev.to_string())
                .json_data(&resp)
                .unwrap_or_else(|e| Event::default().comment(format!("encoding failed: {e}")));
            return Some((Ok(event), s));
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone, Serialize)]
    struct T {
        value: u32,
        clock: u64,
    }

    impl Row for T {
        fn without_clocks(&self) -> Self {
            Self {
                clock: 0,
                ..self.clone()
            }
        }
    }

    /// `n` keys spread over the hash space, like info-hashes.
    fn keys(n: u32) -> Vec<String> {
        (0..n)
            .map(|i| format!("{:08x}{i:032x}", (u64::from(i) << 32) / u64::from(n)))
            .collect()
    }

    fn rows(keys: &[String], value: impl Fn(usize) -> u32, clock: u64) -> BTreeMap<String, T> {
        keys.iter()
            .enumerate()
            .map(|(i, k)| {
                (
                    k.clone(),
                    T {
                        value: value(i),
                        clock,
                    },
                )
            })
            .collect()
    }

    /// The keys whose published row changed between two snapshots.
    fn sent(a: &BTreeMap<String, Published<T>>, b: &BTreeMap<String, Published<T>>) -> Vec<String> {
        b.iter()
            .filter(|(k, p)| a.get(*k).is_none_or(|o| o.print != p.print))
            .map(|(k, _)| k.clone())
            .collect()
    }

    #[test]
    fn clocks_alone_go_once_a_minute_spread_over_it() {
        let epoch = Instant::now();
        let ks = keys(600);
        let (mut now, _) = publish(
            &BTreeMap::new(),
            rows(&ks, |_| 1, 0),
            epoch,
            epoch,
            false,
            None,
        );
        let mut times: HashMap<String, Vec<u64>> = HashMap::new();
        for s in 1..=180 {
            let at = epoch + Duration::from_secs(s);
            let (next, _) = publish(&now, rows(&ks, |_| 1, s), at, epoch, false, None);
            let out = sent(&now, &next);
            // About a sixtieth of the rows each second.
            assert!(out.len() <= 20, "second {s}: {} rows", out.len());
            for k in out {
                times.entry(k).or_default().push(s);
            }
            now = next;
        }
        for k in &ks {
            let t = &times[k];
            // Every row, once a minute, its clock at most a minute old.
            assert_eq!(t.len(), 3, "{k}: {t:?}");
            assert!(
                t[0] <= 60 && t.windows(2).all(|w| w[1] - w[0] == 60),
                "{k}: {t:?}"
            );
            assert_eq!(now[k].row.clock, t[2]);
        }
    }

    #[test]
    fn changes_and_new_rows_go_at_once() {
        let epoch = Instant::now();
        let ks = keys(10);
        let (before, _) = publish(
            &BTreeMap::new(),
            rows(&ks, |_| 1, 0),
            epoch,
            epoch,
            false,
            None,
        );
        let at = epoch + Duration::from_millis(500);
        let mut now_rows = rows(&ks, |i| if i == 3 { 2 } else { 1 }, 1);
        now_rows.insert("ffffffffnew".into(), T { value: 1, clock: 1 });
        let (after, turn) = publish(&before, now_rows, at, epoch, false, None);
        assert_eq!(
            sent(&before, &after),
            vec![ks[3].clone(), "ffffffffnew".into()]
        );
        assert_eq!(turn, None);
        // A removed row is gone.
        let (gone, _) = publish(&after, rows(&ks[1..], |_| 1, 1), at, epoch, false, None);
        assert!(!gone.contains_key(&ks[0]));
        // After a long pause, everything as it is.
        let (all, _) = publish(&after, rows(&ks, |_| 1, 9), at, epoch, true, None);
        assert_eq!(sent(&after, &all).len(), 10);
    }

    #[test]
    fn many_changes_go_in_batches_in_turn() {
        let epoch = Instant::now();
        let ks = keys(2_500);
        let (mut now, _) = publish(
            &BTreeMap::new(),
            rows(&ks, |_| 1, 0),
            epoch,
            epoch,
            false,
            None,
        );
        let mut turn = None;
        let mut seen = Vec::new();
        for s in 1..=3 {
            let at = epoch + Duration::from_millis(s * 100);
            let (next, t) = publish(&now, rows(&ks, |_| 2, 0), at, epoch, false, turn.as_deref());
            let out = sent(&now, &next);
            assert_eq!(out.len(), if s < 3 { MAX_ROWS } else { 500 });
            // Rows not sent yet keep what was published.
            assert_eq!(
                next.values().filter(|p| p.row.value == 2).count(),
                seen.len() + out.len()
            );
            seen.extend(out);
            (now, turn) = (next, t);
        }
        seen.sort();
        assert_eq!(seen, ks);
        assert_eq!(turn, None);
    }

    #[test]
    fn clocks_keep_going_under_a_flood_of_changes() {
        let epoch = Instant::now();
        let busy = keys(3_000);
        let idle: Vec<String> = keys(600).into_iter().map(|k| format!("{k}idle")).collect();
        let all_rows = |s: u64| {
            let mut r = rows(&busy, |_| s as u32, s);
            r.extend(rows(&idle, |_| 1, s));
            r
        };
        let (mut now, mut turn) = publish(&BTreeMap::new(), all_rows(0), epoch, epoch, false, None);
        for s in 1..=61 {
            let at = epoch + Duration::from_secs(s);
            (now, turn) = publish(&now, all_rows(s), at, epoch, false, turn.as_deref());
        }
        for k in &idle {
            assert!(now[k].row.clock >= 1, "{k} never refreshed");
        }
    }
}
