// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/auth`: login sessions, credentials, the API key.

use std::sync::Arc;
use std::time::Duration;

use axum::Extension;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};

use super::guard::{Client, ClientIp, Principal, cross_origin};
use super::{Json, SESSION_COOKIE, no_content};
use crate::daemon::Daemon;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::model::{ApiKeyResponse, AuthStatus, CredentialsRequest, LoginRequest};
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
    logged_in(&d, timeout)
}

/// A new login session, as a `204` that sets its cookie.
fn logged_in(d: &Daemon, timeout: u64) -> ApiResult<Response> {
    let sid = d.auth.new_session()?;
    let cookie =
        format!("{SESSION_COOKIE}={sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age={timeout}");
    Ok((StatusCode::NO_CONTENT, [(header::SET_COOKIE, cookie)]).into_response())
}

/// Whether the daemon still waits for its credentials (public).
#[utoipa::path(get, path = "/auth/status", tag = "auth", security(()), responses((status = 200, body = AuthStatus)))]
pub(crate) async fn auth_status(State(d): State<Arc<Daemon>>) -> Json<AuthStatus> {
    Json(AuthStatus {
        setup_required: d.auth.needs_setup(),
    })
}

/// First-run setup (public): while no password is set, the first caller
/// chooses the user name and password and is logged in. Afterwards `409`.
#[utoipa::path(
    post, path = "/auth/setup", tag = "auth", security(()),
    responses(
        (status = 204, description = "Credentials set and logged in; the `urtorrentd_sid` cookie is set.",
         headers(("set-cookie" = String, description = "The session cookie."))),
    )
)]
pub(crate) async fn setup_credentials(
    State(d): State<Arc<Daemon>>,
    ClientIp(ip): ClientIp,
    client: Option<Extension<Client>>,
    headers: HeaderMap,
    Json(req): Json<CredentialsRequest>,
) -> ApiResult<Response> {
    let (csrf, timeout) = {
        let st = d.state();
        (
            st.settings.api_csrf_protection,
            st.settings.api_session_timeout,
        )
    };
    // No web page may claim the daemon for its visitor's browser.
    let host = client.and_then(|Extension(c)| c.host);
    if csrf && cross_origin(&headers, host.as_deref()) {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            ErrorCode::CrossOrigin,
            "cross-origin request refused",
        ));
    }
    check_credentials(&req)?;
    let already = || ApiError::conflict("the credentials are already set; log in");
    if !d.auth.needs_setup() {
        return Err(already());
    }
    let password = req.password;
    let hash = tokio::task::spawn_blocking(move || crate::auth::hash_password(&password))
        .await
        .map_err(|e| ApiError::internal(e.to_string()))??;
    // One caller wins, whatever the interleaving: the claim is atomic.
    let (creds, before) = d.auth.claim_setup(req.username, hash).ok_or_else(already)?;
    let s = d.store.clone();
    let saved = blocking(move || s.save(store::AUTH, &creds)).await;
    if saved.is_err() {
        d.auth.restore_credentials(before);
    }
    saved?;
    // The temporary password, and sessions opened with it, end here.
    d.auth.forget_temporary();
    d.auth.end_all_sessions();
    match ip {
        Some(ip) => d.logs.info(format!(
            "API credentials created by first-run setup from {ip}"
        )),
        None => d.logs.info("API credentials created by first-run setup"),
    }
    logged_in(&d, timeout)
}

fn check_credentials(req: &CredentialsRequest) -> ApiResult<()> {
    if req.username.trim().is_empty() || req.username.chars().count() > 128 {
        return Err(ApiError::bad_request(
            "the user name must be 1 to 128 characters",
        ));
    }
    let n = req.password.chars().count();
    if !(8..=1024).contains(&n) {
        return Err(ApiError::bad_request(
            "the password needs 8 to 1024 characters",
        ));
    }
    Ok(())
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
    check_credentials(&req)?;
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
