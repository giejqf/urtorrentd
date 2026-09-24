// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/previews`: a torrent's metadata without adding it (qBittorrent's
//! `fetchMetadata` and `saveMetadata`). Adding the same info-hash with
//! `POST /torrents` uses the fetched metadata.

use std::sync::Arc;

use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};

use super::{HashPath, Json, Path, no_content};
use crate::daemon::Daemon;
use crate::error::ApiResult;
use crate::model::{PreviewInfo, PreviewRequest};

/// Fetch a torrent's metadata without adding it: a magnet link or info-hash
/// asks peers (poll `GET /previews/{hash}` until `ready`), a URL is
/// downloaded. Asking again for the same torrent returns the same preview.
#[utoipa::path(post, path = "/previews", tag = "torrents", request_body = PreviewRequest, responses((status = 200, body = PreviewInfo)))]
pub(crate) async fn create_preview(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<PreviewRequest>,
) -> ApiResult<Json<PreviewInfo>> {
    Ok(Json(d.create_preview(req).await?))
}

/// Every preview.
#[utoipa::path(get, path = "/previews", tag = "torrents", responses((status = 200, body = Vec<PreviewInfo>)))]
pub(crate) async fn list_previews(
    State(d): State<Arc<Daemon>>,
) -> ApiResult<Json<Vec<PreviewInfo>>> {
    Ok(Json(d.previews().await?))
}

/// One preview: while `fetching`, the peers connected; once `ready`, the
/// metadata (files, sizes, trackers, ...).
#[utoipa::path(get, path = "/previews/{hash}", tag = "torrents", params(HashPath), responses((status = 200, body = PreviewInfo)))]
pub(crate) async fn get_preview(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
) -> ApiResult<Json<PreviewInfo>> {
    Ok(Json(d.preview(&p.hash).await?))
}

/// Drop a preview.
#[utoipa::path(delete, path = "/previews/{hash}", tag = "torrents", params(HashPath), responses((status = 204, description = "Dropped.")))]
pub(crate) async fn delete_preview(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
) -> ApiResult<StatusCode> {
    d.delete_preview(&p.hash).await?;
    Ok(no_content())
}

/// A ready preview as a `.torrent` file (`409` while fetching).
#[utoipa::path(
    get, path = "/previews/{hash}/torrent-file", tag = "torrents", params(HashPath),
    responses((status = 200, description = "The `.torrent`.", content_type = "application/x-bittorrent", body = Vec<u8>))
)]
pub(crate) async fn export_preview(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<HashPath>,
) -> ApiResult<Response> {
    let bytes = d.preview_file(&p.hash)?;
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
