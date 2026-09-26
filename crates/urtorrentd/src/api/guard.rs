// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Request guards (AGENTS.md 4.10): banned addresses and `Host` checks for
//! every request, authentication (bypass list, API key, login session) and
//! cross-origin protection for the protected routes.

use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
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
use crate::model::{AuthMethod, CsrfCheck, HostCheck, ProxyCheck, RequestCheck};
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

/// The client as the gate established it: behind a trusted reverse proxy,
/// the address and host the proxy forwards.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Client {
    pub ip: Option<IpAddr>,
    pub host: Option<String>,
    /// A trusted proxy says the client used HTTPS (`X-Forwarded-Proto`):
    /// the session cookie gets `Secure`.
    pub https: bool,
    /// The request carries forwarding headers from a peer that is not a
    /// trusted proxy: the real client is unknown, so no address-based
    /// exemption from authentication applies.
    pub forwarded_by_untrusted: bool,
}

/// Headers a reverse proxy adds to name the client.
const FORWARDING_HEADERS: [&str; 3] = ["x-forwarded-for", "x-real-ip", "forwarded"];

/// The client of a request coming from `peer`: when `peer` is a trusted
/// proxy, `X-Forwarded-For` names the client (the last address that is not
/// a trusted proxy, reading from the right), `X-Forwarded-Host` the host
/// and `X-Forwarded-Proto` the scheme; otherwise the connection and `Host`
/// do.
pub(crate) fn forwarded(headers: &HeaderMap, peer: Option<IpAddr>, trusted: &[Cidr]) -> Client {
    let host = headers
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    let is_trusted = |ip: IpAddr| trusted.iter().any(|c| c.contains(ip));
    if !peer.is_some_and(is_trusted) {
        return Client {
            ip: peer,
            host,
            https: false,
            forwarded_by_untrusted: FORWARDING_HEADERS.iter().any(|h| headers.contains_key(*h)),
        };
    }
    // Read from the right: those entries were added by the trusted proxies;
    // anything left of the first address that is not theirs (or of an entry
    // that does not parse) the client may have made up.
    let entries: Vec<&str> = headers
        .get_all("x-forwarded-for")
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .collect();
    let mut ip = peer;
    for e in entries.iter().rev() {
        let Ok(hop) = e.trim().parse::<IpAddr>() else {
            break;
        };
        let hop = normalize_ip(hop);
        ip = Some(hop);
        if !is_trusted(hop) {
            break;
        }
    }
    let host = headers
        .get("x-forwarded-host")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(|h| h.trim().to_string())
        .filter(|h| !h.is_empty())
        .or(host);
    let https = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .is_some_and(|p| p.trim().eq_ignore_ascii_case("https"));
    Client {
        ip,
        host,
        https,
        forwarded_by_untrusted: false,
    }
}

pub(crate) fn client_ip(req: &Request) -> Option<IpAddr> {
    match req.extensions().get::<Client>() {
        Some(c) => c.ip,
        None => peer_ip(req.extensions()),
    }
}

