// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/sync`: incremental updates for polling clients.

use std::sync::Arc;

use axum::extract::State;

use super::{Json, Query};
use crate::daemon::Daemon;
use crate::error::ApiResult;
use crate::model::{SyncQuery, SyncResponse};

/// Torrents, categories, tags and transfer state: everything on the first
/// call, then only the changes since the `rev` the client passes back.
#[utoipa::path(get, path = "/sync", tag = "sync", params(SyncQuery), responses((status = 200, body = SyncResponse)))]
pub(crate) async fn sync(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<SyncQuery>,
) -> ApiResult<Json<SyncResponse>> {
    Ok(Json(d.sync(q.rev).await?))
}
