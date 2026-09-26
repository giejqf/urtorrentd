// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Authentication, request guards, settings and errors through the API.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::TestDaemon;
use serde_json::json;

fn req(method: Method, path: &str) -> axum::http::request::Builder {
    Request::builder().method(method).uri(path)
}

fn json_body(v: serde_json::Value) -> Body {
    Body::from(v.to_string())
}

#[tokio::test]
async fn login_sessions_keys_and_bans() {
    let t = TestDaemon::start(21, |s| {
        s.api_bypass_local_auth = false;
        s.api_max_auth_failures = 3;
    })
    .await;
    let temp = t.daemon.temporary_password().unwrap().to_string();

    // Nothing without authentication.
    let (s, v) = t.call(Method::GET, "/api/v1/app", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    assert_eq!(v["error"]["code"], "unauthorized");

    // Wrong password.
    let (s, _) = t
        .post(
            "/api/v1/auth/login",
            json!({"username": "admin", "password": "nope"}),
        )
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // Right password: a cookie that works.
    let (s, headers, _) = t
        .request(
            req(Method::POST, "/api/v1/auth/login")
                .header("content-type", "application/json")
                .body(json_body(json!({"username": "admin", "password": temp})))
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let cookie = headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string();
    assert!(cookie.starts_with("urtorrentd_sid="));
    let (s, _, body) = t
        .request(
            req(Method::GET, "/api/v1/app")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&body));

    // A state-changing request from another origin is refused; same origin is fine.
    let tag_req = |origin: &str| {
        req(Method::POST, "/api/v1/tags")
            .header("cookie", &cookie)
            .header("host", "127.0.0.1:8080")
            .header("origin", origin)
            .header("content-type", "application/json")
            .body(json_body(json!({"tags": ["x"]})))
            .unwrap()
    };
    let (s, _, body) = t.request(tag_req("http://evil.test")).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert!(String::from_utf8_lossy(&body).contains("cross_origin"));
    let (s, _, _) = t.request(tag_req("http://127.0.0.1:8080")).await;
    assert_eq!(s, StatusCode::NO_CONTENT);

    // API key: works as a bearer token, stops working when deleted.
    let (s, _, body) = t
        .request(
            req(Method::POST, "/api/v1/auth/api-key")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let key = serde_json::from_slice::<serde_json::Value>(&body).unwrap()["api_key"]
        .as_str()
        .unwrap()
        .to_string();
    let with_key = |k: &str| {
        req(Method::GET, "/api/v1/torrents")
            .header("authorization", format!("Bearer {k}"))
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(t.request(with_key(&key)).await.0, StatusCode::OK);
    assert_eq!(
        t.request(with_key("urtd_wrong")).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (s, _, _) = t
        .request(
            req(Method::DELETE, "/api/v1/auth/api-key")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(t.request(with_key(&key)).await.0, StatusCode::UNAUTHORIZED);

    // New credentials end every session; the temporary password stops working.
    let (s, _, _) = t
        .request(
            req(Method::PUT, "/api/v1/auth/credentials")
                .header("cookie", &cookie)
                .header("content-type", "application/json")
                .body(json_body(
                    json!({"username": "me", "password": "correct horse"}),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _, _) = t
        .request(
            req(Method::GET, "/api/v1/app")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    let (s, _) = t
        .post(
            "/api/v1/auth/login",
            json!({"username": "admin", "password": temp}),
        )
        .await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);

    // The third failure in a row bans the address, even for the right password.
    for _ in 0..2 {
        let (s, _) = t
            .post(
                "/api/v1/auth/login",
                json!({"username": "me", "password": "wrong"}),
            )
            .await;
        assert_eq!(s, StatusCode::UNAUTHORIZED);
    }
    let (s, v) = t
        .post(
            "/api/v1/auth/login",
            json!({"username": "me", "password": "correct horse"}),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN, "{v}");
    assert_eq!(v["error"]["code"], "banned");
    t.stop().await;
}

#[tokio::test]
async fn host_names_are_checked() {
    let t = TestDaemon::start(22, |_| {}).await;
    let get = |host: &str| {
        req(Method::GET, "/api/v1/app")
            .header("host", host)
            .body(Body::empty())
            .unwrap()
    };
    assert_eq!(t.request(get("127.0.0.1:8080")).await.0, StatusCode::OK);
    assert_eq!(t.request(get("localhost:8080")).await.0, StatusCode::OK);
    let (s, _, body) = t.request(get("rebind.evil.test:8080")).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert!(String::from_utf8_lossy(&body).contains("host_not_allowed"));
    t.stop().await;
}

#[tokio::test]
async fn settings_apply_live_and_report_restarts() {
    let t = TestDaemon::start(23, |_| {}).await;
    let s = t.get("/api/v1/settings").await;
    assert_eq!(s["download_limit"], json!(null));

    let (st, v) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"upload_limit": 65536, "download_limit": 131072, "max_uploads": 3, "pex": false})),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    assert_eq!(v["upload_limit"], 65536);
    let live = t.daemon.session().settings().await.unwrap();
    assert_eq!(live.upload_limit, 65536);
    assert_eq!(live.download_limit, 131072);
    assert_eq!(live.unchoke_slots, 3);
    assert!(!live.pex);

    // The alternative limits take over while enabled.
    let (st, _) = t
        .call(
            Method::PUT,
            "/api/v1/transfer/alt-speed",
            Some(json!({"enabled": true})),
        )
        .await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let live = t.daemon.session().settings().await.unwrap();
    assert_eq!(live.upload_limit, 10 * 1024 * 1024);
    let transfer = t.get("/api/v1/transfer").await;
    assert_eq!(transfer["alt_speed_enabled"], true);

    // Validation, unknown fields, nulls where not allowed.
    for bad in [
        json!({"save_path": "relative/path"}),
        json!({"no_such_setting": 1}),
        json!({"listen_port": null}),
        json!({"max_ratio": -1.0}),
    ] {
        let (st, v) = t
            .call(Method::PATCH, "/api/v1/settings", Some(bad.clone()))
            .await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{bad} -> {v}");
        assert_eq!(v["error"]["code"], "bad_request");
    }

    // Engine tuning applies after a restart and says so.
    let (st, _) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"hash_threads": 3})),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let app = t.get("/api/v1/app").await;
    assert_eq!(app["restart_required"], json!(["hash_threads"]));
    // Beside what runs, since when.
    assert_eq!(app["running"]["hash_threads"], 2, "{app}");
    assert_eq!(app["running"]["disk_thread"], true);
    let since = app["restart_required_since"].as_u64().unwrap();
    assert!(since + 60 > urtorrentd::util::now());
    assert_eq!(app["restart_waiting"], false);
    // Back to the running value: nothing waits.
    let (st, _) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"hash_threads": 2})),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let app = t.get("/api/v1/app").await;
    assert_eq!(app["restart_required"], json!([]));
    assert_eq!(app["restart_required_since"], serde_json::Value::Null);

    // The machine.
    let sys = t.get("/api/v1/app/system").await;
    assert!(sys["cpus"].as_u64().unwrap() >= 1, "{sys}");
    assert!(!sys["kernel"].as_str().unwrap().is_empty());
    assert!(sys["open_files"].as_u64().unwrap() > 0);
    assert!(sys["save_path_fs"]["total"].as_u64().unwrap() > 0, "{sys}");

    // Address ranges: blocks and first-last ranges reach the engine.
    let (st, v) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"banned_ip_ranges": ["10.0.0.0/8", "192.168.1.10-192.168.1.20"]})),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{v}");
    let ranges = t.daemon.session().banned_ip_ranges().await.unwrap();
    let as_text: Vec<(String, String)> = ranges
        .iter()
        .map(|(a, b)| (a.to_string(), b.to_string()))
        .collect();
    assert!(
        as_text.contains(&("10.0.0.0".into(), "10.255.255.255".into())),
        "{as_text:?}"
    );
    assert!(
        as_text.contains(&("192.168.1.10".into(), "192.168.1.20".into())),
        "{as_text:?}"
    );
    let (st, _) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"banned_ip_ranges": ["10.0.0.0/8"]})),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(
        t.daemon.session().banned_ip_ranges().await.unwrap().len(),
        1
    );
    let (st, _) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"banned_ip_ranges": ["10.0.0.9-10.0.0.1"]})),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    // Bans land in the settings and the peer log.
    let (st, _) = t
        .post(
            "/api/v1/transfer/bans",
            json!({"peers": ["10.9.8.7:6881", "[fd00::5]:1"]}),
        )
        .await;
    assert_eq!(st, StatusCode::NO_CONTENT);
    let s = t.get("/api/v1/settings").await;
    assert_eq!(s["banned_ips"], json!(["10.9.8.7", "fd00::5"]));
    let log = t.get("/api/v1/log/peers").await;
    assert_eq!(log.as_array().unwrap().len(), 2);
    assert_eq!(log[0]["source"], "settings");
    assert_eq!(log[0]["torrent"], serde_json::Value::Null);
    assert_eq!(log[0]["banned"], true);
    t.stop().await;
}

