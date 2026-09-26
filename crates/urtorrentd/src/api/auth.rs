// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! `/auth`: login sessions, credentials, the API key.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::Extension;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};

use super::guard::{Client, ClientIp, Principal, cross_origin, user_agent};
use super::{Json, Path, SESSION_COOKIE, no_content};
use crate::auth::{Use, session_id};
use crate::daemon::Daemon;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::model::{
    Account, ApiKeyInfo, ApiKeyResponse, AuthStatus, BanPath, ClientUse, CredentialsRequest,
    LoginBan, LoginRequest, LoginSession, RequestCheck, SessionPath,
};
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
    client: Option<Extension<Client>>,
    headers: HeaderMap,
    Json(req): Json<LoginRequest>,
) -> ApiResult<Response> {
    let ua = user_agent(&headers);
    let (max, ban) = {
        let st = d.state();
        (
            st.settings.api_max_auth_failures,
            st.settings.api_ban_duration,
        )
    };
    let checker = d.clone();
    let ok =
        tokio::task::spawn_blocking(move || checker.auth.check_login(&req.username, &req.password))
            .await
            .map_err(|e| ApiError::internal(e.to_string()))?;
    if !ok {
        if let Some(ip) = ip {
            if d.auth
                .record_failure(ip, max, Duration::from_secs(ban), ua.clone())
            {
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
    logged_in(&d, https(client.as_ref()), ip, ua)
}

/// Whether a trusted proxy says the client used HTTPS.
fn https(client: Option<&Extension<Client>>) -> bool {
    client.is_some_and(|Extension(c)| c.https)
}

/// The session cookie's attributes: `Secure` when the client used HTTPS
/// (through a trusted TLS-terminating proxy).
fn cookie_attributes(secure: bool) -> &'static str {
    if secure {
        "HttpOnly; Secure; SameSite=Strict; Path=/"
    } else {
        "HttpOnly; SameSite=Strict; Path=/"
    }
}

/// A new login session, as a `204` that sets its cookie. The cookie has no
/// `Max-Age`: it lasts as long as the browser session, and the daemon ends
/// the login session after `api_session_timeout` idle seconds. A fixed
/// lifetime would sign an active user out at a set time after login.
fn logged_in(
    d: &Daemon,
    secure: bool,
    ip: Option<IpAddr>,
    ua: Option<String>,
) -> ApiResult<Response> {
    let sid = d.auth.new_session(ip, ua)?;
    let cookie = format!("{SESSION_COOKIE}={sid}; {}", cookie_attributes(secure));
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
    let (csrf, cors) = {
        let st = d.state();
        (
            st.settings.api_csrf_protection,
            st.settings.api_cors_origins.clone(),
        )
    };
    let secure = https(client.as_ref());
    // No web page may claim the daemon for its visitor's browser (unless
    // its origin is listed in `api_cors_origins`).
    let host = client.and_then(|Extension(c)| c.host);
    if csrf && cross_origin(&headers, host.as_deref(), &cors) {
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
    logged_in(&d, secure, ip, user_agent(&headers))
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
    client: Option<Extension<Client>>,
) -> Response {
    if let Some(Extension(Principal::Session(sid))) = principal {
        d.auth.end_session(&sid);
    }
    let expired = format!(
        "{SESSION_COOKIE}=; {}; Max-Age=0",
        cookie_attributes(https(client.as_ref()))
    );
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

fn client_use(u: Use) -> ClientUse {
    ClientUse {
        time: u.time,
        address: u.ip.map(|ip| ip.to_string()),
        user_agent: u.user_agent,
    }
}

/// The login's user name, and the API key (when it was made, its last use).
#[utoipa::path(get, path = "/auth/account", tag = "auth", responses((status = 200, body = Account)))]
pub(crate) async fn get_account(State(d): State<Arc<Daemon>>) -> Json<Account> {
    let creds = d.auth.credentials();
    Json(Account {
        username: creds.username,
        api_key: creds.api_key_hash.map(|_| ApiKeyInfo {
            created: creds.api_key_created,
            last_used: d.auth.api_key_use().map(client_use),
        }),
    })
}

/// The login sessions open now, most recently used first. They live in the
/// daemon's memory: a restart ends them.
#[utoipa::path(get, path = "/auth/sessions", tag = "auth", responses((status = 200, body = Vec<LoginSession>)))]
pub(crate) async fn list_sessions(
    State(d): State<Arc<Daemon>>,
    principal: Option<Extension<Principal>>,
) -> Json<Vec<LoginSession>> {
    let timeout = d.state().settings.api_session_timeout;
    let current = match principal {
        Some(Extension(Principal::Session(sid))) => Some(session_id(&sid)),
        _ => None,
    };
    Json(
        d.auth
            .sessions(Duration::from_secs(timeout))
            .into_iter()
            .map(|s| LoginSession {
                current: current.as_deref() == Some(s.id.as_str()),
                id: s.id,
                created: s.created,
                last_used: client_use(s.last),
            })
            .collect(),
    )
}

/// End a login session (its client has to log in again).
#[utoipa::path(delete, path = "/auth/sessions/{id}", tag = "auth", params(SessionPath), responses((status = 204, description = "Ended.")))]
pub(crate) async fn end_session(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<SessionPath>,
) -> ApiResult<StatusCode> {
    if !d.auth.end_session_by_id(&p.id) {
        return Err(ApiError::not_found(format!("no session {}", p.id)));
    }
    d.logs.info("an API login session was ended");
    Ok(no_content())
}

/// End every login session but this request's.
#[utoipa::path(delete, path = "/auth/sessions", tag = "auth", responses((status = 204, description = "Ended.")))]
pub(crate) async fn end_other_sessions(
    State(d): State<Arc<Daemon>>,
    principal: Option<Extension<Principal>>,
) -> StatusCode {
    let keep = match &principal {
        Some(Extension(Principal::Session(sid))) => Some(sid.as_str()),
        _ => None,
    };
    let n = d.auth.end_other_sessions(keep);
    if n > 0 {
        d.logs.info(format!(
            "{n} other API login session{} ended",
            if n == 1 { "" } else { "s" }
        ));
    }
    no_content()
}

/// Addresses with failed logins since their last success, most recent
/// first: those banned from the API (`api_max_auth_failures` reached, for
/// `api_ban_duration`) and those on their way.
#[utoipa::path(get, path = "/auth/bans", tag = "auth", responses((status = 200, body = Vec<LoginBan>)))]
pub(crate) async fn list_login_bans(State(d): State<Arc<Daemon>>) -> Json<Vec<LoginBan>> {
    Json(
        d.auth
            .failed_logins()
            .into_iter()
            .map(|f| LoginBan {
                address: f.ip.to_string(),
                failures: f.count,
                last_failure: f.last,
                banned_until: f.banned_until,
                user_agent: f.user_agent,
            })
            .collect(),
    )
}

/// Lift an address's ban and forget its failed logins.
#[utoipa::path(delete, path = "/auth/bans/{address}", tag = "auth", params(BanPath), responses((status = 204, description = "Forgotten.")))]
pub(crate) async fn unban_login(
    State(d): State<Arc<Daemon>>,
    Path(p): Path<BanPath>,
) -> ApiResult<StatusCode> {
    let ip: IpAddr = p
        .address
        .parse()
        .map_err(|_| ApiError::bad_request(format!("{:?} is not an address", p.address)))?;
    if !d.auth.clear_failures(crate::util::normalize_ip(ip)) {
        return Err(ApiError::not_found(format!("no failed login from {ip}")));
    }
    d.logs.info(format!("API login ban of {ip} lifted"));
    Ok(no_content())
}

/// How the daemon sees this request: the client through the proxies
/// (`api_trusted_proxies`), the host check (`api_allowed_hosts`), the
/// authentication, and the cross-origin check (`api_csrf_protection`). A
/// POST, so a browser sends its `Origin` as with any change; a request the
/// checks refuse gets their error instead.
#[utoipa::path(post, path = "/auth/check", tag = "auth", responses((status = 200, body = RequestCheck)))]
pub(crate) async fn check_request(
    State(d): State<Arc<Daemon>>,
    req: axum::extract::Request,
) -> Json<RequestCheck> {
    Json(super::guard::check(&d, req.extensions(), req.headers()))
}
