// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The `/stats` queries. Each one flushes first, so it sees everything up to
//! the last tick.

use std::sync::Arc;

use super::db::{Period, Retention, StatsDb, TorrentRow};
use super::{Flush, Stats};
use crate::daemon::Daemon;
use crate::error::{ApiError, ApiResult};
use crate::model::{
    StatsInfo, StatsPeriod, StatsRangeQuery, StatsStep, TimelineEvent, TimelineQuery, TopMetric,
    TopQuery, TopTorrent, TopTorrents, TorrentDay, TorrentDays, TorrentTraffic, TrafficPoint,
    TransferPoint, TransferStats,
};
use crate::util::{blocking, hex, now, parse_hash};

/// Most buckets one series returns.
pub(crate) const MAX_POINTS: u64 = 10_000;
/// The default range: the last day.
const DEFAULT_SPAN: u64 = 86_400;

/// `from` and `to` with their defaults.
fn range(from: Option<u64>, to: Option<u64>, now: u64, span: Option<u64>) -> ApiResult<(u64, u64)> {
    let to = to.unwrap_or(now);
    let from = from.unwrap_or_else(|| span.map_or(0, |s| to.saturating_sub(s)));
    if from > to {
        return Err(ApiError::bad_request("`from` is after `to`"));
    }
    Ok((from, to))
}

/// The requested step, or the finest one kept for the whole range (with at
/// most [`MAX_POINTS`] buckets when `capped`).
pub(crate) fn pick_step(
    requested: Option<StatsStep>,
    from: u64,
    to: u64,
    now: u64,
    retention: &Retention,
    capped: bool,
) -> ApiResult<StatsStep> {
    let buckets = |s: StatsStep| (to - from) / s.secs() + 1;
    if let Some(s) = requested {
        if capped && buckets(s) > MAX_POINTS {
            return Err(ApiError::bad_request(format!(
                "that range has more than {MAX_POINTS} buckets of that step; use a larger step or a shorter range"
            )));
        }
        return Ok(s);
    }
    Ok(StatsStep::ALL
        .into_iter()
        .find(|&s| {
            let kept = retention
                .of(s)
                .is_none_or(|keep| s.start(from) >= now.saturating_sub(keep));
            kept && (!capped || buckets(s) <= MAX_POINTS)
        })
        .unwrap_or(StatsStep::Day))
}

fn period(p: Period, current: Option<i64>) -> StatsPeriod {
    let live = current == Some(p.id);
    StatsPeriod {
        started: p.started,
        ended: if live {
            None
        } else {
            Some(p.stopped.unwrap_or(p.last_seen))
        },
        clean: live || p.stopped.is_some(),
    }
}

fn parse(hash: &str) -> ApiResult<String> {
    parse_hash(hash)
        .map(|h| hex(&h))
        .ok_or_else(|| ApiError::bad_request(format!("{hash:?} is not an info-hash")))
}

fn no_history(hash: &str) -> ApiError {
    ApiError::not_found(format!("no statistics for info-hash {hash}"))
}

impl Daemon {
    fn stats_handle(&self) -> ApiResult<&Stats> {
        self.stats
            .as_ref()
            .map_err(|e| ApiError::unavailable(format!("statistics are unavailable: {e}")))
    }

    /// The retention in force.
    pub(crate) fn stats_retention(&self) -> Retention {
        let s = self.settings();
        Retention {
            minute: s.stats_minute_retention,
            hour: s.stats_hour_retention,
            day: s.stats_day_retention,
        }
    }

    /// The database after a flush, and the current period.
    async fn stats_db(&self) -> ApiResult<(Arc<StatsDb>, Option<i64>)> {
        let s = self.stats_handle()?;
        s.flush(now(), Flush::All, self.stats_retention())
            .await
            .map_err(ApiError::io)?;
        Ok((s.db(), s.period()))
    }

    async fn stats_torrent(&self, db: &Arc<StatsDb>, hash: &str) -> ApiResult<TorrentRow> {
        let h = parse(hash)?;
        let db = db.clone();
        let key = h.clone();
        blocking(move || db.torrent(&key))
            .await
            .map_err(ApiError::io)?
            .ok_or_else(|| no_history(&h))
    }

