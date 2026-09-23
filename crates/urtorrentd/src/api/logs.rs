// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/log`: the main log and the peer (ban) log.

use std::sync::Arc;

use axum::extract::State;

use super::{Json, Query};
use crate::daemon::Daemon;
use crate::error::{ApiError, ApiResult};
use crate::log::{LogEntry, PeerLogEntry};
use crate::model::{LogQuery, PeerLogQuery, parse_levels};

/// Main-log entries, oldest first.
#[utoipa::path(get, path = "/log", tag = "log", params(LogQuery), responses((status = 200, body = Vec<LogEntry>)))]
pub(crate) async fn get_main_log(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<LogQuery>,
) -> ApiResult<Json<Vec<LogEntry>>> {
    let levels = parse_levels(q.levels.as_deref()).map_err(ApiError::bad_request)?;
    Ok(Json(d.logs.main_since(q.after, &levels)))
}

/// Peer-log entries (bans), oldest first.
#[utoipa::path(get, path = "/log/peers", tag = "log", params(PeerLogQuery), responses((status = 200, body = Vec<PeerLogEntry>)))]
pub(crate) async fn get_peer_log(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<PeerLogQuery>,
) -> Json<Vec<PeerLogEntry>> {
    Json(d.logs.peers_since(q.after))
}
