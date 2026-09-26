// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The `/stats` queries. Each one flushes first, so it sees everything up to
//! the last tick.

use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;

use super::db::{Period, Retention, StatsDb, TorrentRow, tracker_host};
use super::{Flush, Stats};
use crate::daemon::Daemon;
use crate::error::{ApiError, ApiResult};
use crate::log::LogTopic;
use crate::model::{
    ByteTotals, GeoDimension, GeoPoint, GeoQuery, GeoRow, GeoStats, GroupKind, GroupPoint,
    GroupQuery, GroupRow, GroupStats, IdleQuery, IdleSeed, IdleSeeds, PeerBreakdown, PeerDimension,
    PeerPoint, PeerQuery, PeerRow, StatsInfo, StatsPeriod, StatsRangeQuery, StatsStep,
    TimelineEvent, TimelineQuery, TopMetric, TopQuery, TopTorrent, TopTorrents, TorrentDay,
    TorrentDays, TorrentTraffic, TrackerPoint, TrackerQuery, TrackerRow, TrackerStats,
    TrafficPoint, TransferPoint, TransferStats,
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

/// The requested step, or the finest of `steps` kept for the whole range
/// (with at most [`MAX_POINTS`] buckets when `capped`).
pub(crate) fn pick_step(
    steps: &[StatsStep],
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
    Ok(steps
        .iter()
        .copied()
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

/// The shared parameters of the peer breakdowns.
struct Breakdown<'a> {
    hash: Option<&'a str>,
    from: Option<u64>,
    to: Option<u64>,
    step: Option<StatsStep>,
    by: Option<TopMetric>,
    limit: Option<u32>,
    series: Option<bool>,
}

/// What a peer breakdown found.
struct Parts {
    hash: Option<String>,
    from: u64,
    to: u64,
    step: StatsStep,
    rows: Vec<(String, u64, u64, u32)>,
    points: Vec<(u64, String, super::db::PeerTraffic)>,
    unattributed: ByteTotals,
    names: HashMap<u32, String>,
}

/// `limit` with its default, within `1..=max`.
fn check_limit(limit: Option<u32>, default: u32, max: u32) -> ApiResult<u32> {
    let limit = limit.unwrap_or(default);
    if (1..=max).contains(&limit) {
        Ok(limit)
    } else {
        Err(ApiError::bad_request(format!("`limit` must be 1 to {max}")))
    }
}

/// A series of `limit` keys over the range must stay within 10 × the
/// bucket cap.
fn check_series(series: bool, from: u64, to: u64, step: StatsStep, limit: u32) -> ApiResult<()> {
    if series && ((to - from) / step.secs() + 1) * u64::from(limit) > 10 * MAX_POINTS {
        return Err(ApiError::bad_request(format!(
            "a series of more than {} points; use a larger step, a shorter range or a lower limit",
            10 * MAX_POINTS
        )));
    }
    Ok(())
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
            removed: info.removed,
        })
    }

    /// Delete every statistic (`DELETE /stats`).
    pub(crate) async fn clear_stats(&self) -> ApiResult<()> {
        // Not while recording is switched on or off.
        let _ops = self.ops.lock().await;
        let s = self.stats_handle()?;
        s.clear(now()).await.map_err(ApiError::io)?;
        self.logs
            .info(LogTopic::Statistics, "statistics deleted through the API");
        Ok(())
    }

    /// Delete the history of removed torrents; returns how many.
    pub(crate) async fn purge_removed_stats(&self) -> ApiResult<u64> {
        let (db, _) = self.stats_db().await?;
        let n = blocking(move || db.purge_removed())
            .await
            .map_err(ApiError::io)?;
        if n > 0 {
            self.logs.info(
                LogTopic::Statistics,
                format!(
                    "history of {n} removed torrent{} deleted through the API",
                    if n == 1 { "" } else { "s" }
                ),
            );
        }
        Ok(n)
    }

    /// Session-wide traffic over time.
    pub(crate) async fn transfer_stats(&self, q: StatsRangeQuery) -> ApiResult<TransferStats> {
        let t = now();
        let (from, to) = range(q.from, q.to, t, Some(DEFAULT_SPAN))?;
        let step = pick_step(
            &StatsStep::ALL,
            q.step,
            from,
            to,
            t,
            &self.stats_retention(),
            true,
        )?;
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
        let step = pick_step(
            &StatsStep::ALL,
            q.step,
            from,
            to,
            t,
            &self.stats_retention(),
            true,
        )?;
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
            &StatsStep::ALL,
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
                    swarm_completed_max: d.swarm_completed_max,
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
        let step = pick_step(
            &StatsStep::ALL,
            None,
            from,
            to,
            t,
            &self.stats_retention(),
            false,
        )?;
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

    /// Peer traffic by one dimension (the shared part of `/stats/geo` and
    /// `/stats/peers`).
    async fn breakdown(&self, dim: &'static str, q: Breakdown<'_>) -> ApiResult<Parts> {
        let t = now();
        let (from, to) = range(q.from, q.to, t, Some(DEFAULT_SPAN))?;
        if q.step == Some(StatsStep::Minute) {
            return Err(ApiError::bad_request(
                "peer traffic is kept per hour and per day",
            ));
        }
        let steps = [StatsStep::Hour, StatsStep::Day];
        let step = pick_step(&steps, q.step, from, to, t, &self.stats_retention(), true)?;
        let limit = check_limit(q.limit, 20, 250)?;
        let series = q.series.unwrap_or(false);
        check_series(series, from, to, step, limit)?;
        let by_upload = q.by.unwrap_or(TopMetric::Uploaded) == TopMetric::Uploaded;
        let (db, _) = self.stats_db().await?;
        let (hash, torrent) = match q.hash {
            Some(h) => {
                let row = self.stats_torrent(&db, h).await?;
                (Some(row.hash), Some(row.id))
            }
            None => (None, None),
        };
        let asn = dim == "asn";
        let (rows, points, (attributed, traffic), names) = blocking(move || {
            let rows = db.places(torrent, step, dim, from, to, by_upload, limit)?;
            let keys: Vec<String> = rows.iter().map(|p| p.0.clone()).collect();
            let points = if series {
                db.place_series(torrent, step, dim, from, to, &keys)?
            } else {
                Vec::new()
            };
            let names = if asn {
                let asns: Vec<u32> = keys.iter().filter_map(|k| k.parse().ok()).collect();
                db.asn_names(&asns)?
            } else {
                Default::default()
            };
            Ok((
                rows,
                points,
                db.attribution(torrent, step, dim, from, to)?,
                names,
            ))
        })
        .await
        .map_err(ApiError::io)?;
        Ok(Parts {
            hash,
            from,
            to,
            step,
            rows,
            points,
            unattributed: ByteTotals {
                downloaded: traffic.0.saturating_sub(attributed.0),
                uploaded: traffic.1.saturating_sub(attributed.1),
            },
            names,
        })
    }

    /// Peer traffic by place.
    pub(crate) async fn geo_stats(&self, q: GeoQuery) -> ApiResult<GeoStats> {
        let dim = q.dim.unwrap_or(GeoDimension::Country);
        let p = self
            .breakdown(
                match dim {
                    GeoDimension::Country => "country",
                    GeoDimension::Asn => "asn",
                },
                Breakdown {
                    hash: q.hash.as_deref(),
                    from: q.from,
                    to: q.to,
                    step: q.step,
                    by: q.by,
                    limit: q.limit,
                    series: q.series,
                },
            )
            .await?;
        // A place's key: a country code or an AS number; "" = not located.
        let place = |key: &str| match dim {
            GeoDimension::Country => (Some(key.to_string()).filter(|k| !k.is_empty()), None),
            GeoDimension::Asn => (None, key.parse::<u32>().ok()),
        };
        let names = p.names;
        Ok(GeoStats {
            hash: p.hash,
            from: p.from,
            to: p.to,
            step: p.step,
            dim,
            rows: p
                .rows
                .into_iter()
                .map(|(key, downloaded, uploaded, peers_max)| {
                    let (country, asn) = place(&key);
                    GeoRow {
                        country,
                        asn,
                        as_org: asn.and_then(|a| names.get(&a).cloned()),
                        downloaded,
                        uploaded,
                        peers_max,
                    }
                })
                .collect(),
            points: p
                .points
                .into_iter()
                .map(|(t, key, x)| {
                    let (country, asn) = place(&key);
                    GeoPoint {
                        t,
                        country,
                        asn,
                        downloaded: x.downloaded,
                        uploaded: x.uploaded,
                        peers: x.peers,
                    }
                })
                .collect(),
            unattributed: p.unattributed,
            located: self.geo.enabled(),
        })
    }

    /// Peer traffic by client, source, transport, encryption, IP version or
    /// direction.
    pub(crate) async fn peer_stats(&self, q: PeerQuery) -> ApiResult<PeerBreakdown> {
        let tag = match q.dim {
            PeerDimension::Client => "client",
            PeerDimension::Source => "source",
            PeerDimension::Transport => "transport",
            PeerDimension::Encryption => "encryption",
            PeerDimension::IpVersion => "ip_version",
            PeerDimension::Direction => "direction",
        };
        let p = self
            .breakdown(
                tag,
                Breakdown {
                    hash: q.hash.as_deref(),
                    from: q.from,
                    to: q.to,
                    step: q.step,
                    by: q.by,
                    limit: q.limit,
                    series: q.series,
                },
            )
            .await?;
        let key = |k: String| Some(k).filter(|k| !k.is_empty());
        Ok(PeerBreakdown {
            hash: p.hash,
            from: p.from,
            to: p.to,
            step: p.step,
            dim: q.dim,
            rows: p
                .rows
                .into_iter()
                .map(|(k, downloaded, uploaded, peers_max)| PeerRow {
                    key: key(k),
                    downloaded,
                    uploaded,
                    peers_max,
                })
                .collect(),
            points: p
                .points
                .into_iter()
                .map(|(t, k, x)| PeerPoint {
                    t,
                    key: key(k),
                    downloaded: x.downloaded,
                    uploaded: x.uploaded,
                    peers: x.peers,
                })
                .collect(),
            unattributed: p.unattributed,
        })
    }

    /// Traffic by category or tag.
    pub(crate) async fn group_stats(&self, q: GroupQuery) -> ApiResult<GroupStats> {
        let t = now();
        let (from, to) = range(q.from, q.to, t, Some(DEFAULT_SPAN))?;
        let step = pick_step(
            &StatsStep::ALL,
            q.step,
            from,
            to,
            t,
            &self.stats_retention(),
            true,
        )?;
        let limit = check_limit(q.limit, 20, 250)?;
        let series = q.series.unwrap_or(false);
        check_series(series, from, to, step, limit)?;
        let by_upload = q.by.unwrap_or(TopMetric::Uploaded) == TopMetric::Uploaded;
        let tags = q.group == GroupKind::Tag;
        let (db, _) = self.stats_db().await?;
        let (rows, points) = blocking(move || {
            let rows = db.groups(tags, step, from, to, by_upload, limit)?;
            let points = if series {
                let keys: Vec<Option<String>> = rows.iter().map(|r| r.0.clone()).collect();
                db.group_series(tags, step, from, to, &keys)?
            } else {
                Vec::new()
            };
            Ok((rows, points))
        })
        .await
        .map_err(ApiError::io)?;
        Ok(GroupStats {
            from,
            to,
            step,
            group: q.group,
            rows: rows
                .into_iter()
                .map(|(key, downloaded, uploaded, torrents)| GroupRow {
                    key,
                    downloaded,
                    uploaded,
                    torrents,
                })
                .collect(),
            points: points
                .into_iter()
                .map(|(t, key, downloaded, uploaded)| GroupPoint {
                    t,
                    key,
                    downloaded,
                    uploaded,
                })
                .collect(),
        })
    }

    /// Per tracker host: traffic and announces.
    pub(crate) async fn tracker_stats(&self, q: TrackerQuery) -> ApiResult<TrackerStats> {
        let t = now();
        let (from, to) = range(q.from, q.to, t, Some(DEFAULT_SPAN))?;
        if q.step == Some(StatsStep::Minute) {
            return Err(ApiError::bad_request(
                "tracker statistics are kept per hour and per day",
            ));
        }
        let steps = [StatsStep::Hour, StatsStep::Day];
        let step = pick_step(&steps, q.step, from, to, t, &self.stats_retention(), false)?;
        let limit = check_limit(q.limit, 50, 250)?;
        let series = q.series.unwrap_or(false);
        check_series(series, from, to, step, limit)?;
        let by_upload = q.by.unwrap_or(TopMetric::Uploaded) == TopMetric::Uploaded;
        let (db, _) = self.stats_db().await?;
        let db2 = db.clone();
        let (traffic, announces) = blocking(move || db2.trackers(step, from, to))
            .await
            .map_err(ApiError::io)?;
        let mut rows: BTreeMap<Option<String>, TrackerRow> = BTreeMap::new();
        for (host, downloaded, uploaded, torrents) in traffic {
            rows.insert(
                host.clone(),
                TrackerRow {
                    host,
                    downloaded,
                    uploaded,
                    torrents,
                    announces: 0,
                    announce_errors: 0,
                },
            );
        }
        for (host, replies, errors) in announces {
            let r = rows.entry(Some(host.clone())).or_insert(TrackerRow {
                host: Some(host),
                downloaded: 0,
                uploaded: 0,
                torrents: 0,
                announces: 0,
                announce_errors: 0,
            });
            r.announces = replies;
            r.announce_errors = errors;
        }
        let mut rows: Vec<TrackerRow> = rows.into_values().collect();
        rows.sort_by(|a, b| {
            let key = |r: &TrackerRow| {
                if by_upload {
                    (r.uploaded, r.downloaded)
                } else {
                    (r.downloaded, r.uploaded)
                }
            };
            key(b)
                .cmp(&key(a))
                .then(b.announces.cmp(&a.announces))
                .then(a.host.cmp(&b.host))
        });
        rows.truncate(limit as usize);
        let points = if series {
            let hosts: Vec<Option<String>> = rows.iter().map(|r| r.host.clone()).collect();
            blocking(move || db.tracker_series(step, from, to, &hosts))
                .await
                .map_err(ApiError::io)?
        } else {
            Vec::new()
        };
        Ok(TrackerStats {
            from,
            to,
            step,
            rows,
            points: points
                .into_iter()
                .map(
                    |(t, host, downloaded, uploaded, announces, announce_errors)| TrackerPoint {
                        t,
                        host,
                        downloaded,
                        uploaded,
                        announces,
                        announce_errors,
                    },
                )
                .collect(),
        })
    }

    /// Complete torrents by what they uploaded in the window relative to
    /// their size, least first.
    pub(crate) async fn idle_seeds(&self, q: IdleQuery) -> ApiResult<IdleSeeds> {
        let days = q.days.unwrap_or(30);
        if !(1..=365).contains(&days) {
            return Err(ApiError::bad_request("`days` must be 1 to 365"));
        }
        let limit = check_limit(q.limit, 50, 1000)?;
        let from = StatsStep::Day
            .start(now())
            .saturating_sub(u64::from(days - 1) * StatsStep::Day.secs());
        let (db, _) = self.stats_db().await?;
        let (window, first) = blocking(move || Ok((db.seeding_since(from)?, db.first_recorded()?)))
            .await
            .map_err(ApiError::io)?;
        let statuses = self.session.statuses().await?;
        let mut out: Vec<IdleSeed> = {
            let st = self.state();
            statuses
                .iter()
                .filter(|s| s.complete)
                .filter_map(|s| {
                    let e = st.torrents.get(&s.info_hash)?;
                    let hash = hex(&s.info_hash);
                    let (uploaded, seeding_time) = window.get(&hash).copied().unwrap_or((0, 0));
                    let size = s.total_wanted;
                    Some(IdleSeed {
                        name: e.record.name.clone().unwrap_or_else(|| s.name.clone()),
                        hash,
                        size,
                        uploaded,
                        value: if size == 0 {
                            0.0
                        } else {
                            uploaded as f64 / size as f64
                        },
                        seeding_time,
                        last_upload: s.last_upload,
                        ratio: crate::daemon::view::ratio(
                            s.uploaded,
                            s.downloaded,
                            s.total_wanted_done,
                        ),
                        added_on: s.added_on,
                        state: crate::daemon::view::api_state(s, e.moving),
                        category: e.record.category.clone(),
                        tracker: s.working_tracker.as_deref().and_then(tracker_host),
                    })
                })
                .collect()
        };
        // Least shared first; among equals the biggest (most disk to win
        // back), then the longest idle.
        out.sort_by(|a, b| {
            a.value
                .total_cmp(&b.value)
                .then(b.size.cmp(&a.size))
                .then(a.last_upload.cmp(&b.last_upload))
                .then(a.hash.cmp(&b.hash))
        });
        out.truncate(limit as usize);
        Ok(IdleSeeds {
            from,
            recorded_from: first.map(|f| f.max(from)),
            torrents: out,
        })
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
            pick_step(&StatsStep::ALL, None, day(1), now, now, &r, true).unwrap(),
            StatsStep::Minute
        );
        // Minutes are kept for two days, but a week of them is too many.
        assert_eq!(
            pick_step(&StatsStep::ALL, None, day(3), now, now, &r, true).unwrap(),
            StatsStep::Hour
        );
        assert_eq!(
            pick_step(&StatsStep::ALL, None, day(100), now, now, &r, true).unwrap(),
            StatsStep::Day
        );
        assert_eq!(
            pick_step(&StatsStep::ALL, None, day(3), now, now, &r, false).unwrap(),
            StatsStep::Hour
        );
        assert_eq!(
            pick_step(
                &StatsStep::ALL,
                Some(StatsStep::Minute),
                day(1),
                now,
                now,
                &r,
                true
            )
            .unwrap(),
            StatsStep::Minute
        );
        assert!(
            pick_step(
                &StatsStep::ALL,
                Some(StatsStep::Minute),
                day(30),
                now,
                now,
                &r,
                true
            )
            .is_err()
        );
        assert!(range(Some(5), Some(4), now, None).is_err());
        assert_eq!(
            range(None, Some(100_000), now, Some(DEFAULT_SPAN)).unwrap(),
            (13_600, 100_000)
        );
    }
}
