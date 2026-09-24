// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/client-data`: a small key-value store for client UIs (qBittorrent's
//! `clientdata/load` and `clientdata/store`): a UI keeps its preferences
//! here so they follow the user across browsers. Values are any JSON; the
//! daemon never reads them.

use std::collections::BTreeMap;
use std::sync::Arc;

use axum::extract::State;
use axum::http::StatusCode;

use super::{Json, Query, no_content};
use crate::daemon::Daemon;
use crate::error::{ApiError, ApiResult};
use crate::model::ClientDataQuery;
use crate::util::blocking;

/// Keys kept at most.
const MAX_KEYS: u64 = 4096;
/// Keys changed in one request at most.
const MAX_CHANGES: usize = 256;
/// Longest key, bytes.
const MAX_KEY: usize = 256;
/// Largest value (as JSON), bytes.
const MAX_VALUE: usize = 64 * 1024;

fn check_key(k: &str) -> ApiResult<()> {
    if k.is_empty() || k.len() > MAX_KEY || k.chars().any(char::is_control) {
        return Err(ApiError::bad_request(format!(
            "{k:?}: a key is 1 to {MAX_KEY} bytes without control characters"
        )));
    }
    Ok(())
}

/// Values by key: the keys asked for that exist, or every key.
#[utoipa::path(get, path = "/client-data", tag = "app", params(ClientDataQuery), responses((status = 200, body = BTreeMap<String, serde_json::Value>)))]
pub(crate) async fn load_client_data(
    State(d): State<Arc<Daemon>>,
    Query(q): Query<ClientDataQuery>,
) -> ApiResult<Json<BTreeMap<String, serde_json::Value>>> {
    let keys: Option<Vec<String>> = q.keys.map(|k| {
        k.split(',')
            .map(str::trim)
            .filter(|k| !k.is_empty())
            .map(str::to_string)
            .collect()
    });
    let store = d.store.clone();
    Ok(Json(
        blocking(move || store.client_data(keys.as_deref())).await?,
    ))
}

/// Store values by key; `null` removes a key. At most 256 keys a request,
/// 4096 in all, 64 KiB a value.
#[utoipa::path(patch, path = "/client-data", tag = "app", request_body = BTreeMap<String, serde_json::Value>, responses((status = 204, description = "Stored.")))]
pub(crate) async fn store_client_data(
    State(d): State<Arc<Daemon>>,
    Json(changes): Json<BTreeMap<String, serde_json::Value>>,
) -> ApiResult<StatusCode> {
    if changes.len() > MAX_CHANGES {
        return Err(ApiError::bad_request(format!(
            "at most {MAX_CHANGES} keys a request"
        )));
    }
    for (k, v) in &changes {
        check_key(k)?;
        if v.to_string().len() > MAX_VALUE {
            return Err(ApiError::bad_request(format!(
                "{k:?}: a value is at most 64 KiB of JSON"
            )));
        }
    }
    let store = d.store.clone();
    match blocking(move || store.store_client_data(&changes, MAX_KEYS)).await {
        Ok(()) => Ok(no_content()),
        Err(e) if e.kind() == std::io::ErrorKind::InvalidInput => {
            Err(ApiError::conflict(e.to_string()))
        }
        Err(e) => Err(e.into()),
    }
}
