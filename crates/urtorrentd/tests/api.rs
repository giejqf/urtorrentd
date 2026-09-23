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
