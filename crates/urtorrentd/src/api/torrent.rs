// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/torrents/{hash}`: one torrent's detail, files, trackers, web seeds,
//! peers and pieces.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};

use super::{HashPath, Json, Path, no_content};
use crate::daemon::Daemon;
use crate::error::ApiResult;
use crate::model::{
    AddTrackersRequest, EditUrlRequest, FileInfo, FilePriorityRequest, PeerInfo, PiecesResponse,
    RenameRequest, TorrentDetail, TorrentPatch, TrackersResponse, UrlsRequest,
};

/// Everything about one torrent.
#[utoipa::path(get, path = "/torrents/{hash}", tag = "torrent", params(HashPath), responses((status = 200, body = TorrentDetail)))]
pub(crate) async fn get_torrent(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
) -> ApiResult<Json<TorrentDetail>> {
    let (h, id) = d.resolve(&p.hash)?;
    Ok(Json(d.detail(h, id).await?))
}

/// Change the display name or comment.
#[utoipa::path(patch, path = "/torrents/{hash}", tag = "torrent", params(HashPath), responses((status = 204, description = "Changed.")))]
pub(crate) async fn patch_torrent(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
    Json(req): Json<TorrentPatch>,
) -> ApiResult<StatusCode> {
    let (h, _) = d.resolve(&p.hash)?;
    d.patch_torrent(h, req).await?;
    Ok(no_content())
}

/// The content files.
#[utoipa::path(get, path = "/torrents/{hash}/files", tag = "torrent", params(HashPath), responses((status = 200, body = Vec<FileInfo>)))]
pub(crate) async fn list_files(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
) -> ApiResult<Json<Vec<FileInfo>>> {
    let (_, id) = d.resolve(&p.hash)?;
    Ok(Json(d.files(id).await?))
}

/// Set the priority of files (0 skips them).
#[utoipa::path(post, path = "/torrents/{hash}/files/priority", tag = "torrent", params(HashPath), responses((status = 204, description = "Changed.")))]
pub(crate) async fn set_file_priority(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
    Json(req): Json<FilePriorityRequest>,
) -> ApiResult<StatusCode> {
    let (_, id) = d.resolve(&p.hash)?;
    d.set_file_priority(id, &req.indexes, req.priority).await?;
    Ok(no_content())
}

/// Rename (move) a file within the save path.
#[utoipa::path(post, path = "/torrents/{hash}/files/rename", tag = "torrent", params(HashPath), responses((status = 204, description = "Renamed.")))]
pub(crate) async fn rename_file(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
    Json(req): Json<RenameRequest>,
) -> ApiResult<StatusCode> {
    let (h, id) = d.resolve(&p.hash)?;
    d.rename_file(h, id, &req.old_path, &req.new_path).await?;
    Ok(no_content())
}

/// Rename a folder (every file under it moves).
#[utoipa::path(post, path = "/torrents/{hash}/folders/rename", tag = "torrent", params(HashPath), responses((status = 204, description = "Renamed.")))]
pub(crate) async fn rename_folder(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
    Json(req): Json<RenameRequest>,
) -> ApiResult<StatusCode> {
    let (h, id) = d.resolve(&p.hash)?;
    d.rename_folder(h, id, &req.old_path, &req.new_path).await?;
    Ok(no_content())
}

/// Trackers, plus the DHT / PEX / LSD sources.
#[utoipa::path(get, path = "/torrents/{hash}/trackers", tag = "torrent", params(HashPath), responses((status = 200, body = TrackersResponse)))]
pub(crate) async fn list_trackers(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
) -> ApiResult<Json<TrackersResponse>> {
    let (_, id) = d.resolve(&p.hash)?;
    Ok(Json(d.trackers(id).await?))
}

/// Add trackers.
#[utoipa::path(post, path = "/torrents/{hash}/trackers", tag = "torrent", params(HashPath), responses((status = 204, description = "Added.")))]
pub(crate) async fn add_trackers(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
    Json(req): Json<AddTrackersRequest>,
) -> ApiResult<StatusCode> {
    let (h, id) = d.resolve(&p.hash)?;
    d.add_trackers(h, id, &req.urls, req.tier).await?;
    Ok(no_content())
}

/// Remove trackers.
#[utoipa::path(post, path = "/torrents/{hash}/trackers/remove", tag = "torrent", params(HashPath), responses((status = 204, description = "Removed.")))]
pub(crate) async fn remove_trackers(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
    Json(req): Json<UrlsRequest>,
) -> ApiResult<StatusCode> {
    let (h, id) = d.resolve(&p.hash)?;
    d.remove_trackers(h, id, &req.urls).await?;
    Ok(no_content())
}

