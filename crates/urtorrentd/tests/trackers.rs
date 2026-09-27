// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Reannouncing to one tracker, or to the trackers on some hosts, alone
//! (urtorrent 0.14): two local trackers in one tier on two loopback hosts,
//! where the tier rules leave the second idle while the first works.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use common::{TestDaemon, fixture};
use serde_json::{Value, json};

/// A tracker on `ip` that counts its announces and asks for 30 minutes.
async fn tracker(ip: &str) -> (String, Arc<AtomicUsize>) {
    let listener = tokio::net::TcpListener::bind((ip, 0)).await.unwrap();
    let addr = listener.local_addr().unwrap();
    let count = Arc::new(AtomicUsize::new(0));
    let c = count.clone();
    let app = axum::Router::new().route(
        "/announce",
        axum::routing::get(move || {
            c.fetch_add(1, Ordering::SeqCst);
            async { b"d8:intervali1800e5:peers0:e".to_vec() }
        }),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    (format!("http://{addr}/announce"), count)
}

async fn until(what: &str, pred: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while !pred() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[tokio::test]
async fn one_tracker_or_one_host_is_reannounced_alone() {
    let t = TestDaemon::start(99, |_| {}).await;
    let (a, ca) = tracker("127.0.0.1").await;
    let (b, cb) = tracker("127.0.0.2").await;
    let f = fixture(
        "tiers.bin",
        &[("tiers.bin", 40_000)],
        16_384,
        Some(&a),
        false,
        99,
    );
    let h = t.add(&f, json!({})).await;
    let (s, v) = t
        .post(
            &format!("/api/v1/torrents/{h}/trackers"),
            json!({"urls": [b.clone()], "tier": 0}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT, "{v}");
    until("the first announce", || ca.load(Ordering::SeqCst) >= 1).await;
    // b shares a's tier and a works: b is left idle.
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(cb.load(Ordering::SeqCst), 0);

    // b alone, by URL.
    let (s, v) = t
        .post(
            &format!("/api/v1/torrents/{h}/trackers/reannounce"),
            json!({"urls": [b.clone()]}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT, "{v}");
    until("b's announce", || cb.load(Ordering::SeqCst) >= 1).await;
    assert_eq!(ca.load(Ordering::SeqCst), 1, "a is left alone");

    // a alone, by host.
    let (s, v) = t
        .post(
            "/api/v1/torrents/trackers/reannounce",
            json!({"hashes": "all", "hosts": ["127.0.0.1"]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["applied"], json!([h.clone()]));
    until("a's second announce", || ca.load(Ordering::SeqCst) >= 2).await;
    assert_eq!(cb.load(Ordering::SeqCst), 1, "b is left alone");

    // Both hosts' replies: the interval asked for, and how fast.
    let hosts = t.get("/api/v1/torrents/trackers").await;
    for name in ["127.0.0.1", "127.0.0.2"] {
        let row = hosts
            .as_array()
            .unwrap()
            .iter()
            .find(|r| r["host"] == name)
            .cloned()
            .unwrap_or(Value::Null);
        assert_eq!(row["interval"], 1800, "{hosts}");
        assert!(
            row["response_time"].as_f64().is_some_and(|x| x < 5.0),
            "{hosts}"
        );
    }
    // Not checking: nothing checked.
    assert_eq!(t.torrent(&h).await["pieces_checked"], 0);

    // A tracker the torrent does not have, and empty requests.
    let (s, v) = t
        .post(
            &format!("/api/v1/torrents/{h}/trackers/reannounce"),
            json!({"urls": ["http://127.0.0.1:1/announce"]}),
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{v}");
    let (s, v) = t
        .post(
            &format!("/api/v1/torrents/{h}/trackers/reannounce"),
            json!({"urls": []}),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    let (s, v) = t
        .post(
            "/api/v1/torrents/trackers/reannounce",
            json!({"hashes": "all", "hosts": [" "]}),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    t.stop().await;
}
