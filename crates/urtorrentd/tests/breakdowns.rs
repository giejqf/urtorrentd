// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Statistics breakdowns (0.7.0) on real engines: peer traffic by client,
//! source, transport, encryption, IP version and direction; traffic by
//! category, tag and tracker with the trackers' announces; completed
//! downloads from scrapes; the idle-seed report; tracker hosts now, with
//! trackers added and removed in bulk. A local HTTP tracker answers
//! announces and scrapes.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::net::SocketAddr;
use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use common::{TestDaemon, fixture};
use serde_json::{Value, json};

/// A tracker that knows one torrent: announces get an empty peer list and a
/// swarm of 3 seeds and 2 leechers, scrapes 5 seeds, 3 leechers and 42
/// completed downloads.
async fn tracker(info_hash: [u8; 20]) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let mut scrape = b"d5:filesd20:".to_vec();
    scrape.extend(info_hash);
    scrape.extend(b"d8:completei5e10:downloadedi42e10:incompletei3eeee");
    let app = axum::Router::new()
        .route(
            "/announce",
            axum::routing::get(|| async {
                b"d8:completei3e10:incompletei2e8:intervali1800e5:peers0:e".to_vec()
            }),
        )
        .route(
            "/scrape",
            axum::routing::get(move || {
                let body = scrape.clone();
                async move { body }
            }),
        );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    addr
}

fn unhex(h: &str) -> [u8; 20] {
    let mut out = [0u8; 20];
    for (i, b) in out.iter_mut().enumerate() {
        *b = u8::from_str_radix(&h[2 * i..2 * i + 2], 16).unwrap();
    }
    out
}

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
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn row<'a>(v: &'a Value, field: &str, key: &str) -> Option<&'a Value> {
    v["rows"]
        .as_array()
        .unwrap()
        .iter()
        .find(|r| r[field] == key)
}