/// Replace a tracker's URL (same tier).
#[utoipa::path(post, path = "/torrents/{hash}/trackers/edit", tag = "torrent", params(HashPath), responses((status = 204, description = "Replaced.")))]
pub(crate) async fn edit_tracker(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
    Json(req): Json<EditUrlRequest>,
) -> ApiResult<StatusCode> {
    let (h, id) = d.resolve(&p.hash)?;
    d.edit_tracker(h, id, &req.url, &req.new_url).await?;
    Ok(no_content())
}

/// Web seed URLs.
#[utoipa::path(get, path = "/torrents/{hash}/webseeds", tag = "torrent", params(HashPath), responses((status = 200, body = Vec<String>)))]
pub(crate) async fn list_web_seeds(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
) -> ApiResult<Json<Vec<String>>> {
    let (_, id) = d.resolve(&p.hash)?;
    Ok(Json(d.web_seeds(id).await?))
}

/// Add web seeds.
#[utoipa::path(post, path = "/torrents/{hash}/webseeds", tag = "torrent", params(HashPath), responses((status = 204, description = "Added.")))]
pub(crate) async fn add_web_seeds(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
    Json(req): Json<UrlsRequest>,
) -> ApiResult<StatusCode> {
    let (_, id) = d.resolve(&p.hash)?;
    d.add_web_seeds(id, &req.urls).await?;
    Ok(no_content())
}

/// Remove web seeds.
#[utoipa::path(post, path = "/torrents/{hash}/webseeds/remove", tag = "torrent", params(HashPath), responses((status = 204, description = "Removed.")))]
pub(crate) async fn remove_web_seeds(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
    Json(req): Json<UrlsRequest>,
) -> ApiResult<StatusCode> {
    let (_, id) = d.resolve(&p.hash)?;
    d.remove_web_seeds(id, &req.urls).await?;
    Ok(no_content())
}

/// Replace a web seed URL.
#[utoipa::path(post, path = "/torrents/{hash}/webseeds/edit", tag = "torrent", params(HashPath), responses((status = 204, description = "Replaced.")))]
pub(crate) async fn edit_web_seed(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
    Json(req): Json<EditUrlRequest>,
) -> ApiResult<StatusCode> {
    let (_, id) = d.resolve(&p.hash)?;
    d.edit_web_seed(id, &req.url, &req.new_url).await?;
    Ok(no_content())
}

/// Connected peers.
#[utoipa::path(get, path = "/torrents/{hash}/peers", tag = "torrent", params(HashPath), responses((status = 200, body = Vec<PeerInfo>)))]
pub(crate) async fn list_peers(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
) -> ApiResult<Json<Vec<PeerInfo>>> {
    let (_, id) = d.resolve(&p.hash)?;
    Ok(Json(d.peers(id).await?))
}

/// Every piece's state and availability.
#[utoipa::path(get, path = "/torrents/{hash}/pieces", tag = "torrent", params(HashPath), responses((status = 200, body = PiecesResponse)))]
pub(crate) async fn get_pieces(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
) -> ApiResult<Json<PiecesResponse>> {
    let (_, id) = d.resolve(&p.hash)?;
    Ok(Json(d.pieces(id).await?))
}

/// Piece hashes (SHA-1, hex) in piece order.
#[utoipa::path(get, path = "/torrents/{hash}/pieces/hashes", tag = "torrent", params(HashPath), responses((status = 200, body = Vec<String>)))]
pub(crate) async fn get_piece_hashes(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
) -> ApiResult<Json<Vec<String>>> {
    let (_, id) = d.resolve(&p.hash)?;
    Ok(Json(d.piece_hashes(id).await?))
}

/// The `.torrent` file, with the current trackers and web seeds.
#[utoipa::path(
    get, path = "/torrents/{hash}/torrent-file", tag = "torrent", params(HashPath),
    responses((status = 200, description = "The `.torrent`.", content_type = "application/x-bittorrent", body = Vec<u8>))
)]
pub(crate) async fn export_torrent_file(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
) -> ApiResult<Response> {
    let (_, id) = d.resolve(&p.hash)?;
    let bytes = d.torrent_file(id).await?;
    let disposition = format!(
        "attachment; filename=\"{}.torrent\"",
        p.hash.to_ascii_lowercase()
    );
    Ok((
        [
            (header::CONTENT_TYPE, "application/x-bittorrent".to_string()),
            (header::CONTENT_DISPOSITION, disposition),
        ],
        bytes,
    )
        .into_response())
}
