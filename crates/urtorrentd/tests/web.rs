// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The web UI next to the API (ADR 0008): its files at `/`, headers, the
//! single-page fallback and what is never served; CORS for listed origins;
//! the `Secure` session cookie behind a trusted HTTPS proxy; and no address
//! exemption from authentication for requests an untrusted proxy relays.

#![allow(clippy::unwrap_used, missing_docs)]

mod common;

use std::net::SocketAddr;
use std::path::Path;

use axum::Router;
use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use common::TestDaemon;
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tower::ServiceExt;
use urtorrentd::api;
use urtorrentd::settings::SettingsPatch;
use urtorrentd::web::WebUi;

const INDEX: &str = "<!doctype html><title>urtorrent</title>";

/// A build of the UI as Vite lays it out, plus things that must not be served.
fn ui_build(dir: &Path) {
    std::fs::write(dir.join("index.html"), INDEX).unwrap();
    std::fs::create_dir(dir.join("assets")).unwrap();
    std::fs::write(dir.join("assets/index-4f6a1ad0.js"), "console.log(1)").unwrap();
    std::fs::write(dir.join("assets/index-9c2b7e41.css"), "body{}").unwrap();
    std::fs::write(dir.join("favicon.svg"), "<svg/>").unwrap();
    std::fs::write(dir.join(".env"), "SECRET=1").unwrap();
}

fn client() -> MockConnectInfo<SocketAddr> {
    MockConnectInfo("127.0.0.1:40000".parse().unwrap())
}

/// Send a request; API responses are validated against the schema.
async fn send(router: &Router, req: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
    let method = req.method().clone();
    let path = req.uri().path().to_string();
    let resp = router.clone().oneshot(req).await.unwrap();
    let status = resp.status();
    let headers = resp.headers().clone();
    let body = resp
        .into_body()
        .collect()
        .await
        .unwrap()
        .to_bytes()
        .to_vec();
    if path.starts_with("/api/v1/") && common::operation_exists(&method, &path) {
        common::validate_response(&method, &path, status, &body, &headers);
    }
    (status, headers, body)
}

fn get(path: &str) -> Request<Body> {
    Request::get(path)
        .header(header::HOST, "localhost:8080")
        .body(Body::empty())
        .unwrap()
}

fn json_body(body: &[u8]) -> Value {
    serde_json::from_slice(body).unwrap_or(Value::Null)
}

fn header<'a>(h: &'a HeaderMap, name: &str) -> &'a str {
    h.get(name).map_or("", |v| v.to_str().unwrap())
}

