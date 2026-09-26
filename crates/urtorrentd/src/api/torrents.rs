// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/torrents`: the list, adding, and bulk actions over info-hash lists.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::extract::State;

use super::{Json, Query};
use crate::daemon::Daemon;
use crate::error::{ApiError, ApiResult};
use crate::model::{
    AddPeersRequest, AddTorrentsRequest, AddTorrentsResponse, AddTrackersBulkRequest, BulkResult,
    CategoryRequest, CountResponse, DeleteRequest, DownloadPathRequest, FileSearch,
    FileSearchQuery, HashesRequest, LimitsRequest, LocationRequest, ParseTorrentRequest,
    QueueRequest, RemoveTrackerHostsRequest, ShareLimitsRequest, TagsRequest, ToggleRequest,
    TorrentListQuery, TorrentMetadata, TorrentSummary, TrackerHost,
};
use crate::settings::valid_tracker_url;

/// The torrent list, filtered, sorted and paged.
#[utoipa::path(get, path = "/torrents", tag = "torrents", params(TorrentListQuery), responses((status = 200, body = Vec<TorrentSummary>)))]
pub(crate) async fn list_torrents(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<TorrentListQuery>,
) -> ApiResult<Json<Vec<TorrentSummary>>> {
    Ok(Json(d.list(&q).await?))
}

/// Add torrents from magnet links, info-hashes, URLs and base64 `.torrent`
/// files. Each source succeeds or fails on its own.
#[utoipa::path(post, path = "/torrents", tag = "torrents", responses((status = 200, body = AddTorrentsResponse)))]
pub(crate) async fn add_torrents(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<AddTorrentsRequest>,
) -> ApiResult<Json<AddTorrentsResponse>> {
    Ok(Json(d.add_torrents(req).await?))
}

/// The info-hashes of the torrent list, filtered, sorted and paged as
/// `GET /torrents` does: what a client that keeps the rows from the event
/// stream needs from a search, without the rows.
#[utoipa::path(get, path = "/torrents/hashes", tag = "torrents", params(TorrentListQuery), responses((status = 200, body = Vec<String>)))]
pub(crate) async fn list_torrent_hashes(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<TorrentListQuery>,
) -> ApiResult<Json<Vec<String>>> {
    Ok(Json(
        d.list(&q).await?.into_iter().map(|t| t.hash).collect(),
    ))
}

/// How many torrents there are.
#[utoipa::path(get, path = "/torrents/count", tag = "torrents", responses((status = 200, body = CountResponse)))]
pub(crate) async fn count_torrents(State(d): State<Arc<Daemon>>) -> Json<CountResponse> {
    Json(CountResponse { count: d.count() })
}

/// Search file names across torrents: every word of `search` must match
/// the file's path (`*` and `?` are wildcards). Torrents come by name,
/// files in their order.
#[utoipa::path(get, path = "/torrents/files", tag = "torrents", params(FileSearchQuery), responses((status = 200, body = FileSearch)))]
pub(crate) async fn search_files(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<FileSearchQuery>,
) -> ApiResult<Json<FileSearch>> {
    Ok(Json(d.search_files(q).await?))
}

/// Describe a `.torrent` without adding it.
#[utoipa::path(post, path = "/torrents/parse", tag = "torrents", responses((status = 200, body = TorrentMetadata)))]
pub(crate) async fn parse_torrent(
    Json(req): Json<ParseTorrentRequest>,
) -> ApiResult<Json<TorrentMetadata>> {
    let bytes = crate::daemon::decode_base64(&req.torrent)?;
    Ok(Json(crate::daemon::parse_metadata(&bytes)?))
}

/// Start torrents (they rejoin the queue).
#[utoipa::path(post, path = "/torrents/start", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn start_torrents(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<HashesRequest>,
) -> ApiResult<Json<BulkResult>> {
    Ok(Json(
        d.bulk(&req.hashes, |h, id| d.start_torrent(h, id)).await?,
    ))
}

/// Stop torrents.
#[utoipa::path(post, path = "/torrents/stop", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn stop_torrents(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<HashesRequest>,
) -> ApiResult<Json<BulkResult>> {
    Ok(Json(
        d.bulk(&req.hashes, |h, id| d.stop_torrent(h, id)).await?,
    ))
}

/// Force-start torrents regardless of the queue limits (`value: true`), or
/// hand them back to the queue (`false`).
#[utoipa::path(post, path = "/torrents/force-start", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn force_start_torrents(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<ToggleRequest>,
) -> ApiResult<Json<BulkResult>> {
    let on = req.value;
    Ok(Json(
        d.bulk(&req.hashes, |h, id| d.force_start(h, id, on))
            .await?,
    ))
}

