// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/webhooks`: HTTP calls on torrent events (qBittorrent's "run external
//! program" on add and on completion, without running programs). What a
//! webhook receives is `WebhookPayload` in the schema.

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;
use serde::Deserialize;
use utoipa::IntoParams;

use super::{Json, Path, no_content};
use crate::daemon::Daemon;
use crate::error::ApiResult;
use crate::model::{Webhook, WebhookDelivery, WebhookPatch, WebhookPayload, WebhookRequest};

/// The `{id}` path parameter.
#[derive(Debug, Clone, Deserialize, IntoParams)]
#[into_params(parameter_in = Path)]
pub struct WebhookPath {
    /// Webhook id.
    pub id: u32,
}

/// The `{id}` and `{delivery}` path parameters.
#[derive(Debug, Clone, Deserialize, IntoParams)]
#[into_params(parameter_in = Path)]
pub struct DeliveryPath {
    /// Webhook id.
    pub id: u32,
    /// Delivery id (`X-Urtorrentd-Delivery`).
    pub delivery: String,
}

/// Every webhook, with its last deliveries.
#[utoipa::path(get, path = "/webhooks", tag = "webhooks", responses((status = 200, body = Vec<Webhook>)))]
pub(crate) async fn list_webhooks(State(d): State<Arc<Daemon>>) -> Json<Vec<Webhook>> {
    Json(d.webhooks.list())
}

/// Add a webhook.
#[utoipa::path(post, path = "/webhooks", tag = "webhooks", request_body = WebhookRequest, responses((status = 201, body = Webhook)))]
pub(crate) async fn create_webhook(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<WebhookRequest>,
) -> ApiResult<(StatusCode, Json<Webhook>)> {
    let _ops = d.ops.lock().await;
    let hook = d.webhooks.create(req)?;
    d.save_webhooks().await?;
    Ok((StatusCode::CREATED, Json(hook)))
}

/// One webhook.
#[utoipa::path(get, path = "/webhooks/{id}", tag = "webhooks", params(WebhookPath), responses((status = 200, body = Webhook)))]
pub(crate) async fn get_webhook(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<WebhookPath>,
) -> ApiResult<Json<Webhook>> {
    Ok(Json(d.webhooks.get(p.id)?))
}

/// Change a webhook: only the fields present change.
#[utoipa::path(patch, path = "/webhooks/{id}", tag = "webhooks", params(WebhookPath), request_body = WebhookPatch, responses((status = 200, body = Webhook)))]
pub(crate) async fn patch_webhook(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<WebhookPath>,
    Json(patch): Json<WebhookPatch>,
) -> ApiResult<Json<Webhook>> {
    let _ops = d.ops.lock().await;
    let hook = d.webhooks.update(p.id, patch)?;
    d.save_webhooks().await?;
    Ok(Json(hook))
}

/// Remove a webhook.
#[utoipa::path(delete, path = "/webhooks/{id}", tag = "webhooks", params(WebhookPath), responses((status = 204, description = "Removed.")))]
pub(crate) async fn delete_webhook(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<WebhookPath>,
) -> ApiResult<StatusCode> {
    let _ops = d.ops.lock().await;
    d.webhooks.delete(p.id)?;
    d.save_webhooks().await?;
    Ok(no_content())
}

/// Send a `test` event now (no retries) and say how it went.
#[utoipa::path(post, path = "/webhooks/{id}/test", tag = "webhooks", params(WebhookPath), responses((status = 200, body = WebhookDelivery)))]
pub(crate) async fn test_webhook(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<WebhookPath>,
) -> ApiResult<Json<WebhookDelivery>> {
    Ok(Json(d.webhooks.test(p.id).await?))
}

/// What one of a webhook's last deliveries sent (kept with the last 20, not
/// across restarts).
#[utoipa::path(get, path = "/webhooks/{id}/deliveries/{delivery}", tag = "webhooks", params(DeliveryPath), responses((status = 200, body = WebhookPayload)))]
pub(crate) async fn get_webhook_delivery(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<DeliveryPath>,
) -> ApiResult<Json<WebhookPayload>> {
    Ok(Json(d.webhooks.sent(p.id, &p.delivery)?))
}

/// Send one of a webhook's last deliveries again, now and once (no
/// retries): the same payload and delivery id, a fresh timestamp and
/// signature. It is listed as a new delivery.
#[utoipa::path(post, path = "/webhooks/{id}/deliveries/{delivery}/redeliver", tag = "webhooks", params(DeliveryPath), responses((status = 200, body = WebhookDelivery)))]
pub(crate) async fn redeliver_webhook_delivery(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<DeliveryPath>,
) -> ApiResult<Json<WebhookDelivery>> {
    Ok(Json(d.webhooks.redeliver(p.id, &p.delivery).await?))
}