#[tokio::test]
async fn serves_the_ui_next_to_the_api() {
    let t = TestDaemon::start(91, |s| s.api_bypass_local_auth = false).await;
    let dir = tempfile::tempdir().unwrap();
    ui_build(dir.path());
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("secret.txt"), "no").unwrap();
    std::os::unix::fs::symlink(
        outside.path().join("secret.txt"),
        dir.path().join("leak.txt"),
    )
    .unwrap();
    let ui = WebUi::dir(dir.path()).unwrap();
    let router = api::router_with_ui(t.daemon.clone(), Some(ui)).layer(client());

    // The page, public, with its headers.
    let (s, h, b) = send(&router, get("/")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b, INDEX.as_bytes());
    assert_eq!(header(&h, "content-type"), "text/html; charset=utf-8");
    assert_eq!(header(&h, "cache-control"), "no-cache");
    let csp = header(&h, "content-security-policy");
    assert!(csp.contains("default-src 'self'"), "{csp}");
    assert!(csp.contains("frame-ancestors 'none'"), "{csp}");
    assert!(!csp.contains("script-src 'self' 'unsafe"), "{csp}");
    assert_eq!(header(&h, "x-frame-options"), "DENY");
    assert_eq!(header(&h, "x-content-type-options"), "nosniff");
    assert_eq!(header(&h, "referrer-policy"), "no-referrer");

    // Routes of the single-page app get the page.
    for route in [
        "/torrents",
        "/torrents/0123456789abcdef",
        "/settings/security",
    ] {
        let (s, h, b) = send(&router, get(route)).await;
        assert_eq!(s, StatusCode::OK, "{route}");
        assert_eq!(b, INDEX.as_bytes(), "{route}");
        assert_eq!(header(&h, "content-type"), "text/html; charset=utf-8");
    }
    let head = Request::head("/torrents").body(Body::empty()).unwrap();
    assert_eq!(send(&router, head).await.0, StatusCode::OK);

    // Hashed assets are cached for good; other files are revalidated.
    let (s, h, b) = send(&router, get("/assets/index-4f6a1ad0.js")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(b, b"console.log(1)");
    assert_eq!(header(&h, "content-type"), "text/javascript; charset=utf-8");
    assert_eq!(
        header(&h, "cache-control"),
        "public, max-age=31536000, immutable"
    );
    let (_, h, _) = send(&router, get("/assets/index-9c2b7e41.css")).await;
    assert_eq!(header(&h, "content-type"), "text/css; charset=utf-8");
    let (s, h, _) = send(&router, get("/favicon.svg")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(header(&h, "content-type"), "image/svg+xml");
    assert_eq!(header(&h, "cache-control"), "no-cache");

    // Missing files, hidden files, escapes and links out: 404, never the page.
    for path in [
        "/assets/index-00000000.js",
        "/.env",
        "/assets/../.env",
        "/assets/%2e%2e/.env",
        "/leak.txt",
    ] {
        let (s, _, b) = send(&router, get(path)).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(json_body(&b)["error"]["code"], "not_found", "{path}");
    }
    let post = Request::post("/").body(Body::empty()).unwrap();
    assert_eq!(send(&router, post).await.0, StatusCode::NOT_FOUND);

    // The API is untouched: its unknown paths stay JSON 404s, and it still
    // needs a session while the UI's files do not.
    for path in ["/api", "/api/v1/nope", "/api/v2/app"] {
        let (s, _, b) = send(&router, get(path)).await;
        assert_eq!(s, StatusCode::NOT_FOUND, "{path}");
        assert_eq!(json_body(&b)["error"]["message"], "no such endpoint");
    }
    let (s, _, b) = send(&router, get("/api/v1/app")).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(json_body(&b)["error"]["code"], "unauthorized");
    assert_eq!(
        send(&router, get("/api/v1/auth/status")).await.0,
        StatusCode::OK
    );

    // The host check covers the UI too (DNS rebinding).
    let evil = Request::get("/")
        .header(header::HOST, "evil.test")
        .body(Body::empty())
        .unwrap();
    let (s, _, b) = send(&router, evil).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(json_body(&b)["error"]["code"], "host_not_allowed");

    // Without a UI, the daemon is the API only.
    let bare = api::router(t.daemon.clone()).layer(client());
    let (s, _, b) = send(&bare, get("/")).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(json_body(&b)["error"]["message"], "no such endpoint");
    t.stop().await;
}

#[test]
fn a_ui_directory_needs_an_index() {
    let dir = tempfile::tempdir().unwrap();
    let e = WebUi::dir(dir.path()).unwrap_err();
    assert!(e.to_string().contains("no index.html"), "{e}");
    assert!(WebUi::dir(&dir.path().join("missing")).is_err());
}

/// `POST /auth/setup` as `(status, Set-Cookie)`.
async fn setup(router: &Router, extra: &[(&str, &str)]) -> (StatusCode, String) {
    let mut b = Request::post("/api/v1/auth/setup")
        .header(header::HOST, "localhost:8080")
        .header(header::CONTENT_TYPE, "application/json");
    for (k, v) in extra {
        b = b.header(*k, *v);
    }
    let body = json!({"username": "admin", "password": "correct horse"}).to_string();
    let (s, h, _) = send(router, b.body(Body::from(body)).unwrap()).await;
    (s, header(&h, "set-cookie").to_string())
}

async fn login(router: &Router, extra: &[(&str, &str)]) -> (StatusCode, String) {
    let mut b = Request::post("/api/v1/auth/login")
        .header(header::HOST, "localhost:8080")
        .header(header::CONTENT_TYPE, "application/json");
    for (k, v) in extra {
        b = b.header(*k, *v);
    }
    let body = json!({"username": "admin", "password": "correct horse"}).to_string();
    let (s, h, _) = send(router, b.body(Body::from(body)).unwrap()).await;
    (s, header(&h, "set-cookie").to_string())
}

/// Change settings as the daemon's owner (outside the API).
async fn patch(t: &TestDaemon, f: impl FnOnce(&mut SettingsPatch)) {
    let mut p = SettingsPatch::default();
    f(&mut p);
    t.daemon.update_settings(p).await.unwrap();
}

fn session(set_cookie: &str) -> String {
    set_cookie.split(';').next().unwrap().to_string()
}

#[tokio::test]
async fn cors_for_listed_origins() {
    const UI: &str = "http://ui.test:3000";
    let t = TestDaemon::start(92, |s| {
        s.api_bypass_local_auth = false;
        s.api_cors_origins = vec![UI.to_string()];
    })
    .await;
    let router = api::router(t.daemon.clone()).layer(client());
    let (s, cookie) = setup(&router, &[]).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let sid = session(&cookie);

    // A preflight from a listed origin is answered before authentication.
    let preflight = |origin: &str| {
        Request::builder()
            .method(Method::OPTIONS)
            .uri("/api/v1/torrents/stop")
            .header(header::HOST, "localhost:8080")
            .header(header::ORIGIN, origin)
            .header(header::ACCESS_CONTROL_REQUEST_METHOD, "POST")
            .header(header::ACCESS_CONTROL_REQUEST_HEADERS, "content-type")
            .body(Body::empty())
            .unwrap()
    };
    let (s, h, _) = send(&router, preflight(UI)).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(header(&h, "access-control-allow-origin"), UI);
    assert_eq!(header(&h, "access-control-allow-credentials"), "true");
    assert!(header(&h, "access-control-allow-methods").contains("POST"));
    assert!(header(&h, "access-control-allow-headers").contains("content-type"));
    assert!(header(&h, "access-control-allow-headers").contains("last-event-id"));
    assert!(header(&h, "vary").contains("origin"));
    // Origins are compared without regard to case, as browsers may differ.
    let (s, _, _) = send(&router, preflight("http://UI.test:3000")).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    // Anyone else is refused, with nothing that lets a browser through.
    let (s, h, b) = send(&router, preflight("http://evil.test")).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(json_body(&b)["error"]["code"], "cross_origin");
    assert!(h.get("access-control-allow-origin").is_none());

    // Every response to a listed origin carries the headers, errors too.
    let from = |origin: &str, cookie: Option<&str>, method: Method, path: &str| {
        let mut b = Request::builder()
            .method(method)
            .uri(path)
            .header(header::HOST, "localhost:8080")
            .header(header::ORIGIN, origin);
        if let Some(c) = cookie {
            b = b.header(header::COOKIE, c);
        }
        if path.ends_with("/stop") {
            b = b.header(header::CONTENT_TYPE, "application/json");
            return b.body(Body::from(r#"{"hashes": "all"}"#)).unwrap();
        }
        b.body(Body::empty()).unwrap()
    };
    let (s, h, b) = send(&router, from(UI, None, Method::GET, "/api/v1/app")).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(json_body(&b)["error"]["code"], "unauthorized");
    assert_eq!(header(&h, "access-control-allow-origin"), UI);
    let (s, h, _) = send(&router, from(UI, Some(&sid), Method::GET, "/api/v1/app")).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(header(&h, "access-control-allow-origin"), UI);

    // A listed origin passes the CSRF check; another does not.
    let stop = "/api/v1/torrents/stop";
    let (s, h, _) = send(&router, from(UI, Some(&sid), Method::POST, stop)).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(header(&h, "access-control-allow-origin"), UI);
    let (s, h, b) = send(
        &router,
        from("http://evil.test", Some(&sid), Method::POST, stop),
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(json_body(&b)["error"]["code"], "cross_origin");
    assert!(h.get("access-control-allow-origin").is_none());

    // The setting is validated.
    for bad in ["*", "https://ui.test/app", "ui.test:3000"] {
        let patch = SettingsPatch {
            api_cors_origins: Some(vec![bad.to_string()]),
            ..SettingsPatch::default()
        };
        assert!(t.daemon.update_settings(patch).await.is_err(), "{bad}");
    }

    // With no origins listed, the daemon sends no CORS headers at all.
    patch(&t, |p| p.api_cors_origins = Some(Vec::new())).await;
    let (s, h, _) = send(&router, preflight(UI)).await;
    assert_ne!(s, StatusCode::NO_CONTENT);
    assert!(h.get("access-control-allow-origin").is_none());
    let (_, h, _) = send(&router, from(UI, Some(&sid), Method::GET, "/api/v1/app")).await;
    assert!(h.get("access-control-allow-origin").is_none());
    t.stop().await;
}

#[tokio::test]
async fn secure_cookie_behind_a_trusted_https_proxy() {
    let t = TestDaemon::start(93, |s| {
        s.api_bypass_local_auth = false;
        s.api_trusted_proxies = vec!["127.0.0.1".to_string()];
    })
    .await;
    let router = api::router(t.daemon.clone()).layer(client());
    let via_https = [
        ("x-forwarded-for", "203.0.113.9"),
        ("x-forwarded-proto", "https"),
    ];
    let (s, cookie) = setup(&router, &via_https).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert!(cookie.contains("; Secure;"), "{cookie}");
    assert!(cookie.contains("HttpOnly") && cookie.contains("SameSite=Strict"));
    let (s, cookie) = login(&router, &[("x-forwarded-for", "203.0.113.9")]).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert!(!cookie.contains("Secure"), "{cookie}");
    let (_, cookie) = login(&router, &via_https).await;
    let logout = Request::post("/api/v1/auth/logout")
        .header(header::HOST, "localhost:8080")
        .header(header::COOKIE, session(&cookie))
        .header("x-forwarded-proto", "https")
        .body(Body::empty())
        .unwrap();
    let (s, h, _) = send(&router, logout).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert!(header(&h, "set-cookie").contains("; Secure;"));
    t.stop().await;

    // The scheme is only believed from a trusted proxy.
    let t = TestDaemon::start(94, |s| s.api_bypass_local_auth = false).await;
    let router = api::router(t.daemon.clone()).layer(client());
    let (s, cookie) = setup(&router, &via_https).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert!(!cookie.contains("Secure"), "{cookie}");
    t.stop().await;
}

#[tokio::test]
async fn untrusted_relays_are_never_exempt() {
    // Loopback clients are exempt (the harness's default), but a request
    // relayed by a proxy that is not trusted comes from someone unknown.
    let t = TestDaemon::start(95, |_| {}).await;
    let router = api::router(t.daemon.clone()).layer(client());
    let relayed = |header_name: &str| {
        Request::get("/api/v1/app")
            .header(header::HOST, "localhost:8080")
            .header(header_name, "203.0.113.9")
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(send(&router, get("/api/v1/app")).await.0, StatusCode::OK);
    for h in ["x-forwarded-for", "x-real-ip", "forwarded"] {
        let (s, _, b) = send(&router, relayed(h)).await;
        assert_eq!(s, StatusCode::UNAUTHORIZED, "{h}");
        assert_eq!(json_body(&b)["error"]["code"], "unauthorized");
    }
    let log = t.get("/api/v1/log").await;
    assert!(
        log.as_array().unwrap().iter().any(|e| e["message"]
            .as_str()
            .unwrap()
            .contains("not in api_trusted_proxies")),
        "{log}"
    );

    // Trusted, the proxy names the client: exempt only if it is loopback.
    patch(&t, |p| {
        p.api_trusted_proxies = Some(vec!["127.0.0.1".to_string()])
    })
    .await;
    assert_eq!(
        send(&router, relayed("x-forwarded-for")).await.0,
        StatusCode::UNAUTHORIZED
    );
    let local = Request::get("/api/v1/app")
        .header(header::HOST, "localhost:8080")
        .header("x-forwarded-for", "127.0.0.1")
        .body(Body::empty())
        .unwrap();
    assert_eq!(send(&router, local).await.0, StatusCode::OK);

    // The same for the whitelist.
    patch(&t, |p| {
        p.api_trusted_proxies = Some(Vec::new());
        p.api_bypass_local_auth = Some(false);
        p.api_auth_whitelist = Some(vec!["127.0.0.0/8".to_string()]);
    })
    .await;
    assert_eq!(send(&router, get("/api/v1/app")).await.0, StatusCode::OK);
    assert_eq!(
        send(&router, relayed("x-forwarded-for")).await.0,
        StatusCode::UNAUTHORIZED
    );
    t.stop().await;
}