#[tokio::test]
async fn errors_have_one_shape() {
    let t = TestDaemon::start(24, |_| {}).await;
    let (s, v) = t.call(Method::GET, "/api/v1/nope", None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(v["error"]["code"], "not_found");
    let hash = "0".repeat(40);
    let (s, v) = t
        .call(Method::GET, &format!("/api/v1/torrents/{hash}"), None)
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    assert_eq!(v["error"]["code"], "torrent_not_found");
    let (s, v) = t.call(Method::GET, "/api/v1/torrents/xyz", None).await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(v["error"]["code"], "bad_request");
    let (s, v) = t
        .call(
            Method::POST,
            "/api/v1/torrents",
            Some(json!({"urls": ["not a magnet"]})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["failed"][0]["error"]["code"], "invalid_torrent");
    let (s, _, body) = t
        .request(
            req(Method::POST, "/api/v1/torrents/start")
                .header("content-type", "application/json")
                .body(Body::from("{not json"))
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert!(String::from_utf8_lossy(&body).contains("bad_request"));
    let (s, v) = t
        .post("/api/v1/torrents/start", json!({"hashes": [hash.clone()]}))
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["not_found"], json!([hash]));
    t.stop().await;
}

#[tokio::test]
async fn openapi_document_is_served() {
    let t = TestDaemon::start(25, |s| s.api_bypass_local_auth = false).await;
    let (s, _, body) = t
        .request(
            req(Method::GET, "/api/v1/openapi.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "the schema is public");
    let doc: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(doc["openapi"], "3.1.0");
    assert!(doc["paths"]["/api/v1/torrents"]["post"].is_object());
    t.stop().await;
}

/// `POST /auth/setup` with `body`; the status and the session cookie.
async fn setup(t: &TestDaemon, body: serde_json::Value) -> (StatusCode, Option<String>) {
    let (s, headers, _) = t
        .request(
            req(Method::POST, "/api/v1/auth/setup")
                .header("content-type", "application/json")
                .body(json_body(body))
                .unwrap(),
        )
        .await;
    let cookie = headers
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string());
    (s, cookie)
}

async fn get_with(t: &TestDaemon, path: &str, cookie: &str) -> StatusCode {
    t.request(
        req(Method::GET, path)
            .header("cookie", cookie)
            .body(Body::empty())
            .unwrap(),
    )
    .await
    .0
}

async fn login(t: &TestDaemon, username: &str, password: &str) -> (StatusCode, Option<String>) {
    let (s, headers, _) = t
        .request(
            req(Method::POST, "/api/v1/auth/login")
                .header("content-type", "application/json")
                .body(json_body(
                    json!({"username": username, "password": password}),
                ))
                .unwrap(),
        )
        .await;
    let cookie = headers
        .get("set-cookie")
        .map(|v| v.to_str().unwrap().split(';').next().unwrap().to_string());
    (s, cookie)
}

#[tokio::test]
async fn first_run_setup() {
    let t = TestDaemon::start(88, |s| s.api_bypass_local_auth = false).await;
    let temp = t.daemon.temporary_password().unwrap().to_string();

    // Public: whether the daemon waits for its credentials.
    assert_eq!(
        t.get("/api/v1/auth/status").await,
        json!({"setup_required": true})
    );
    let (s, _) = t.call(Method::GET, "/api/v1/app", None).await;
    assert_eq!(s, StatusCode::UNAUTHORIZED);
    // The temporary password works until then.
    let (s, temp_cookie) = login(&t, "admin", &temp).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let temp_cookie = temp_cookie.unwrap();
    assert_eq!(
        get_with(&t, "/api/v1/app", &temp_cookie).await,
        StatusCode::OK
    );

    // Bad input changes nothing.
    for body in [
        json!({"username": "", "password": "long enough"}),
        json!({"username": "  ", "password": "long enough"}),
        json!({"username": "me", "password": "short"}),
        json!({"username": "me"}),
    ] {
        let (s, _) = setup(&t, body.clone()).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{body}");
    }
    // A web page cannot claim the daemon for its visitor's browser.
    let (s, _, body) = t
        .request(
            req(Method::POST, "/api/v1/auth/setup")
                .header("host", "127.0.0.1:8080")
                .header("origin", "http://evil.test")
                .header("content-type", "application/json")
                .body(json_body(
                    json!({"username": "evil", "password": "long enough"}),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(v["error"]["code"], "cross_origin");
    assert_eq!(t.get("/api/v1/auth/status").await["setup_required"], true);

    // Two at once: exactly one sets the credentials, and is logged in.
    let (a, b) = tokio::join!(
        setup(&t, json!({"username": "me", "password": "correct horse"})),
        setup(&t, json!({"username": "you", "password": "battery staple"})),
    );
    let ((won, cookie), (lost, _), winner, loser) = if a.0 == StatusCode::NO_CONTENT {
        (a, b, ("me", "correct horse"), ("you", "battery staple"))
    } else {
        (b, a, ("you", "battery staple"), ("me", "correct horse"))
    };
    assert_eq!(won, StatusCode::NO_CONTENT);
    assert_eq!(lost, StatusCode::CONFLICT);
    let cookie = cookie.unwrap();
    assert_eq!(get_with(&t, "/api/v1/app", &cookie).await, StatusCode::OK);
    assert_eq!(
        t.get("/api/v1/auth/status").await,
        json!({"setup_required": false})
    );

    // Setup is closed; the temporary password and its session are gone.
    let (s, _) = setup(&t, json!({"username": "late", "password": "long enough"})).await;
    assert_eq!(s, StatusCode::CONFLICT);
    assert_eq!(
        get_with(&t, "/api/v1/app", &temp_cookie).await,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(login(&t, "admin", &temp).await.0, StatusCode::UNAUTHORIZED);
    assert_eq!(
        login(&t, loser.0, loser.1).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&t, winner.0, winner.1).await.0,
        StatusCode::NO_CONTENT
    );
    let (s, _, log) = t
        .request(
            req(Method::GET, "/api/v1/log")
                .header("cookie", &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let log = String::from_utf8_lossy(&log);
    assert!(log.contains("first-run setup from 127.0.0.1"), "{log}");

    // The credentials are stored: after a restart there is no setup and no
    // temporary password.
    let dir = t.stop().await;
    let t = TestDaemon::start_in(dir, 88, None).await;
    assert!(t.daemon.temporary_password().is_none());
    assert_eq!(t.get("/api/v1/auth/status").await["setup_required"], false);
    assert_eq!(
        login(&t, winner.0, winner.1).await.0,
        StatusCode::NO_CONTENT
    );
    let (s, _) = setup(&t, json!({"username": "late", "password": "long enough"})).await;
    assert_eq!(s, StatusCode::CONFLICT);
    t.stop().await;
}

/// A login from `ua`; returns the cookie.
async fn login_as(t: &TestDaemon, password: &str, ua: &str) -> String {
    let (s, headers, _) = t
        .request(
            req(Method::POST, "/api/v1/auth/login")
                .header("content-type", "application/json")
                .header("user-agent", ua)
                .body(json_body(
                    json!({"username": "admin", "password": password}),
                ))
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    headers["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_string()
}

/// A request with a cookie; `(status, JSON body or Null)`.
async fn with_cookie(
    t: &TestDaemon,
    method: Method,
    path: &str,
    cookie: &str,
    headers: &[(&str, &str)],
) -> (StatusCode, serde_json::Value) {
    let mut b = req(method, path).header("cookie", cookie);
    for (k, v) in headers {
        b = b.header(*k, *v);
    }
    let (s, _, body) = t.request(b.body(Body::empty()).unwrap()).await;
    (
        s,
        serde_json::from_slice(&body).unwrap_or(serde_json::Value::Null),
    )
}

#[tokio::test]
async fn sessions_bans_the_key_and_how_a_request_is_seen() {
    let t = TestDaemon::start(26, |s| {
        s.api_bypass_local_auth = false;
        s.api_max_auth_failures = 2;
        s.api_allowed_hosts = vec!["localhost".into(), "torrents.example".into()];
    })
    .await;
    let temp = t.daemon.temporary_password().unwrap().to_string();
    let a = login_as(&t, &temp, "Firefox/140").await;
    let b = login_as(&t, &temp, "curl/8.9").await;

    // Listed by an id that is not the cookie, this one marked.
    let (s, list) = with_cookie(&t, Method::GET, "/api/v1/auth/sessions", &a, &[]).await;
    assert_eq!(s, StatusCode::OK, "{list}");
    let list = list.as_array().unwrap().clone();
    assert_eq!(list.len(), 2);
    let text = serde_json::to_string(&list).unwrap();
    for c in [&a, &b] {
        assert!(!text.contains(c.split('=').nth(1).unwrap()), "{text}");
    }
    let me = list.iter().find(|x| x["current"] == true).unwrap();
    assert_eq!(me["last_used"]["user_agent"], "Firefox/140");
    assert_eq!(me["last_used"]["address"], "127.0.0.1");
    let other = list.iter().find(|x| x["current"] == false).unwrap();
    assert_eq!(other["last_used"]["user_agent"], "curl/8.9");

    // Ended by id; then every other one.
    let id = other["id"].as_str().unwrap();
    let path = format!("/api/v1/auth/sessions/{id}");
    assert_eq!(
        with_cookie(&t, Method::DELETE, &path, &a, &[]).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        with_cookie(&t, Method::DELETE, &path, &a, &[]).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        with_cookie(&t, Method::GET, "/api/v1/app", &b, &[]).await.0,
        StatusCode::UNAUTHORIZED
    );
    let c = login_as(&t, &temp, "Safari").await;
    assert_eq!(
        with_cookie(&t, Method::DELETE, "/api/v1/auth/sessions", &a, &[])
            .await
            .0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        with_cookie(&t, Method::GET, "/api/v1/app", &c, &[]).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        with_cookie(&t, Method::GET, "/api/v1/app", &a, &[]).await.0,
        StatusCode::OK
    );

    // The account: no key, then one made now, then its use.
    let (_, acc) = with_cookie(&t, Method::GET, "/api/v1/auth/account", &a, &[]).await;
    assert_eq!(acc, json!({"username": "admin", "api_key": null}));
    let (s, key) = with_cookie(&t, Method::POST, "/api/v1/auth/api-key", &a, &[]).await;
    assert_eq!(s, StatusCode::OK);
    let key = key["api_key"].as_str().unwrap().to_string();
    let (_, acc) = with_cookie(&t, Method::GET, "/api/v1/auth/account", &a, &[]).await;
    assert!(acc["api_key"]["created"].as_u64().unwrap() + 60 > urtorrentd::util::now());
    assert_eq!(acc["api_key"]["last_used"], serde_json::Value::Null);
    let bearer = format!("Bearer {key}");
    let (s, _, _) = t
        .request(
            req(Method::GET, "/api/v1/torrents")
                .header("authorization", &bearer)
                .header("user-agent", "python-requests/2.32")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (_, acc) = with_cookie(&t, Method::GET, "/api/v1/auth/account", &a, &[]).await;
    assert_eq!(
        acc["api_key"]["last_used"]["user_agent"],
        "python-requests/2.32"
    );
    assert_eq!(acc["api_key"]["last_used"]["address"], "127.0.0.1");

    // How requests are seen: a session from this page's origin...
    let (s, v) = with_cookie(
        &t,
        Method::POST,
        "/api/v1/auth/check",
        &a,
        &[
            ("host", "127.0.0.1:8080"),
            ("origin", "http://127.0.0.1:8080"),
        ],
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(
        v,
        json!({"peer": "127.0.0.1", "client": "127.0.0.1", "proxy": "none",
               "host": "127.0.0.1:8080", "host_check": "address", "https": false,
               "auth": "session", "csrf": "same_origin"})
    );
    // ...refused from another...
    let (s, v) = with_cookie(
        &t,
        Method::POST,
        "/api/v1/auth/check",
        &a,
        &[("host", "127.0.0.1:8080"), ("origin", "http://evil.test")],
    )
    .await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert_eq!(v["error"]["code"], "cross_origin");
    // ...the key, never checked for its origin...
    let (s, _, body) = t
        .request(
            req(Method::POST, "/api/v1/auth/check")
                .header("authorization", &bearer)
                .header("host", "localhost:8080")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let v: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(
        (&v["auth"], &v["csrf"], &v["host_check"]),
        (&json!("api_key"), &json!("not_applied"), &json!("allowed"))
    );
    // ...forwarding headers from a peer that is not trusted...
    let (_, v) = with_cookie(
        &t,
        Method::POST,
        "/api/v1/auth/check",
        &a,
        &[("x-forwarded-for", "203.0.113.9")],
    )
    .await;
    assert_eq!(
        (&v["proxy"], &v["client"], &v["csrf"]),
        (
            &json!("untrusted"),
            &json!("127.0.0.1"),
            &json!("no_origin")
        )
    );

    // ...and through a trusted proxy.
    let (s, _, body) = t
        .request(
            req(Method::PATCH, "/api/v1/settings")
                .header("cookie", &a)
                .header("content-type", "application/json")
                .body(json_body(json!({"api_trusted_proxies": ["127.0.0.1"]})))
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    let proxied = [
        ("x-forwarded-for", "198.51.100.7"),
        ("x-forwarded-host", "torrents.example"),
        ("x-forwarded-proto", "https"),
        ("origin", "https://torrents.example"),
    ];
    let (s, v) = with_cookie(&t, Method::POST, "/api/v1/auth/check", &a, &proxied).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(
        v,
        json!({"peer": "127.0.0.1", "client": "198.51.100.7", "proxy": "trusted",
               "host": "torrents.example", "host_check": "allowed", "https": true,
               "auth": "session", "csrf": "same_origin"})
    );

    // Failed logins from an address, its ban, and lifting it.
    let fail = |ua: &'static str| {
        req(Method::POST, "/api/v1/auth/login")
            .header("content-type", "application/json")
            .header("x-forwarded-for", "203.0.113.99")
            .header("user-agent", ua)
            .body(json_body(json!({"username": "admin", "password": "nope"})))
            .unwrap()
    };
    assert_eq!(
        t.request(fail("curl/8.9")).await.0,
        StatusCode::UNAUTHORIZED
    );
    let (_, bans) = with_cookie(&t, Method::GET, "/api/v1/auth/bans", &a, &[]).await;
    assert_eq!(bans[0]["address"], "203.0.113.99");
    assert_eq!(bans[0]["failures"], 1);
    assert_eq!(bans[0]["banned_until"], serde_json::Value::Null);
    assert_eq!(
        t.request(fail("curl/8.10")).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(t.request(fail("curl/8.10")).await.0, StatusCode::FORBIDDEN);
    let (_, bans) = with_cookie(&t, Method::GET, "/api/v1/auth/bans", &a, &[]).await;
    assert_eq!(bans.as_array().unwrap().len(), 1, "{bans}");
    assert_eq!(bans[0]["failures"], 2);
    assert_eq!(bans[0]["user_agent"], "curl/8.10");
    assert!(bans[0]["banned_until"].as_u64().unwrap() > urtorrentd::util::now());
    let unban = "/api/v1/auth/bans/203.0.113.99";
    assert_eq!(
        with_cookie(&t, Method::DELETE, unban, &a, &[]).await.0,
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        with_cookie(&t, Method::DELETE, unban, &a, &[]).await.0,
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        with_cookie(&t, Method::DELETE, "/api/v1/auth/bans/nonsense", &a, &[])
            .await
            .0,
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        t.request(fail("curl/8.10")).await.0,
        StatusCode::UNAUTHORIZED
    );
    t.stop().await;
}

#[tokio::test]
async fn clients_without_login_still_need_the_pages_origin() {
    // Loopback needs no login (the test default): a page on another origin
    // still cannot change anything through the visitor's browser.
    let t = TestDaemon::start(27, |s| {
        s.api_auth_whitelist = vec!["127.0.0.0/8".into()];
    })
    .await;
    let tag = |origin: Option<&str>| {
        let mut b = req(Method::POST, "/api/v1/tags")
            .header("host", "127.0.0.1:8080")
            .header("content-type", "application/json");
        if let Some(o) = origin {
            b = b.header("origin", o);
        }
        b.body(json_body(json!({"tags": ["x"]}))).unwrap()
    };
    let (s, _, body) = t.request(tag(Some("http://evil.test"))).await;
    assert_eq!(s, StatusCode::FORBIDDEN);
    assert!(String::from_utf8_lossy(&body).contains("cross_origin"));
    assert_eq!(t.request(tag(None)).await.0, StatusCode::NO_CONTENT);
    assert_eq!(
        t.request(tag(Some("http://127.0.0.1:8080"))).await.0,
        StatusCode::NO_CONTENT
    );
    // Reads are never refused for their origin.
    let (s, _, _) = t
        .request(
            req(Method::GET, "/api/v1/tags")
                .header("origin", "http://evil.test")
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, v) = t.post("/api/v1/auth/check", json!(null)).await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(
        (&v["auth"], &v["csrf"]),
        (&json!("whitelist"), &json!("no_origin"))
    );
    let (s, _) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"api_auth_whitelist": []})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (_, v) = t.post("/api/v1/auth/check", json!(null)).await;
    assert_eq!(v["auth"], "loopback");
    // Unchecked when the setting is off.
    let (s, _) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"api_csrf_protection": false})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        t.request(tag(Some("http://evil.test"))).await.0,
        StatusCode::NO_CONTENT
    );
    let (_, v) = t.post("/api/v1/auth/check", json!(null)).await;
    assert_eq!(v["csrf"], "off");
    t.stop().await;
}
