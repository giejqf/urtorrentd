// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The periodic tick: per-run baselines, share limits, resume data that is
//! due, changed records, and the all-time totals. Policy only: it reads
//! snapshots and calls public operations.

use std::sync::{Arc, Weak};
use std::time::Duration;

use urtorrent::{InfoHash, TorrentId, TorrentState as L, TorrentStatus};

use super::{Daemon, Entry, ResumeSave};
use crate::settings::{Settings, ShareLimitAction};
use crate::store::{RatioLimit, TimeLimit};
use crate::util::now;

const TICK: Duration = Duration::from_secs(2);
/// Totals are saved every this many ticks (and at shutdown).
const TOTALS_EVERY: u64 = 30;

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
        d.tick_once().await;
        d.save_resume(ResumeSave::Due).await;
        if let Err(e) = d.flush_records().await {
            d.logs.warn(format!("saving torrent records: {e}"));
        }
        n += 1;
        if n.is_multiple_of(TOTALS_EVERY) {
            d.save_totals().await;
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
    async fn tick_once(self: &Arc<Self>) {
        let Ok(statuses) = self.session.statuses().await else {
            return;
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
                }
                if e.name.as_deref() != Some(s.name.as_str()) {
                    e.name = Some(s.name.clone());
                }
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