/// Recheck the data on disk (runs in the background; the state shows `checking`).
#[utoipa::path(post, path = "/torrents/recheck", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn recheck_torrents(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<HashesRequest>,
) -> ApiResult<Json<BulkResult>> {
    Ok(Json(d.bulk(&req.hashes, |_, id| d.recheck(id)).await?))
}

/// Announce to the trackers as soon as their minimum interval allows.
#[utoipa::path(post, path = "/torrents/reannounce", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn reannounce_torrents(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<HashesRequest>,
) -> ApiResult<Json<BulkResult>> {
    let dd = &d;
    Ok(Json(
        d.bulk(&req.hashes, |_, id| async move {
            Ok(dd.session.force_reannounce(id).await?)
        })
        .await?,
    ))
}

/// Tracker hosts across the torrents, as they stand now: how many torrents
/// have a tracker on each and how many work with it, and the running ones
/// whose announces to it fail, with the latest error. Hosts only, never
/// URLs (private trackers' URLs carry passkeys). Failures are known from
/// the announces of this run.
#[utoipa::path(get, path = "/torrents/trackers", tag = "torrents", responses((status = 200, body = Vec<TrackerHost>)))]
pub(crate) async fn list_tracker_hosts(
    State(d): State<Arc<Daemon>>,
) -> ApiResult<Json<Vec<TrackerHost>>> {
    Ok(Json(d.tracker_hosts().await?))
}

/// Add trackers to torrents: each gets them in a new tier after its last,
/// unless `tier` is given. An explicit request: the daemon adds trackers to
/// private torrents only when asked like this.
#[utoipa::path(post, path = "/torrents/trackers", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn add_trackers_to_torrents(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<AddTrackersBulkRequest>,
) -> ApiResult<Json<BulkResult>> {
    if req.urls.is_empty() {
        return Err(ApiError::bad_request("no tracker URL"));
    }
    if let Some(u) = req.urls.iter().find(|u| !valid_tracker_url(u)) {
        return Err(ApiError::bad_request(format!(
            "{u:?} is not an http, https or udp URL"
        )));
    }
    let (urls, tier) = (&req.urls, req.tier);
    Ok(Json(
        d.bulk(&req.hashes, |h, id| d.add_trackers(h, id, urls, tier))
            .await?,
    ))
}

/// Remove every tracker on some hosts from torrents (a tracker that stopped
/// working for good); torrents with none are left as they are.
#[utoipa::path(post, path = "/torrents/trackers/remove", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn remove_tracker_hosts(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<RemoveTrackerHostsRequest>,
) -> ApiResult<Json<BulkResult>> {
    let hosts: Vec<String> = req
        .hosts
        .iter()
        .map(|h| h.trim().to_ascii_lowercase())
        .filter(|h| !h.is_empty())
        .collect();
    if hosts.is_empty() {
        return Err(ApiError::bad_request("no host"));
    }
    let hosts = &hosts;
    Ok(Json(
        d.bulk(&req.hashes, |h, id| d.remove_tracker_hosts(h, id, hosts))
            .await?,
    ))
}

/// Remove torrents, optionally with their content.
#[utoipa::path(post, path = "/torrents/delete", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn delete_torrents(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<DeleteRequest>,
) -> ApiResult<Json<BulkResult>> {
    let files = req.delete_files;
    Ok(Json(
        d.bulk(&req.hashes, |h, id| d.remove(h, id, files)).await?,
    ))
}

/// Move torrents in the queue.
#[utoipa::path(post, path = "/torrents/queue", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn move_torrents_in_queue(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<QueueRequest>,
) -> ApiResult<Json<BulkResult>> {
    let to = req.to;
    Ok(Json(
        d.bulk(&req.hashes, |_, id| d.queue_move(id, to)).await?,
    ))
}

/// Sequential download on or off.
#[utoipa::path(post, path = "/torrents/sequential", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn set_sequential(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<ToggleRequest>,
) -> ApiResult<Json<BulkResult>> {
    let on = req.value;
    Ok(Json(
        d.bulk(&req.hashes, |h, id| d.set_sequential(h, id, on))
            .await?,
    ))
}

/// Download the first and last pieces of each wanted file first (`value:
/// true`), or let the file priorities decide every piece again (`false`).
#[utoipa::path(post, path = "/torrents/first-last-piece-priority", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn set_first_last_piece_priority(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<ToggleRequest>,
) -> ApiResult<Json<BulkResult>> {
    let on = req.value;
    Ok(Json(
        d.bulk(&req.hashes, |h, id| d.set_first_last(h, id, on))
            .await?,
    ))
}

