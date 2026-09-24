// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The periodic tick: per-run baselines, share limits, resume data that is
//! due, changed records, and the all-time totals. Policy only: it reads
//! snapshots and calls public operations.

use std::sync::{Arc, Weak};
use std::time::Duration;

use urtorrent::{InfoHash, TorrentId, TorrentState as L, TorrentStatus};

use super::{Daemon, Entry, ResumeSave};
use crate::settings::{Settings, SettingsPatch, ShareLimitAction};
use crate::stats::peers::{PEER_SAMPLE_EVERY, PeerSample};
use crate::stats::{Flush, Sample};
use crate::store::{RatioLimit, TimeLimit};
use crate::util::now;

const TICK: Duration = Duration::from_secs(2);
/// Totals are saved every this many ticks (and at shutdown).
const TOTALS_EVERY: u64 = 30;
/// Scrapes started per tick at most (`stats_scrape_interval`).
const SCRAPES_PER_TICK: usize = 4;

pub(crate) async fn run(daemon: Weak<Daemon>) {
    let mut interval = tokio::time::interval(TICK);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut n: u64 = 0;
    loop {
        interval.tick().await;
        let Some(d) = daemon.upgrade() else {
            return;
        };
        if d.is_closed() {
            return;
        }
        for msg in d.geo.refresh() {
            d.logs.info(msg);
        }
        if n.is_multiple_of(PEER_SAMPLE_EVERY / TICK.as_secs()) {
            // Before the snapshot: peer traffic never runs ahead of the
            // torrents' traffic it is part of.
            d.sample_peers().await;
        }
        d.scrape_due();
        d.expire_previews().await;
        d.apply_schedule().await;
        d.scan_watch_folders().await;
        d.tick_once().await;
        d.save_resume(ResumeSave::Due).await;
        if let Err(e) = d.flush_records().await {
            d.logs.warn(format!("saving torrent records: {e}"));
        }
        n += 1;
        if n.is_multiple_of(TOTALS_EVERY) {
            d.save_totals().await;
        }
        if let Ok(stats) = &d.stats
            && let Err(e) = stats.flush(now(), Flush::Due, d.stats_retention()).await
        {
            d.logs.warn(format!("saving statistics: {e}"));
        }
    }
}

/// When payload last moved, unix seconds (the library keeps these across
/// restarts).
pub(crate) fn last_activity(s: &TorrentStatus) -> Option<u64> {
    s.last_download.max(s.last_upload)
}

/// Which share limit a seeding torrent has reached, if any.
fn share_limit_reached(
    s: &TorrentStatus,
    e: &Entry,
    settings: &Settings,
    unix: u64,
) -> Option<&'static str> {
    let limits = e.record.share_limits;
    let ratio_limit = match limits.ratio {
        RatioLimit::Global => settings.max_ratio,
        RatioLimit::Unlimited => None,
        RatioLimit::Limit(v) => Some(v),
    };
    let time = |l: TimeLimit, global: Option<u64>| match l {
        TimeLimit::Global => global,
        TimeLimit::Unlimited => None,
        TimeLimit::Limit(v) => Some(v),
    };
    if let Some(limit) = ratio_limit
        && super::view::ratio(s.uploaded, s.downloaded, s.total_wanted_done)
            .is_some_and(|r| r >= limit)
    {
        return Some("ratio");
    }
    if let Some(limit) = time(limits.seeding_time, settings.max_seeding_time)
        && s.seeding_time.as_secs() >= limit
    {
        return Some("seeding time");
    }
    if let Some(limit) = time(
        limits.inactive_seeding_time,
        settings.max_inactive_seeding_time,
    ) {
        let since = last_activity(s).or(s.completed_on).unwrap_or(s.added_on);
        if unix.saturating_sub(since) >= limit {
            return Some("inactive seeding time");
        }
    }
    None
}

impl Daemon {
    /// The alternative-limits scheduler: at each boundary of the window
    /// (and at the first look), switch the alternative limits to match.
    /// A switch by hand in between holds until the next boundary.
    async fn apply_schedule(self: &Arc<Self>) {
        let s = self.settings();
        let Some(schedule) = s.alt_speed_schedule else {
            self.state().scheduled = None;
            return;
        };
        let open = match schedule.contains(jiff::Timestamp::now()) {
            Ok(open) => open,
            Err(e) => {
                tracing::debug!("alternative-limits schedule: {e}");
                return;
            }
        };
        let last = self.state().scheduled.replace(open);
        if last == Some(open) || s.alt_speed_enabled == open {
            return;
        }
        let patch = SettingsPatch {
            alt_speed_enabled: Some(open),
            ..Default::default()
        };
        match self.update_settings(patch).await {
            Ok(_) => self.logs.info(format!(
                "alternative speed limits {} (schedule)",
                if open { "on" } else { "off" }
            )),
            Err(e) => {
                self.state().scheduled = last;
                self.logs.warn(format!("alternative-limits schedule: {e}"));
            }
        }
    }

