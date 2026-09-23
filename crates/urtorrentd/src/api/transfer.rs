// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/transfer`: session-wide transfer state, the alternative limits, bans.
//! The limits themselves are settings (`PATCH /settings`).

use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;

use super::{Json, no_content};
use crate::daemon::{Daemon, parse_peer_ip};
use crate::error::{ApiError, ApiResult};
use crate::model::{AltSpeedRequest, BanRequest, TransferInfo};
use crate::settings::SettingsPatch;

/// Session-wide transfer state.
#[utoipa::path(get, path = "/transfer", tag = "transfer", responses((status = 200, body = TransferInfo)))]
pub(crate) async fn get_transfer_info(
    State(d): State<Arc<Daemon>>,
) -> ApiResult<Json<TransferInfo>> {
    Ok(Json(d.transfer_info().await?))
}

/// Switch between the normal and the alternative speed limits.
#[utoipa::path(put, path = "/transfer/alt-speed", tag = "transfer", responses((status = 204, description = "Switched.")))]
pub(crate) async fn set_alt_speed(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<AltSpeedRequest>,
) -> ApiResult<StatusCode> {
    d.update_settings(SettingsPatch {
        alt_speed_enabled: Some(req.enabled),
        ..Default::default()
    })
    .await?;
    Ok(no_content())
}

/// Ban peer addresses from every torrent (added to the `banned_ips` setting;
/// remove them there to unban).
#[utoipa::path(post, path = "/transfer/bans", tag = "transfer", responses((status = 204, description = "Banned.")))]
pub(crate) async fn ban_peers(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<BanRequest>,
) -> ApiResult<StatusCode> {
    let ips = req
        .peers
        .iter()
        .map(|p| {
            parse_peer_ip(p)
                .ok_or_else(|| ApiError::bad_request(format!("{p:?} is not an address")))
        })
        .collect::<ApiResult<Vec<_>>>()?;
    d.ban(ips).await?;
    Ok(no_content())
}