#[tokio::test]
async fn traffic_broken_down_by_peer_group_and_tracker() {
    let seeder = TestDaemon::start(68, |s| s.stats_scrape_interval = Some(1800)).await;
    let leecher = TestDaemon::start(69, |_| {}).await;
    // The tracker must know the info-hash before the torrent exists: make
    // the fixture once to learn it, then again with the tracker's URL.
    let probe = fixture(
        "shared.iso",
        &[("shared.iso", 600_000)],
        16_384,
        None,
        false,
        51,
    );
    let t = tracker(unhex(&probe.hash)).await;
    let announce = format!("http://{t}/announce");
    let f = fixture(
        "shared.iso",
        &[("shared.iso", 600_000)],
        16_384,
        Some(&announce),
        false,
        51,
    );
    assert_eq!(
        f.hash, probe.hash,
        "the announce URL is not in the info dict"
    );
    f.write_to(&seeder.save_path());
    let idle = fixture(
        "idle.bin",
        &[("idle.bin", 200_000)],
        16_384,
        Some("http://localhost:1/announce"),
        false,
        52,
    );
    idle.write_to(&seeder.save_path());
    let hash = seeder
        .add(&f, json!({"category": "linux", "tags": ["iso", "big"]}))
        .await;
    let idle_hash = seeder.add(&idle, json!({})).await;
    for h in [&hash, &idle_hash] {
        seeder
            .wait_for(h, "seeding", 30, |x| x["state"] == "seeding")
            .await;
    }
    leecher.add(&f, json!({})).await;
    let (s, _) = leecher
        .post(
            "/api/v1/torrents/peers",
            json!({"hashes": [hash.clone()], "peers": [seeder.peer_addr()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    leecher
        .wait_for(&hash, "download", 60, |x| x["complete"] == true)
        .await;
    let up = seeder
        .wait_for(&hash, "upload counted", 30, |x| {
            x["uploaded"].as_u64().unwrap() >= 600_000
        })
        .await["uploaded"]
        .as_u64()
        .unwrap();

    // The torrent's own traffic first (the tick records it every 2 s; a
    // closed connection's bytes are attributed at once).
    wait_get(
        &seeder,
        &format!("/api/v1/stats/torrents/{hash}/traffic?step=hour"),
        "the torrent's traffic",
        |v| {
            v["points"]
                .as_array()
                .unwrap()
                .iter()
                .map(|p| p["uploaded"].as_u64().unwrap())
                .sum::<u64>()
                == up
        },
    )
    .await;

    // Peers: one connection, so one value per dimension, holding it all.
    let peers = |dim: &str| format!("/api/v1/stats/peers?dim={dim}&hash={hash}&series=true");
    let v = wait_get(&seeder, &peers("transport"), "attributed upload", |v| {
        v["rows"][0]["uploaded"].as_u64() == Some(up)
    })
    .await;
    assert_eq!(v["rows"][0]["key"], "tcp", "{v}");
    assert_eq!(v["unattributed"]["uploaded"], 0);
    assert_eq!(v["points"][0]["key"], "tcp");
    for (dim, key) in [
        ("direction", Some("incoming")),
        ("source", Some("incoming")),
        ("ip_version", Some("ipv4")),
        ("encryption", None),
        ("client", None),
    ] {
        let v = seeder.get(&peers(dim)).await;
        let rows = v["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 1, "{dim}: {v}");
        assert_eq!(rows[0]["uploaded"].as_u64(), Some(up), "{dim}: {v}");
        match key {
            Some(k) => assert_eq!(rows[0]["key"], k, "{dim}: {v}"),
            None => assert!(
                rows[0]["key"].as_str().is_some_and(|k| !k.is_empty()),
                "{dim}: {v}"
            ),
        }
    }

    // Categories and tags.
    let v = seeder.get("/api/v1/stats/groups?group=category").await;
    assert_eq!(v["rows"][0]["key"], "linux", "{v}");
    assert_eq!(v["rows"][0]["uploaded"].as_u64(), Some(up));
    assert_eq!(v["rows"][0]["torrents"], 1);
    let v = seeder
        .get("/api/v1/stats/groups?group=tag&step=day&series=true")
        .await;
    for tag in ["iso", "big"] {
        assert_eq!(
            row(&v, "key", tag).unwrap()["uploaded"].as_u64(),
            Some(up),
            "{v}"
        );
    }
    assert_eq!(v["points"].as_array().unwrap().len(), 2, "{v}");

    // Trackers: traffic by the one that works, announces of both.
    let v = wait_get(&seeder, "/api/v1/stats/trackers", "announces", |v| {
        row(v, "host", "127.0.0.1").is_some_and(|r| r["announces"].as_u64() >= Some(1))
            && row(v, "host", "localhost").is_some_and(|r| r["announce_errors"].as_u64() >= Some(1))
    })
    .await;
    let working = row(&v, "host", "127.0.0.1").unwrap();
    assert_eq!(working["uploaded"].as_u64(), Some(up), "{v}");
    assert_eq!(working["announce_errors"], 0);
    assert_eq!(working["torrents"], 1);
    assert_eq!(row(&v, "host", "localhost").unwrap()["uploaded"], 0);
    assert!(!v.to_string().contains("/announce"), "hosts only: {v}");

    // The same per bucket: the upload, and the announces answered and failed.
    let v = seeder
        .get("/api/v1/stats/trackers?step=hour&series=true")
        .await;
    let sum = |host: &str, field: &str| {
        v["points"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|p| p["host"] == host)
            .map(|p| p[field].as_u64().unwrap())
            .sum::<u64>()
    };
    let working = row(&v, "host", "127.0.0.1").unwrap();
    assert_eq!(sum("127.0.0.1", "uploaded"), up, "{v}");
    assert_eq!(
        Some(sum("127.0.0.1", "announces")),
        working["announces"].as_u64()
    );
    assert!(sum("localhost", "announce_errors") >= 1, "{v}");
    assert_eq!(sum("localhost", "uploaded"), 0);

    // Now, by host: who works with which tracker, and what fails.
    let v = wait_get(
        &seeder,
        "/api/v1/torrents/trackers",
        "a failing tracker",
        |v| {
            v.as_array()
                .unwrap()
                .iter()
                .any(|h| h["host"] == "localhost" && h["failing"] == json!([idle_hash]))
        },
    )
    .await;
    let host = |v: &Value, name: &str| {
        v.as_array()
            .unwrap()
            .iter()
            .find(|h| h["host"] == name)
            .cloned()
    };
    let ok = host(&v, "127.0.0.1").unwrap();
    assert_eq!(
        (&ok["torrents"], &ok["private"], &ok["working"]),
        (&json!(1), &json!(0), &json!(1)),
        "{v}"
    );
    assert_eq!(ok["failing"], json!([]));
    assert_eq!(ok["error"], Value::Null);
    let bad = host(&v, "localhost").unwrap();
    assert_eq!(bad["working"], 0);
    assert!(bad["fails"].as_u64() >= Some(1), "{v}");
    assert!(bad["error"].as_str().is_some_and(|e| !e.is_empty()), "{v}");
    assert!(bad["failing_since"].as_u64() <= bad["last_failure"].as_u64());
    assert!(!v.to_string().contains("/announce"), "hosts only: {v}");

    // In bulk: the failing host removed, the working tracker added.
    let (s, r) = seeder
        .post(
            "/api/v1/torrents/trackers/remove",
            json!({"hashes": [idle_hash.clone()], "hosts": ["LOCALHOST"]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["applied"], json!([idle_hash.clone()]));
    let (s, r) = seeder
        .post(
            "/api/v1/torrents/trackers",
            json!({"hashes": "all", "urls": [announce.clone()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["applied"].as_array().unwrap().len(), 2, "{r}");
    let (s, _) = seeder
        .post(
            "/api/v1/torrents/reannounce",
            json!({"hashes": [idle_hash.clone()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let v = wait_get(
        &seeder,
        "/api/v1/torrents/trackers",
        "both torrents on the working tracker",
        |v| host(v, "127.0.0.1").is_some_and(|h| h["working"] == 2),
    )
    .await;
    assert_eq!(
        v.as_array().unwrap().len(),
        1,
        "the other host is gone: {v}"
    );
    assert_eq!(host(&v, "127.0.0.1").unwrap()["torrents"], 2);
    for (path, body) in [
        (
            "/api/v1/torrents/trackers",
            json!({"hashes": "all", "urls": ["ftp://tracker.example/announce"]}),
        ),
        (
            "/api/v1/torrents/trackers",
            json!({"hashes": "all", "urls": []}),
        ),
        (
            "/api/v1/torrents/trackers/remove",
            json!({"hashes": "all", "hosts": [" "]}),
        ),
    ] {
        let (s, v) = seeder.post(path, body).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{path}: {v}");
    }

    // The scrape's completed downloads, and the swarm at its largest.
    let days = wait_get(
        &seeder,
        &format!("/api/v1/stats/torrents/{hash}/days"),
        "a scrape",
        |v| v["days"][0]["swarm_completed_max"] == 42,
    )
    .await;
    assert_eq!(days["days"][0]["swarm_seeds_max"], 5, "{days}");
    assert_eq!(days["days"][0]["swarm_leechers_max"], 3);

    // Idle seeds: the one that shared nothing comes first.
    let v = seeder.get("/api/v1/stats/idle-seeds?days=7").await;
    let t = v["torrents"].as_array().unwrap();
    assert_eq!(t.len(), 2, "{v}");
    assert_eq!(t[0]["hash"], idle_hash.as_str());
    assert_eq!(t[0]["uploaded"], 0);
    assert_eq!(t[0]["value"], 0.0);
    assert_eq!(t[1]["hash"], hash.as_str());
    assert_eq!(t[1]["uploaded"].as_u64(), Some(up));
    assert!(t[1]["value"].as_f64().unwrap() >= 1.0);
    assert_eq!(t[1]["category"], "linux");
    assert_eq!(t[1]["tracker"], "127.0.0.1");
    assert!(v["recorded_from"].as_u64() >= v["from"].as_u64());

    // Refused.
    for bad in [
        "/api/v1/stats/peers",
        "/api/v1/stats/peers?dim=city",
        "/api/v1/stats/groups?group=owner",
        "/api/v1/stats/trackers?step=minute",
        "/api/v1/stats/idle-seeds?days=0",
    ] {
        let (s, v) = seeder.call(Method::GET, bad, None).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{bad}: {v}");
    }
    let (s, _) = seeder
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"stats_scrape_interval": 60})),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    leecher.stop().await;
    seeder.stop().await;
}