/// Extractor for the client's address.
#[derive(Debug, Clone, Copy)]
pub(crate) struct ClientIp(pub Option<IpAddr>);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = std::convert::Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<ClientIp, Self::Rejection> {
        Ok(ClientIp(match parts.extensions.get::<Client>() {
            Some(c) => c.ip,
            None => peer_ip(&parts.extensions),
        }))
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
/// sent to (only judged when the browser says where it comes from), and
/// that origin is not one of `allowed` (`api_cors_origins`).
pub(crate) fn cross_origin(headers: &HeaderMap, host: Option<&str>, allowed: &[String]) -> bool {
    if super::cors::listed_origin(headers, allowed).is_some() {
        return false;
    }
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

/// Whether the one-time warning about a proxy that is not trusted was logged.
static UNTRUSTED_PROXY_WARNED: AtomicBool = AtomicBool::new(false);

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

/// For every request: work out the client (through trusted proxies), then
/// refuse banned addresses and unexpected `Host` names.
pub(crate) async fn gate(State(d): State<Arc<Daemon>>, mut req: Request, next: Next) -> Response {
    let (allowed, trusted) = {
        let st = d.state();
        let trusted: Vec<Cidr> = st
            .settings
            .api_trusted_proxies
            .iter()
            .filter_map(|c| Cidr::parse(c))
            .collect();
        (st.settings.api_allowed_hosts.clone(), trusted)
    };
    let client = forwarded(req.headers(), peer_ip(req.extensions()), &trusted);
    req.extensions_mut().insert(client.clone());
    if let Some(ip) = client.ip
        && d.auth.is_banned(ip)
    {
        return refuse(
            StatusCode::FORBIDDEN,
            ErrorCode::Banned,
            "this address is banned after too many failed logins",
        );
    }
    if let Some(host) = &client.host
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
    let (bypass_local, whitelist, csrf, timeout, cors) = {
        let st = d.state();
        let s = &st.settings;
        (
            s.api_bypass_local_auth,
            s.api_auth_whitelist.clone(),
            s.api_csrf_protection,
            s.api_session_timeout,
            s.api_cors_origins.clone(),
        )
    };
    let ip = client_ip(&req);
    let exempt = ip.is_some_and(|ip| {
        (bypass_local && ip.is_loopback())
            || whitelist
                .iter()
                .filter_map(|c| Cidr::parse(c))
                .any(|c| c.contains(ip))
    });
    // A reverse proxy that is not in `api_trusted_proxies` makes every
    // client look like the proxy (often loopback): never exempt those.
    let relayed = req
        .extensions()
        .get::<Client>()
        .is_some_and(|c| c.forwarded_by_untrusted);
    if exempt && relayed && !UNTRUSTED_PROXY_WARNED.swap(true, Ordering::Relaxed) {
        d.logs.warn(format!(
            "a request relayed by {} carries forwarding headers but that address is not in \
             api_trusted_proxies: its clients are not exempt from authentication; add the \
             proxy to api_trusted_proxies",
            ip.map_or_else(|| "an unknown address".to_string(), |ip| ip.to_string())
        ));
    }
    let bypass = exempt && !relayed;
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
        d.auth.api_key_used(ip, user_agent(req.headers()));
        Principal::ApiKey
    } else if let Some(sid) = session_cookie(req.headers()) {
        if !d.auth.touch_session(&sid, Duration::from_secs(timeout), ip) {
            return refuse(
                StatusCode::UNAUTHORIZED,
                ErrorCode::Unauthorized,
                "the session has expired; log in again",
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
    // Browsers send cookies, and reach loopback and whitelisted addresses
    // for any page they show: a state-changing request needs the page's
    // origin to be this host (or listed). A request with the API key is
    // never a browser's own doing.
    let unsafe_method = !matches!(*req.method(), Method::GET | Method::HEAD | Method::OPTIONS);
    if csrf && unsafe_method && principal != Principal::ApiKey {
        let host = req
            .extensions()
            .get::<Client>()
            .and_then(|c| c.host.clone());
        if cross_origin(req.headers(), host.as_deref(), &cors) {
            return refuse(
                StatusCode::FORBIDDEN,
                ErrorCode::CrossOrigin,
                "cross-origin request refused",
            );
        }
    }
    req.extensions_mut().insert(principal);
    next.run(req).await
}

/// The request's `User-Agent`, as kept.
pub(crate) fn user_agent(headers: &HeaderMap) -> Option<String> {
    crate::auth::user_agent(
        headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok()),
    )
}

/// How the daemon sees a request that got through [`gate`] and
/// [`authenticate`] (`POST /auth/check`).
pub(crate) fn check(
    d: &Daemon,
    parts: &axum::http::Extensions,
    headers: &HeaderMap,
) -> RequestCheck {
    let (trusted, whitelist, csrf, cors) = {
        let st = d.state();
        let s = &st.settings;
        (
            s.api_trusted_proxies
                .iter()
                .filter_map(|c| Cidr::parse(c))
                .collect::<Vec<_>>(),
            s.api_auth_whitelist
                .iter()
                .filter_map(|c| Cidr::parse(c))
                .collect::<Vec<_>>(),
            s.api_csrf_protection,
            s.api_cors_origins.clone(),
        )
    };
    let peer = peer_ip(parts);
    let client = parts.get::<Client>();
    let client_ip = client.and_then(|c| c.ip).or(peer);
    let host = client.and_then(|c| c.host.clone());
    let proxy = if client.is_some_and(|c| c.forwarded_by_untrusted) {
        ProxyCheck::Untrusted
    } else if peer.is_some_and(|p| trusted.iter().any(|c| c.contains(p))) {
        ProxyCheck::Trusted
    } else {
        ProxyCheck::None
    };
    let host_check = match &host {
        None => HostCheck::None,
        Some(h) if host_part(h.trim()).parse::<IpAddr>().is_ok() => HostCheck::Address,
        Some(_) => HostCheck::Allowed,
    };
    let auth = match parts.get::<Principal>() {
        Some(Principal::Session(_)) => AuthMethod::Session,
        Some(Principal::ApiKey) => AuthMethod::ApiKey,
        _ if client_ip.is_some_and(|ip| whitelist.iter().any(|c| c.contains(ip))) => {
            AuthMethod::Whitelist
        }
        _ => AuthMethod::Loopback,
    };
    let named = headers.contains_key(header::ORIGIN) || headers.contains_key(header::REFERER);
    let csrf = if !csrf {
        CsrfCheck::Off
    } else if auth == AuthMethod::ApiKey {
        CsrfCheck::NotApplied
    } else if super::cors::listed_origin(headers, &cors).is_some() {
        CsrfCheck::ListedOrigin
    } else if named {
        CsrfCheck::SameOrigin
    } else {
        CsrfCheck::NoOrigin
    };
    RequestCheck {
        peer: peer.map(|p| p.to_string()),
        client: client_ip.map(|p| p.to_string()),
        proxy,
        host,
        host_check,
        https: client.is_some_and(|c| c.https),
        auth,
        csrf,
    }
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
        let host = Some("localhost:8080");
        assert!(!cross_origin(&h, host, &[]));
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://localhost:8080"),
        );
        assert!(!cross_origin(&h, host, &[]));
        // Behind a TLS-terminating proxy: the authority is compared, not the scheme.
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("https://localhost:8080"),
        );
        assert!(!cross_origin(&h, host, &[]));
        h.insert(header::ORIGIN, HeaderValue::from_static("http://evil.test"));
        assert!(cross_origin(&h, host, &[]));
        assert!(cross_origin(&h, None, &[]));
        // A listed CORS origin is not cross-origin for the CSRF check.
        let listed = vec!["http://ui.test:3000".to_string()];
        assert!(cross_origin(&h, host, &listed));
        h.insert(
            header::ORIGIN,
            HeaderValue::from_static("http://UI.test:3000"),
        );
        assert!(!cross_origin(&h, host, &listed));
    }

