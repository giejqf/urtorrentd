// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The alternative-limits scheduler and watch folders, driven through the
//! API on a real daemon.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::path::Path;
use std::time::{Duration, Instant, SystemTime};

use axum::http::{Method, StatusCode};
use common::{TestDaemon, fixture};
use serde_json::{Value, json};

async fn wait_get(t: &TestDaemon, path: &str, what: &str, pred: impl Fn(&Value) -> bool) -> Value {
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        let v = t.get(path).await;
        if pred(&v) {
            return v;
        }
        assert!(
            Instant::now() < deadline,
            "timed out waiting for {what}: {v}"
        );
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

async fn wait_path(p: &Path, exists: bool, what: &str) {
    let deadline = Instant::now() + Duration::from_secs(20);
    while p.exists() != exists {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// `HH:MM` in UTC, `minutes` from now.
fn hhmm(minutes: i64) -> String {
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64;
    let m = (now / 60 + minutes).rem_euclid(24 * 60);
    format!("{:02}:{:02}", m / 60, m % 60)
}

async fn patch(t: &TestDaemon, body: Value) -> (StatusCode, Value) {
    t.call(Method::PATCH, "/api/v1/settings", Some(body)).await
}

#[tokio::test]
async fn the_scheduler_switches_the_alternative_limits() {
    let t = TestDaemon::start(75, |_| {}).await;
    // A window open now: the limits go on at the first look.
    let (s, v) = patch(
        &t,
        json!({"alt_speed_schedule": {"from": hhmm(-1), "to": hhmm(3), "time_zone": "UTC"}}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let v = wait_get(&t, "/api/v1/transfer", "the window", |v| {
        v["alt_speed_enabled"] == true
    })
    .await;
    assert_eq!(
        v["download_limit"],
        10 * 1024 * 1024,
        "the alternative limits are in force"
    );
    assert!(
        t.get("/api/v1/log")
            .await
            .to_string()
            .contains("(schedule)")
    );

    // Switched off by hand, it stays off until the next boundary.
    let (s, _) = t
        .call(
            Method::PUT,
            "/api/v1/transfer/alt-speed",
            Some(json!({"enabled": false})),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    tokio::time::sleep(Duration::from_secs(5)).await;
    assert_eq!(t.get("/api/v1/transfer").await["alt_speed_enabled"], false);

    // A new schedule is applied at once: this window is closed now.
    let (s, _) = t
        .call(
            Method::PUT,
            "/api/v1/transfer/alt-speed",
            Some(json!({"enabled": true})),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = patch(
        &t,
        json!({"alt_speed_schedule": {"from": hhmm(60), "to": hhmm(120), "time_zone": "UTC", "days": []}}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    wait_get(&t, "/api/v1/transfer", "the closed window", |v| {
        v["alt_speed_enabled"] == false
    })
    .await;

    for bad in [
        json!({"from": "25:00", "to": "06:00"}),
        json!({"from": "06:00", "to": "06:00"}),
        json!({"from": "06:00", "to": "07:00", "time_zone": "Nowhere/Land"}),
        json!({"from": "06:00", "to": "07:00", "days": ["funday"]}),
    ] {
        let (s, v) = patch(&t, json!({ "alt_speed_schedule": bad })).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    }
    let (s, _) = patch(&t, json!({"alt_speed_schedule": null})).await;
    assert_eq!(s, StatusCode::OK);
    t.stop().await;
}

/// Write a file that looks settled (last changed 10 s ago).
fn drop_file(path: &Path, bytes: &[u8]) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, bytes).unwrap();
    std::fs::File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_modified(SystemTime::now() - Duration::from_secs(10))
        .unwrap();
}

#[tokio::test]
async fn watch_folders_add_what_is_dropped_in_them() {
    let t = TestDaemon::start(76, |_| {}).await;
    let dirs = tempfile::tempdir().unwrap();
    let (a, b) = (dirs.path().join("a"), dirs.path().join("b"));
    std::fs::create_dir_all(&a).unwrap();
    std::fs::create_dir_all(&b).unwrap();
    let (s, v) = patch(
        &t,
        json!({"watch_folders": [
            {"path": a, "options": {"category": "watched", "stopped": true}},
            {"path": b, "recursive": true, "after_add": "delete", "options": {"stopped": true}},
        ]}),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");

    // A `.torrent`: added with the folder's options, the file renamed.
    let f = fixture(
        "dropped.iso",
        &[("dropped.iso", 50_000)],
        16_384,
        None,
        false,
        81,
    );
    drop_file(&a.join("dropped.torrent"), &f.torrent);
    wait_path(&a.join("dropped.torrent.added"), true, "the rename").await;
    assert!(!a.join("dropped.torrent").exists());
    let x = t.torrent(&f.hash).await;
    assert_eq!(x["category"], "watched", "{x}");
    assert_eq!(x["state"], "stopped");

    // A `.magnet` file.
    let magnet = "magnet:?xt=urn:btih:5555555555555555555555555555555555555555&dn=linked";
    drop_file(&a.join("linked.magnet"), format!("{magnet}\n").as_bytes());
    wait_path(&a.join("linked.magnet.added"), true, "the magnet").await;
    assert_eq!(
        t.torrent("5555555555555555555555555555555555555555").await["name"],
        "linked"
    );

    // Not a torrent: rejected and said why; the same torrent again: already there.
    drop_file(&a.join("broken.torrent"), b"not bencode");
    wait_path(&a.join("broken.torrent.rejected"), true, "the rejection").await;
    drop_file(&a.join("again.torrent"), &f.torrent);
    wait_path(&a.join("again.torrent.added"), true, "the duplicate").await;
    let log = t.get("/api/v1/log").await.to_string();
    assert!(log.contains("broken.torrent could not be added"), "{log}");
    assert!(log.contains("already added"), "{log}");

    // Subfolders of a recursive folder; deleted once added.
    let g = fixture("deep.iso", &[("deep.iso", 30_000)], 16_384, None, false, 82);
    drop_file(&b.join("x/y/deep.torrent"), &g.torrent);
    wait_path(&b.join("x/y/deep.torrent"), false, "the deletion").await;
    assert!(!b.join("x/y/deep.torrent.added").exists());
    assert_eq!(t.torrent(&g.hash).await["state"], "stopped");

    // A file still being written is left alone for a while.
    let h = fixture(
        "fresh.iso",
        &[("fresh.iso", 20_000)],
        16_384,
        None,
        false,
        83,
    );
    std::fs::write(a.join("fresh.torrent"), &h.torrent).unwrap();
    tokio::time::sleep(Duration::from_millis(1500)).await;
    assert!(a.join("fresh.torrent").exists(), "not settled yet");
    wait_path(&a.join("fresh.torrent.added"), true, "the settled file").await;

    // A folder that is not there is logged, not fatal.
    let gone = dirs.path().join("gone");
    let (s, _) = patch(&t, json!({"watch_folders": [{"path": gone}]})).await;
    assert_eq!(s, StatusCode::OK);
    wait_get(&t, "/api/v1/log", "the folder error", |v| {
        v.to_string().contains("watch folder")
    })
    .await;
    for bad in [
        json!([{"path": "relative/dir"}]),
        json!([{"path": "/w"}, {"path": "/w"}]),
        json!([{"path": "/w", "options": {"file_priorities": [9]}}]),
        json!([{"path": "/w", "command": "rm"}]),
    ] {
        let (s, v) = patch(&t, json!({ "watch_folders": bad })).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    }
    t.stop().await;
}