    /// Scrape the torrents whose last scrape is older than
    /// `stats_scrape_interval` (off by default), a few per tick, for the
    /// swarm's completed downloads in the statistics.
    fn scrape_due(self: &Arc<Self>) {
        let Some(every) = self.settings().stats_scrape_interval else {
            return;
        };
        if !self.stats.as_ref().is_ok_and(|s| s.recording()) {
            return;
        }
        let every = Duration::from_secs(every);
        let due: Vec<TorrentId> = {
            let mut st = self.state();
            let now = std::time::Instant::now();
            st.torrents
                .values_mut()
                .filter(|e| {
                    e.has_trackers && e.last_scrape.is_none_or(|t| now.duration_since(t) >= every)
                })
                .take(SCRAPES_PER_TICK)
                .map(|e| {
                    e.last_scrape = Some(now);
                    e.id
                })
                .collect()
        };
        for id in due {
            // The answers arrive as `ScrapeReply` events.
            let d = self.clone();
            tokio::spawn(async move {
                let _ = d.session.scrape(id).await;
            });
        }
    }

    /// Sample the peers of the torrents that moved data since the last
    /// sample, for the statistics by place.
    async fn sample_peers(&self) {
        let Ok(stats) = &self.stats else {
            return;
        };
        let hashes = stats.take_active();
        let ids: Vec<(InfoHash, TorrentId)> = {
            let st = self.state();
            hashes
                .iter()
                .filter_map(|h| st.torrents.get(h).map(|e| (*h, e.id)))
                .collect()
        };
        for (hash, id) in ids {
            let Ok(peers) = self.session.peers(id).await else {
                continue;
            };
            let samples: Vec<PeerSample> = peers.iter().map(PeerSample::of).collect();
            stats.observe_peers(now(), hash, &samples, &|ip| self.geo.lookup(ip));
        }
    }

    async fn tick_once(self: &Arc<Self>) {
        let Ok(statuses) = self.session.statuses().await else {
            return;
        };
        let recording = self.stats.as_ref().is_ok_and(|s| s.recording());
        let session_stats = if recording {
            self.session.stats().await.ok()
        } else {
            None
        };
        let unix = now();
        let mut hits: Vec<(InfoHash, TorrentId, ShareLimitAction, &'static str)> = Vec::new();
        {
            let mut st = self.state();
            let settings = st.settings.clone();
            for s in &statuses {
                let Some(e) = st.torrents.get_mut(&s.info_hash) else {
                    continue;
                };
                if e.baseline.is_none() {
                    e.baseline = Some((s.downloaded, s.uploaded));
                    if e.resume_restored {
                        e.resume_mark.get_or_insert(super::ResumeMark::of(s));
                    }
                }
                if e.name.as_deref() != Some(s.name.as_str()) {
                    e.name = Some(s.name.clone());
                }
                e.has_trackers = s.trackers_count > 0;
                if s.complete
                    && s.state == L::Seeding
                    && !e.moving
                    && let Some(why) = share_limit_reached(s, e, &settings, unix)
                {
                    let action = e
                        .record
                        .share_limits
                        .action
                        .unwrap_or(settings.share_limit_action);
                    hits.push((s.info_hash, e.id, action, why));
                }
            }
            if let Ok(stats) = &self.stats
                && recording
            {
                // Under the registry lock: a removal cannot slip between a
                // sample and its observation.
                let samples: Vec<Sample<'_>> = statuses
                    .iter()
                    .filter_map(|s| {
                        let e = st.torrents.get(&s.info_hash)?;
                        Some(Sample {
                            hash: s.info_hash,
                            status: s,
                            state: super::view::api_state(s, e.moving),
                            name: e.record.name.as_deref().unwrap_or(&s.name),
                            fresh: !e.resume_restored,
                            ratio: super::view::ratio(
                                s.uploaded,
                                s.downloaded,
                                s.total_wanted_done,
                            ),
                            category: e.record.category.as_deref(),
                            tags: e.record.tags.iter().cloned().collect(),
                            tracker: s
                                .working_tracker
                                .as_deref()
                                .and_then(crate::stats::db::tracker_host),
                        })
                    })
                    .collect();
                stats.observe(unix, &samples, session_stats.as_ref());
            }
        }
        for (hash, id, action, why) in hits {
            let name = self.name_of(&hash);
            let r = match action {
                ShareLimitAction::Stop => self.stop_torrent(hash, id).await,
                ShareLimitAction::Remove => self.remove(hash, id, false).await,
                ShareLimitAction::RemoveWithFiles => self.remove(hash, id, true).await,
            };
            match r {
                Ok(()) => self.logs.info(format!(
                    "{name} reached its {why} limit: {}",
                    match action {
                        ShareLimitAction::Stop => "stopped",
                        ShareLimitAction::Remove => "removed",
                        ShareLimitAction::RemoveWithFiles => "removed with its files",
                    }
                )),
                Err(e) => self.logs.warn(format!("share limit action on {name}: {e}")),
            }
        }
    }
}