    #[test]
    fn forwarded_scheme_and_untrusted_relays() {
        let ip = |s: &str| s.parse::<IpAddr>().ok();
        let proxy = Cidr::parse("127.0.0.1").into_iter().collect::<Vec<_>>();
        let mut h = HeaderMap::new();
        h.insert("x-forwarded-proto", HeaderValue::from_static("https"));
        h.insert("x-forwarded-for", HeaderValue::from_static("203.0.113.9"));
        let c = forwarded(&h, ip("127.0.0.1"), &proxy);
        assert!(c.https && !c.forwarded_by_untrusted);
        assert_eq!(c.ip, ip("203.0.113.9"));
        // The same headers from a peer that is not trusted: not believed,
        // and flagged.
        let c = forwarded(&h, ip("127.0.0.1"), &[]);
        assert!(!c.https && c.forwarded_by_untrusted);
        assert_eq!(c.ip, ip("127.0.0.1"));
        // A direct client.
        let c = forwarded(&HeaderMap::new(), ip("127.0.0.1"), &[]);
        assert!(!c.https && !c.forwarded_by_untrusted);
        h.insert("x-forwarded-proto", HeaderValue::from_static("http"));
        assert!(!forwarded(&h, ip("127.0.0.1"), &proxy).https);
    }

    #[test]
    fn trusted_proxies_forward_the_client() {
        let ip = |s: &str| s.parse::<IpAddr>().ok();
        let proxy = Cidr::parse("10.0.0.0/8").into_iter().collect::<Vec<_>>();
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("internal:8080"));
        h.insert(
            "x-forwarded-for",
            HeaderValue::from_static("203.0.113.9, 198.51.100.7, 10.0.0.2"),
        );
        h.insert(
            "x-forwarded-host",
            HeaderValue::from_static("torrents.example"),
        );
        // From the proxy: the last hop that is not a trusted proxy.
        let c = forwarded(&h, ip("10.0.0.1"), &proxy);
        assert_eq!(c.ip, ip("198.51.100.7"));
        assert_eq!(c.host.as_deref(), Some("torrents.example"));
        // From anyone else: the headers are not believed.
        let c = forwarded(&h, ip("192.0.2.1"), &proxy);
        assert_eq!(c.ip, ip("192.0.2.1"));
        assert_eq!(c.host.as_deref(), Some("internal:8080"));
        // No proxies configured: likewise.
        assert_eq!(forwarded(&h, ip("10.0.0.1"), &[]).ip, ip("10.0.0.1"));
        // Garbage stops the reading: what the client wrote left of it is
        // never believed over what the proxy appended.
        h.insert("x-forwarded-for", HeaderValue::from_static("nonsense"));
        assert_eq!(forwarded(&h, ip("10.0.0.1"), &proxy).ip, ip("10.0.0.1"));
        h.insert(
            "x-forwarded-for",
            HeaderValue::from_static("127.0.0.1, garbage, 198.51.100.7"),
        );
        assert_eq!(forwarded(&h, ip("10.0.0.1"), &proxy).ip, ip("198.51.100.7"));
    }
}
