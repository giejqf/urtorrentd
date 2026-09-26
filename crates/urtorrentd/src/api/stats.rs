// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/stats`: recorded history (ADR 0005). Series are bytes and seconds per
//! bucket, from differences of the library's counters; buckets in which
//! nothing moved are left out, and `periods` says when anything was recorded.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;

use super::{HashPath, Json, Path, Query, no_content};
use crate::daemon::Daemon;
use crate::error::ApiResult;
use crate::model::{
    GeoQuery, GeoStats, GroupQuery, GroupStats, IdleQuery, IdleSeeds, PeerBreakdown, PeerQuery,
    StatsInfo, StatsRangeQuery, TimelineEvent, TimelineQuery, TopQuery, TopTorrents, TorrentDays,
    TorrentTraffic, TrackerQuery, TrackerStats, TransferStats,
};

/// What the statistics database holds.
#[utoipa::path(get, path = "/stats", tag = "stats", responses((status = 200, body = StatsInfo)))]
pub(crate) async fn get_stats_info(State(d): State<Arc<Daemon>>) -> ApiResult<Json<StatsInfo>> {
    Ok(Json(d.stats_info().await?))
}

/// Delete every statistic: traffic, days, the timeline and recording
/// periods of every torrent, removed ones included (the file shrinks).
/// Settings stay; recording goes on if it is on.
#[utoipa::path(delete, path = "/stats", tag = "stats", responses((status = 204, description = "Deleted.")))]
pub(crate) async fn delete_stats(State(d): State<Arc<Daemon>>) -> ApiResult<StatusCode> {
    d.clear_stats().await?;
    Ok(no_content())
}

/// Delete the history of every torrent removed from the session
/// (`removed` in `GET /stats`).
#[utoipa::path(delete, path = "/stats/removed", tag = "stats", responses((status = 204, description = "Deleted.")))]
pub(crate) async fn delete_removed_stats(State(d): State<Arc<Daemon>>) -> ApiResult<StatusCode> {
    d.purge_removed_stats().await?;
    Ok(no_content())
}

/// Session-wide traffic over time.
#[utoipa::path(get, path = "/stats/transfer", tag = "stats", params(StatsRangeQuery), responses((status = 200, body = TransferStats)))]
pub(crate) async fn get_transfer_stats(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<StatsRangeQuery>,
) -> ApiResult<Json<TransferStats>> {
    Ok(Json(d.transfer_stats(q).await?))
}

/// One torrent's traffic over time (removed torrents too).
#[utoipa::path(get, path = "/stats/torrents/{hash}/traffic", tag = "stats", params(HashPath, StatsRangeQuery), responses((status = 200, body = TorrentTraffic)))]
pub(crate) async fn get_torrent_traffic(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
    Query(q): Query<StatsRangeQuery>,
) -> ApiResult<Json<TorrentTraffic>> {
    Ok(Json(d.torrent_traffic(&p.hash, q).await?))
}

/// One torrent's days: its seeding history (removed torrents too). The
/// default range is the last 30 days; `step` is ignored.
#[utoipa::path(get, path = "/stats/torrents/{hash}/days", tag = "stats", params(HashPath, StatsRangeQuery), responses((status = 200, body = TorrentDays)))]
pub(crate) async fn get_torrent_days(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
    Query(q): Query<StatsRangeQuery>,
) -> ApiResult<Json<TorrentDays>> {
    Ok(Json(d.torrent_days(&p.hash, q).await?))
}

/// Delete a torrent's history (a torrent still in the session starts a new
/// one).
#[utoipa::path(delete, path = "/stats/torrents/{hash}", tag = "stats", params(HashPath), responses((status = 204, description = "Deleted.")))]
pub(crate) async fn delete_torrent_stats(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
) -> ApiResult<StatusCode> {
    d.purge_torrent_stats(&p.hash).await?;
    Ok(no_content())
}

/// Torrents ranked by their traffic over a range.
#[utoipa::path(get, path = "/stats/top", tag = "stats", params(TopQuery), responses((status = 200, body = TopTorrents)))]
pub(crate) async fn get_top_torrents(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<TopQuery>,
) -> ApiResult<Json<TopTorrents>> {
    Ok(Json(d.top_torrents(q).await?))
}

/// Peer traffic by country or autonomous system (all torrents, or one), with
/// what could not be tied to a peer. Needs a GeoIP database to locate peers
/// (settings `geoip_database`, `geoip_asn_database`); without one, traffic
/// is recorded as not located.
#[utoipa::path(get, path = "/stats/geo", tag = "stats", params(GeoQuery), responses((status = 200, body = GeoStats)))]
pub(crate) async fn get_geo_stats(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<GeoQuery>,
) -> ApiResult<Json<GeoStats>> {
    Ok(Json(d.geo_stats(q).await?))
}

/// Peer traffic by client, discovery source, transport, encryption, IP
/// version or direction (all torrents, or one), with what could not be tied
/// to a peer.
#[utoipa::path(get, path = "/stats/peers", tag = "stats", params(PeerQuery), responses((status = 200, body = PeerBreakdown)))]
pub(crate) async fn get_peer_stats(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<PeerQuery>,
) -> ApiResult<Json<PeerBreakdown>> {
    Ok(Json(d.peer_stats(q).await?))
}

/// Traffic by category or tag.
#[utoipa::path(get, path = "/stats/groups", tag = "stats", params(GroupQuery), responses((status = 200, body = GroupStats)))]
pub(crate) async fn get_group_stats(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<GroupQuery>,
) -> ApiResult<Json<GroupStats>> {
    Ok(Json(d.group_stats(q).await?))
}

/// Per tracker (by host): the traffic of the torrents working with it, and
/// its announces answered and failed.
#[utoipa::path(get, path = "/stats/trackers", tag = "stats", params(TrackerQuery), responses((status = 200, body = TrackerStats)))]
pub(crate) async fn get_tracker_stats(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<TrackerQuery>,
) -> ApiResult<Json<TrackerStats>> {
    Ok(Json(d.tracker_stats(q).await?))
}

/// Complete torrents by what they uploaded in the last days relative to
/// their size, least first: what to remove to win back disk space.
#[utoipa::path(get, path = "/stats/idle-seeds", tag = "stats", params(IdleQuery), responses((status = 200, body = IdleSeeds)))]
pub(crate) async fn get_idle_seeds(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<IdleQuery>,
) -> ApiResult<Json<IdleSeeds>> {
    Ok(Json(d.idle_seeds(q).await?))
}

/// What happened to torrents, newest first.
#[utoipa::path(get, path = "/stats/timeline", tag = "stats", params(TimelineQuery), responses((status = 200, body = Vec<TimelineEvent>)))]
pub(crate) async fn get_timeline(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<TimelineQuery>,
) -> ApiResult<Json<Vec<TimelineEvent>>> {
    Ok(Json(d.timeline(q).await?))
}