    /// What the database holds.
    pub(crate) async fn stats_info(&self) -> ApiResult<StatsInfo> {
        let (db, current) = self.stats_db().await?;
        let info = blocking(move || db.info()).await.map_err(ApiError::io)?;
        Ok(StatsInfo {
            enabled: current.is_some(),
            size: info.size,
            torrents: info.torrents,
            oldest_minute: info.oldest[0],
            oldest_hour: info.oldest[1],
            oldest_day: info.oldest[2],
        })
    }

    /// Session-wide traffic over time.
    pub(crate) async fn transfer_stats(&self, q: StatsRangeQuery) -> ApiResult<TransferStats> {
        let t = now();
        let (from, to) = range(q.from, q.to, t, Some(DEFAULT_SPAN))?;
        let step = pick_step(q.step, from, to, t, &self.stats_retention(), true)?;
        let (db, current) = self.stats_db().await?;
        let (points, periods) =
            blocking(move || Ok((db.session(step, from, to)?, db.periods(from, to)?)))
                .await
                .map_err(ApiError::io)?;
        Ok(TransferStats {
            from,
            to,
            step,
            points: points
                .into_iter()
                .map(|(t, x)| TransferPoint {
                    t,
                    downloaded: x.downloaded,
                    uploaded: x.uploaded,
                    peers_max: x.peers_max,
                    connections_max: x.connections_max,
                    dht_nodes_max: x.dht_nodes_max,
                    torrents_max: x.torrents_max,
                })
                .collect(),
            periods: periods.into_iter().map(|p| period(p, current)).collect(),
        })
    }

    /// One torrent's traffic over time.
    pub(crate) async fn torrent_traffic(
        &self,
        hash: &str,
        q: StatsRangeQuery,
    ) -> ApiResult<TorrentTraffic> {
        let t = now();
        let (from, to) = range(q.from, q.to, t, Some(DEFAULT_SPAN))?;
        let step = pick_step(q.step, from, to, t, &self.stats_retention(), true)?;
        let (db, current) = self.stats_db().await?;
        let row = self.stats_torrent(&db, hash).await?;
        let id = row.id;
        let (points, periods) =
            blocking(move || Ok((db.traffic(id, step, from, to)?, db.periods(from, to)?)))
                .await
                .map_err(ApiError::io)?;
        Ok(TorrentTraffic {
            hash: row.hash,
            name: row.name,
            removed: row.removed,
            from,
            to,
            step,
            points: points
                .into_iter()
                .map(|(t, x)| TrafficPoint {
                    t,
                    downloaded: x.downloaded,
                    uploaded: x.uploaded,
                    peers_max: x.peers_max,
                    seeds_max: x.seeds_max,
                })
                .collect(),
            periods: periods.into_iter().map(|p| period(p, current)).collect(),
        })
    }

    /// One torrent's days.
    pub(crate) async fn torrent_days(
        &self,
        hash: &str,
        q: StatsRangeQuery,
    ) -> ApiResult<TorrentDays> {
        let t = now();
        let (from, to) = range(q.from, q.to, t, Some(30 * DEFAULT_SPAN))?;
        if pick_step(
            Some(StatsStep::Day),
            from,
            to,
            t,
            &Retention::default(),
            true,
        )
        .is_err()
        {
            return Err(ApiError::bad_request(format!(
                "at most {MAX_POINTS} days at once"
            )));
        }
        let (db, _) = self.stats_db().await?;
        let row = self.stats_torrent(&db, hash).await?;
        let id = row.id;
        let days = blocking(move || db.days(id, from, to))
            .await
            .map_err(ApiError::io)?;
        Ok(TorrentDays {
            hash: row.hash,
            name: row.name,
            removed: row.removed,
            from,
            to,
            days: days
                .into_iter()
                .map(|(t, d)| TorrentDay {
                    t,
                    downloaded: d.traffic.downloaded,
                    uploaded: d.traffic.uploaded,
                    peers_max: d.traffic.peers_max,
                    seeds_max: d.traffic.seeds_max,
                    active_time: d.active_time,
                    seeding_time: d.seeding_time,
                    downloaded_total: d.totals.downloaded,
                    uploaded_total: d.totals.uploaded,
                    active_time_total: d.totals.active_time,
                    seeding_time_total: d.totals.seeding_time,
                    ratio: d.totals.ratio,
                    swarm_seeds_max: d.swarm_seeds_max,
                    swarm_leechers_max: d.swarm_leechers_max,
                })
                .collect(),
        })
    }

