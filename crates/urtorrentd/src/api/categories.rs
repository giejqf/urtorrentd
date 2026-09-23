// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/categories` and `/tags`.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;

use super::{Json, no_content};
use crate::daemon::Daemon;
use crate::error::ApiResult;
use crate::model::{CategoryDefinition, NamesRequest, TagListRequest};
use crate::store::Category;

/// The categories by name.
#[utoipa::path(get, path = "/categories", tag = "categories", responses((status = 200, body = BTreeMap<String, Category>)))]
pub(crate) async fn list_categories(
    State(d): State<Arc<Daemon>>,
) -> Json<BTreeMap<String, Category>> {
    Json(d.categories())
}

/// Create a category (409 if it exists).
#[utoipa::path(post, path = "/categories", tag = "categories", responses((status = 204, description = "Created.")))]
pub(crate) async fn create_category(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<CategoryDefinition>,
) -> ApiResult<StatusCode> {
    d.create_category(&req.name, req.category).await?;
    Ok(no_content())
}

/// Change a category's paths; its automatically managed torrents move.
#[utoipa::path(put, path = "/categories", tag = "categories", responses((status = 204, description = "Changed.")))]
pub(crate) async fn edit_category(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<CategoryDefinition>,
) -> ApiResult<StatusCode> {
    d.edit_category(&req.name, req.category).await?;
    Ok(no_content())
}

/// Remove categories (their torrents keep going without one).
#[utoipa::path(post, path = "/categories/remove", tag = "categories", responses((status = 204, description = "Removed.")))]
pub(crate) async fn remove_categories(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<NamesRequest>,
) -> ApiResult<StatusCode> {
    d.remove_categories(&req.names).await?;
    Ok(no_content())
}

/// The tags.
#[utoipa::path(get, path = "/tags", tag = "categories", responses((status = 200, body = Vec<String>)))]
pub(crate) async fn list_tags(State(d): State<Arc<Daemon>>) -> Json<Vec<String>> {
    Json(d.tags().into_iter().collect())
}

/// Create tags.
#[utoipa::path(post, path = "/tags", tag = "categories", responses((status = 204, description = "Created.")))]
pub(crate) async fn create_tags(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<TagListRequest>,
) -> ApiResult<StatusCode> {
    d.create_tags(&req.tags).await?;
    Ok(no_content())
}

/// Delete tags (also from every torrent).
#[utoipa::path(post, path = "/tags/remove", tag = "categories", responses((status = 204, description = "Deleted.")))]
pub(crate) async fn delete_tags(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<TagListRequest>,
) -> ApiResult<StatusCode> {
    d.delete_tags(&req.tags).await?;
    Ok(no_content())
}
