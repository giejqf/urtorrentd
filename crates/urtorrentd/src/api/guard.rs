// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Request guards (AGENTS.md 4.10): banned addresses and `Host` checks for
//! every request, authentication (bypass list, API key, login session) and
//! cross-origin protection for the protected routes.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use axum::extract::connect_info::MockConnectInfo;
use axum::extract::{ConnectInfo, FromRequestParts, Request, State};
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use super::SESSION_COOKIE;
use crate::daemon::Daemon;
use crate::error::{ApiError, ErrorCode};
use crate::util::{Cidr, normalize_ip};

/// Who is calling (inserted into request extensions by [`authenticate`]).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Principal {
    /// A login session.
    Session(String),
    /// The API key.
    ApiKey,
    /// An address that needs no authentication.
    Bypass,
}

/// The client's address from the connection (or a test's
/// `MockConnectInfo`), IPv4-mapped addresses folded to IPv4.
fn peer_ip(ext: &axum::http::Extensions) -> Option<IpAddr> {
    ext.get::<ConnectInfo<SocketAddr>>()
        .map(|c| c.0)
        .or_else(|| ext.get::<MockConnectInfo<SocketAddr>>().map(|c| c.0))
        .map(|a| normalize_ip(a.ip()))
}

pub(crate) fn client_ip(req: &Request) -> Option<IpAddr> {
    peer_ip(req.extensions())
}

/// Extractor for the client's address.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ClientIp(pub Option<IpAddr>);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<ClientIp, Self::Rejection> {
        Ok(ClientIp(peer_ip(&parts.extensions)))
    }
}

fn host_part(authority: &str) -> &str {
    if let Some(rest) = authority.strip_prefix('[') {
        return rest.split(']').next().unwrap_or(rest);
    }
    match authority.rsplit_once(':') {
        Some((h, port)) if port.chars().all(|c| c.is_ascii_digit()) => h,
        _ => authority,
    }
}

/// Whether a `Host` header value is acceptable: IP addresses always are,
/// names only when listed (`*`, `*.domain`, or exact).
pub(crate) fn host_allowed(host_header: &str, allowed: &[String]) -> bool {
    let host = host_part(host_header.trim());
    if host.parse::<IpAddr>().is_ok() {
        return true;
    }
    let host = host.to_ascii_lowercase();
    allowed.iter().any(|a| {
        let a = a.trim().to_ascii_lowercase();
        a == "*"
            || a == host
            || a.strip_prefix("*.")
                .is_some_and(|d| host.ends_with(&format!(".{d}")))
    })
}

fn authority_of(url: &str) -> Option<&str> {
    let rest = url.split_once("://")?.1;
    rest.split(['/', '?', '#']).next()
}

/// Whether a browser request comes from another origin than the one it is
/// sent to (only judged when the browser says where it comes from).
fn cross_origin(headers: &HeaderMap) -> bool {
    let host = headers.get(header::HOST).and_then(|v| v.to_str().ok());
    let origin = headers
        .get(header::ORIGIN)
        .or_else(|| headers.get(header::REFERER))
        .and_then(|v| v.to_str().ok());
    match (origin, host) {
        (Some(o), Some(h)) => authority_of(o).is_none_or(|a| !a.eq_ignore_ascii_case(h)),
        (Some(_), None) => true,
        _ => false,
    }
}

fn session_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .filter_map(|kv| kv.trim().split_once('='))
        .find(|(k, _)| *k == SESSION_COOKIE)
        .map(|(_, v)| v.to_string())
}

fn bearer(headers: &HeaderMap) -> Option<String> {
    let v = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = v.split_once(' ')?;
    scheme
        .eq_ignore_ascii_case("bearer")
        .then(|| token.trim().to_string())
}

fn refuse(status: StatusCode, code: ErrorCode, message: &str) -> Response {
    ApiError::new(status, code, message).into_response()
}

/// For every request: refuse banned addresses and unexpected `Host` names.
pub(crate) async fn gate(State(d): State<Arc<Daemon>>, req: Request, next: Next) -> Response {
    let allowed = d.state().settings.api_allowed_hosts.clone();
    if let Some(ip) = client_ip(&req)
        && d.auth.is_banned(ip)
    {
        return refuse(
            StatusCode::FORBIDDEN,
            ErrorCode::Banned,
            "this address is banned after too many failed logins",
        );
    }
    if let Some(host) = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        && !host_allowed(host, &allowed)
    {
        return refuse(
            StatusCode::FORBIDDEN,
            ErrorCode::HostNotAllowed,
            "the Host header names a host that is not allowed",
        );
    }
    next.run(req).await
}

/// For protected routes: establish who is calling, or refuse.
pub(crate) async fn authenticate(
    State(d): State<Arc<Daemon>>,
    mut req: Request,
    next: Next,
) -> Response {
    let (bypass_local, whitelist, csrf, timeout) = {
        let st = d.state();
        let s = &st.settings;
        (
            s.api_bypass_local_auth,
            s.api_auth_whitelist.clone(),
            s.api_csrf_protection,
            s.api_session_timeout,
        )
    };
    let ip = client_ip(&req);
    let bypass = ip.is_some_and(|ip| {
        (bypass_local && ip.is_loopback())
            || whitelist
                .iter()
                .filter_map(|c| Cidr::parse(c))
                .any(|c| c.contains(ip))
    });
    let principal = if bypass {
        Principal::Bypass
    } else if let Some(key) = bearer(req.headers()) {
        if !d.auth.check_api_key(&key) {
            return refuse(
                StatusCode::UNAUTHORIZED,
                ErrorCode::Unauthorized,
                "invalid API key",
            );
        }
        Principal::ApiKey
    } else if let Some(sid) = session_cookie(req.headers()) {
        if !d.auth.touch_session(&sid, Duration::from_secs(timeout)) {
            return refuse(
                StatusCode::UNAUTHORIZED,
                ErrorCode::Unauthorized,
                "the session has expired; log in again",
            );
        }
        let unsafe_method = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
        if csrf && unsafe_method && cross_origin(req.headers()) {
            return refuse(
                StatusCode::FORBIDDEN,
                ErrorCode::CrossOrigin,
                "cross-origin request refused",
            );
        }
        Principal::Session(sid)
    } else {
        return refuse(
            StatusCode::UNAUTHORIZED,
            ErrorCode::Unauthorized,
            "log in or send an API key",
        );
    };
    req.extensions_mut().insert(principal);
    next.run(req).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn hosts() {
        let allowed = vec!["localhost".to_string(), "*.example.com".to_string()];
        assert!(host_allowed("127.0.0.1:8080", &allowed));
        assert!(host_allowed("[::1]:8080", &allowed));
        assert!(host_allowed("localhost:8080", &allowed));
        assert!(host_allowed("LOCALHOST", &allowed));
        assert!(host_allowed("box.example.com", &allowed));
        assert!(!host_allowed("example.com", &allowed));
        assert!(!host_allowed("evil.test:8080", &allowed));
        assert!(host_allowed("evil.test", &["*".to_string()]));
    }

    #[test]
    fn origins() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("localhost:8080"));
        assert!(!cross_origin(&h));
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:8080"),
        );
        assert!(!cross_origin(&h));
        h.insert(header::ORIGIN, HeaderValue::from_static("http://evil.test"));
        assert!(cross_origin(&h));
    }
}
