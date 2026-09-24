// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Metadata previews (qBittorrent's `fetchMetadata` / `saveMetadata`): a
//! magnet's metadata fetched from a peer without adding the torrent, a URL's
//! `.torrent`, the preview as a file, and an add that uses it.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use common::{TestDaemon, fixture};
use serde_json::{Value, json};

async fn wait_get(t: &TestDaemon, path: &str, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        let v = t.get(path).await;
        if pred(&v) {
            return v;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}: {v}"
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn a_magnet_is_previewed_then_added_without_a_second_fetch() {
    let seeder = TestDaemon::start(70, |_| {}).await;
    let client = TestDaemon::start(71, |_| {}).await;
    let f = fixture(
        "album",
        &[("01.flac", 90_000), ("02.flac", 60_000)],
        16_384,
        None,
        false,
        61,
    );
    f.write_to(&seeder.save_path());
    let hash = seeder.add(&f, json!({})).await;
    seeder
        .wait_for(&hash, "seeding", 30, |x| x["state"] == "seeding")
        .await;

    // The preview asks the seeder (x.pe) for the metadata.
    let magnet = format!(
        "magnet:?xt=urn:btih:{hash}&dn=preview&x.pe={}",
        seeder.peer_addr()
    );
    let (s, v) = client
        .post("/api/v1/previews", json!({"source": magnet}))
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["hash"], hash.as_str());
    assert!(v["expires"].as_u64() > v["created"].as_u64());
    let path = format!("/api/v1/previews/{hash}");
    let v = wait_get(&client, &path, "the metadata", |v| v["state"] == "ready").await;
    assert_eq!(v["name"], "album", "{v}");
    assert_eq!(v["peers"], Value::Null);
    let files: Vec<&str> = v["metadata"]["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect();
    assert_eq!(files, ["album/01.flac", "album/02.flac"]);
    assert_eq!(v["metadata"]["total_size"], 150_000);

    // Not a torrent of the session.
    assert_eq!(client.get("/api/v1/torrents").await, json!([]));
    assert_eq!(client.get("/api/v1/sync").await["torrents"], json!({}));
    assert_eq!(
        client
            .get("/api/v1/previews")
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // The preview as a `.torrent`.
    let (s, _, bytes) = client
        .request(
            axum::http::Request::get(format!("{path}/torrent-file"))
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, parsed) = client
        .post(
            "/api/v1/torrents/parse",
            json!({"torrent": base64_of(&bytes)}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{parsed}");
    assert_eq!(parsed["hash"], hash.as_str());

    // Adding the info-hash uses the preview: the metadata is there at once.
    let (s, v) = client
        .post(
            "/api/v1/torrents",
            json!({"urls": [hash.clone()], "options": {"category": "music"}}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["added"][0]["name"], "album", "{v}");
    let t = client.torrent(&hash).await;
    assert_eq!(t["has_metadata"], true, "{t}");
    assert_eq!(t["size"], 150_000);
    let (s, _) = client.call(Method::GET, &path, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND, "the preview is used up");
    let (s, _) = client
        .post(
            "/api/v1/torrents/peers",
            json!({"hashes": [hash.clone()], "peers": [seeder.peer_addr()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    client
        .wait_for(&hash, "download", 60, |x| x["complete"] == true)
        .await;

    // A torrent of the session is not previewed.
    let (s, v) = client
        .post("/api/v1/previews", json!({"source": hash}))
        .await;
    assert_eq!(s, StatusCode::CONFLICT, "{v}");
    assert_eq!(v["error"]["code"], "duplicate");
    let (s, _) = client
        .post("/api/v1/previews", json!({"source": "not a torrent"}))
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    client.stop().await;
    seeder.stop().await;
}

fn base64_of(b: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(b)
}

#[tokio::test]
async fn a_url_is_previewed_and_dropped() {
    let t = TestDaemon::start(72, |_| {}).await;
    let f = fixture("page.iso", &[("page.iso", 40_000)], 16_384, None, false, 62);
    let torrent = f.torrent.clone();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new().route(
        "/t.torrent",
        axum::routing::get(move || {
            let body = torrent.clone();
            async move { body }
        }),
    );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let (s, v) = t
        .post(
            "/api/v1/previews",
            json!({"source": format!("http://{addr}/t.torrent")}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["state"], "ready", "a URL is ready at once: {v}");
    assert_eq!(v["metadata"]["name"], "page.iso");
    let path = format!("/api/v1/previews/{}", f.hash);
    let (s, _) = t.call(Method::DELETE, &path, None).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, v) = t.call(Method::GET, &path, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{v}");
    let (s, _) = t.call(Method::DELETE, &path, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    t.stop().await;
}