    /// Torrents ranked by traffic over a range.
    pub(crate) async fn top_torrents(&self, q: TopQuery) -> ApiResult<TopTorrents> {
        let t = now();
        let (from, to) = range(q.from, q.to, t, Some(DEFAULT_SPAN))?;
        let limit = q.limit.unwrap_or(10);
        if !(1..=1000).contains(&limit) {
            return Err(ApiError::bad_request("`limit` must be 1 to 1000"));
        }
        let step = pick_step(None, from, to, t, &self.stats_retention(), false)?;
        let by_upload = q.by.unwrap_or(TopMetric::Uploaded) == TopMetric::Uploaded;
        let (db, _) = self.stats_db().await?;
        let rows = blocking(move || db.top(step, from, to, by_upload, limit))
            .await
            .map_err(ApiError::io)?;
        Ok(TopTorrents {
            from,
            to,
            step,
            torrents: rows
                .into_iter()
                .map(|(r, x)| TopTorrent {
                    hash: r.hash,
                    name: r.name,
                    removed: r.removed,
                    downloaded: x.downloaded,
                    uploaded: x.uploaded,
                })
                .collect(),
        })
    }

    /// The timeline, newest first.
    pub(crate) async fn timeline(&self, q: TimelineQuery) -> ApiResult<Vec<TimelineEvent>> {
        let (from, to) = range(q.from, q.to, now(), None)?;
        let limit = q.limit.unwrap_or(100);
        if !(1..=10_000).contains(&limit) {
            return Err(ApiError::bad_request("`limit` must be 1 to 10000"));
        }
        let (db, _) = self.stats_db().await?;
        let torrent = match &q.hash {
            Some(h) => Some(self.stats_torrent(&db, h).await?.id),
            None => None,
        };
        let rows = blocking(move || db.timeline(torrent, from, to, limit))
            .await
            .map_err(ApiError::io)?;
        Ok(rows
            .into_iter()
            .map(|(e, name)| TimelineEvent {
                t: e.t,
                hash: e.hash,
                name,
                kind: e.kind,
                state: e.state,
                detail: e.detail,
            })
            .collect())
    }

    /// Delete a torrent's history.
    pub(crate) async fn purge_torrent_stats(&self, hash: &str) -> ApiResult<()> {
        let (db, _) = self.stats_db().await?;
        let h = parse(hash)?;
        let key = h.clone();
        if blocking(move || db.purge(&key))
            .await
            .map_err(ApiError::io)?
        {
            Ok(())
        } else {
            Err(no_history(&h))
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn steps_follow_retention_and_size() {
        let r = Retention {
            minute: Some(2 * 86_400),
            hour: Some(90 * 86_400),
            day: None,
        };
        let now = 400 * 86_400;
        let day = |n: u64| now - n * 86_400;
        assert_eq!(
            pick_step(None, day(1), now, now, &r, true).unwrap(),
            StatsStep::Minute
        );
        // Minutes are kept for two days, but a week of them is too many.
        assert_eq!(
            pick_step(None, day(3), now, now, &r, true).unwrap(),
            StatsStep::Hour
        );
        assert_eq!(
            pick_step(None, day(100), now, now, &r, true).unwrap(),
            StatsStep::Day
        );
        assert_eq!(
            pick_step(None, day(3), now, now, &r, false).unwrap(),
            StatsStep::Hour
        );
        assert_eq!(
            pick_step(Some(StatsStep::Minute), day(1), now, now, &r, true).unwrap(),
            StatsStep::Minute
        );
        assert!(pick_step(Some(StatsStep::Minute), day(30), now, now, &r, true).is_err());
        assert!(range(Some(5), Some(4), now, None).is_err());
        assert_eq!(
            range(None, Some(100_000), now, Some(DEFAULT_SPAN)).unwrap(),
            (13_600, 100_000)
        );
    }
}
