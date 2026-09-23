// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/auth`: login sessions, credentials, the API key.

use std::sync::Arc;
use std::time::Duration;

use axum::Extension;
use axum::extract::State;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};

use super::guard::{ClientIp, Principal};
use super::{Json, SESSION_COOKIE, no_content};
use crate::daemon::Daemon;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::model::{ApiKeyResponse, CredentialsRequest, LoginRequest};
use crate::store;
use crate::util::blocking;

/// Log in; sets the session cookie.
#[utoipa::path(
    post, path = "/auth/login", tag = "auth", security(()),
    responses(
        (status = 204, description = "Logged in; the `urtorrentd_sid` cookie is set.",
         headers(("set-cookie" = String, description = "The session cookie."))),
    )
)]
pub(crate) async fn login(
    State(d): State<Arc<Daemon>>,
    ClientIp(ip): ClientIp,
    Json(req): Json<LoginRequest>,
) -> ApiResult<Response> {
    let (max, ban, timeout) = {
        let st = d.state();
        (
            st.settings.api_max_auth_failures,
            st.settings.api_ban_duration,
            st.settings.api_session_timeout,
        )
    };
    let checker = d.clone();
    let ok =
        tokio::task::spawn_blocking(move || checker.auth.check_login(&req.username, &req.password))
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;
    if !ok {
        if let Some(ip) = ip {
            if d.auth.record_failure(ip, max, Duration::from_secs(ban)) {
                d.logs
                    .warn(format!("API login banned {ip} after {max} failed attempts"));
            } else {
                d.logs.warn(format!("failed API login from {ip}"));
            }
        }
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            ErrorCode::Unauthorized,
            "wrong user name or password",
        ));
    }
    if let Some(ip) = ip {
        d.auth.clear_failures(ip);
    }
    let sid = d.auth.new_session()?;
    let cookie =
        format!("{SESSION_COOKIE}={sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age={timeout}");
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, cookie)]).into_response())
}

/// End this login session.
#[utoipa::path(post, path = "/auth/logout", tag = "auth", responses((status = 204, description = "Logged out.")))]
pub(crate) async fn logout(
    State(d): State<Arc<Daemon>>,
    principal: Option<Extension<Principal>>,
) -> Response {
    if let Some(Extension(Principal::Session(sid))) = principal {
        d.auth.end_session(&sid);
    }
    let expired = format!("{SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
    (StatusCode::NO_CONTENT, [(header::SET_COOKIE, expired)]).into_response()
}

/// Change the user name and password. Every login session ends.
#[utoipa::path(put, path = "/auth/credentials", tag = "auth", responses((status = 204, description = "Changed.")))]
pub(crate) async fn set_credentials(
    State(d): State<Arc<Daemon>>,
    Json(req): Json<CredentialsRequest>,
) -> ApiResult<StatusCode> {
    if req.username.trim().is_empty() {
        return Err(ApiError::bad_request("the user name must not be empty"));
    }
    if req.password.chars().count() < 8 {
        return Err(ApiError::bad_request(
            "the password needs at least 8 characters",
        ));
    }
    let hasher = d.clone();
    let creds = tokio::task::spawn_blocking(move || {
        hasher.auth.set_credentials(req.username, &req.password)
    })
    .await
    .map_err(|e| ApiError::internal(e.to_string()))??;
    let s = d.store.clone();
    blocking(move || s.save(store::AUTH, &creds)).await?;
    d.auth.end_all_sessions();
    d.logs.info("API credentials changed");
    Ok(no_content())
}

/// Create an API key, replacing the old one. The key is shown only here.
#[utoipa::path(post, path = "/auth/api-key", tag = "auth", responses((status = 200, body = ApiKeyResponse)))]
pub(crate) async fn rotate_api_key(
    State(d): State<Arc<Daemon>>,
) -> ApiResult<Json<ApiKeyResponse>> {
    let (key, creds) = d.auth.rotate_api_key()?;
    let s = d.store.clone();
    blocking(move || s.save(store::AUTH, &creds)).await?;
    d.logs.info("API key rotated");
    Ok(Json(ApiKeyResponse { api_key: key }))
}

/// Delete the API key.
#[utoipa::path(delete, path = "/auth/api-key", tag = "auth", responses((status = 204, description = "Deleted.")))]
pub(crate) async fn delete_api_key(State(d): State<Arc<Daemon>>) -> ApiResult<StatusCode> {
    let creds = d.auth.delete_api_key();
    let s = d.store.clone();
    blocking(move || s.save(store::AUTH, &creds)).await?;
    d.logs.info("API key deleted");
    Ok(no_content())
}