/// Change rate limits and connection / upload slot caps.
#[utoipa::path(post, path = "/torrents/limits", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn set_torrent_limits(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<LimitsRequest>,
) -> ApiResult<Json<BulkResult>> {
    Ok(Json(
        d.bulk(&req.hashes, |_, id| d.set_limits(id, &req)).await?,
    ))
}

/// Set share limits.
#[utoipa::path(post, path = "/torrents/share-limits", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn set_share_limits(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<ShareLimitsRequest>,
) -> ApiResult<Json<BulkResult>> {
    if let crate::store::RatioLimit::Limit(r) = req.share_limits.ratio
        && (!r.is_finite() || r < 0.0)
    {
        return Err(ApiError::bad_request(
            "the ratio limit must be a non-negative number",
        ));
    }
    let limits = req.share_limits;
    Ok(Json(
        d.bulk(&req.hashes, |h, _| {
            std::future::ready(d.edit_record(h, move |r| r.share_limits = limits))
        })
        .await?,
    ))
}

/// Set the save path: the content moves there (in the background; the
/// state shows `moving`), except an incomplete torrent's in its download
/// path, which moves there when the torrent completes. Turns automatic
/// management off.
#[utoipa::path(post, path = "/torrents/location", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn set_location(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<LocationRequest>,
) -> ApiResult<Json<BulkResult>> {
    if !std::path::Path::new(&req.path).is_absolute() {
        return Err(ApiError::bad_request("path must be absolute"));
    }
    let path = req.path.clone();
    Ok(Json(
        d.bulk(&req.hashes, |h, id| d.set_save_path(h, id, path.clone()))
            .await?,
    ))
}

/// Set or clear the category (automatically managed torrents move).
#[utoipa::path(post, path = "/torrents/category", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn set_torrent_category(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<CategoryRequest>,
) -> ApiResult<Json<BulkResult>> {
    let category = req.category.clone();
    Ok(Json(
        d.bulk(&req.hashes, |h, id| d.set_category(h, id, category.clone()))
            .await?,
    ))
}

/// Add, remove or replace tags.
#[utoipa::path(post, path = "/torrents/tags", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn change_torrent_tags(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<TagsRequest>,
) -> ApiResult<Json<BulkResult>> {
    Ok(Json(
        d.bulk(&req.hashes, |h, _| d.change_tags(h, req.mode, &req.tags))
            .await?,
    ))
}

/// Automatic management on or off (on moves torrents to their category's path).
#[utoipa::path(post, path = "/torrents/auto-management", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn set_auto_management(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<ToggleRequest>,
) -> ApiResult<Json<BulkResult>> {
    let on = req.value;
    Ok(Json(
        d.bulk(&req.hashes, |h, id| d.set_auto_management(h, id, on))
            .await?,
    ))
}

/// Give torrents peer addresses to connect to.
#[utoipa::path(post, path = "/torrents/peers", tag = "torrents", responses((status = 200, body = BulkResult)))]
pub(crate) async fn add_peers(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<AddPeersRequest>,
) -> ApiResult<Json<BulkResult>> {
    let peers: Vec<SocketAddr> = req
        .peers
        .iter()
        .map(|p| {
            p.trim()
                .parse::<SocketAddr>()
                .map_err(|_| ApiError::bad_request(format!("{p:?} is not ip:port")))
        })
        .collect::<ApiResult<_>>()?;
    Ok(Json(
        d.bulk(&req.hashes, |_, id| d.add_peers(id, &peers)).await?,
    ))
}

/// Move incomplete torrents' content to a download path, or back to the
/// save path with `null` (in the background; the state shows `moving`).
/// Complete torrents keep their content in the save path. Turns automatic
/// management off.
#[utoipa::path(post, path = "/torrents/download-path", tag = "torrents", request_body = DownloadPathRequest, responses((status = 200, body = BulkResult)))]
pub(crate) async fn set_download_path(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<DownloadPathRequest>,
) -> ApiResult<Json<BulkResult>> {
    if let Some(p) = &req.path
        && !std::path::Path::new(p).is_absolute()
    {
        return Err(ApiError::bad_request("path must be absolute"));
    }
    let path = req.path.clone();
    Ok(Json(
        d.bulk(&req.hashes, |h, id| {
            d.set_download_path(h, id, path.clone())
        })
        .await?,
    ))
}
