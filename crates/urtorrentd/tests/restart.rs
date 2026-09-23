// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Persistence (AGENTS.md 4.8): state survives a graceful restart in
//! process, and the real binary comes back after `kill -9`.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use common::{TestDaemon, fixture};
use serde_json::{Value, json};

#[tokio::test]
async fn graceful_restart_restores_everything() {
    let t = TestDaemon::start(41, |_| {}).await;
    let seeded = fixture(
        "seeded",
        &[("a", 50_000), ("b", 30_000)],
        16_384,
        None,
        false,
        11,
    );
    seeded.write_to(&t.save_path());
    let parked = fixture(
        "parked.iso",
        &[("parked.iso", 40_000)],
        16_384,
        None,
        false,
        12,
    );
    let gone = fixture("gone.iso", &[("gone.iso", 40_000)], 16_384, None, false, 13);

    let h_seed = t.add(&seeded, json!({"tags": ["keep"]})).await;
    t.wait_for(&h_seed, "seeding", 30, |x| x["state"] == "seeding")
        .await;
    let h_park = t
        .add(
            &parked,
            json!({"stopped": true, "category": "iso", "rename": "Parked", "share_limits": {"ratio": {"mode": "limit", "value": 1.5}, "seeding_time": {"mode": "global"}, "inactive_seeding_time": {"mode": "unlimited"}, "action": null}}),
        )
        .await;
    let h_gone = t.add(&gone, json!({"stopped": true})).await;
    let magnet = "magnet:?xt=urn:btih:2222222222222222222222222222222222222222&dn=later";
    let (s, _) = t.post("/api/v1/torrents", json!({"urls": [magnet]})).await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = t
        .post(
            "/api/v1/torrents/delete",
            json!({"hashes": [h_gone.clone()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"upload_limit": 123456})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = t.post("/api/v1/tags", json!({"tags": ["spare"]})).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = t
        .post(
            "/api/v1/torrents/queue",
            json!({"hashes": [h_park.clone()], "to": "top"}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let before: Vec<String> = t
        .get("/api/v1/torrents?sort=queue_position")
        .await
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["hash"].as_str().unwrap().to_string())
        .collect();

    let dir = t.stop().await;
    let t = TestDaemon::start_in(dir, 41, None).await;

    let list = t.get("/api/v1/torrents?sort=queue_position").await;
    let after: Vec<String> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["hash"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(after, before, "same torrents, same queue order");
    assert!(!after.contains(&h_gone), "a removed torrent stays removed");

    let p = t.torrent(&h_park).await;
    assert_eq!(p["state"], "stopped");
    assert_eq!(p["name"], "Parked");
    assert_eq!(p["category"], "iso");
    assert_eq!(
        p["share_limits"]["ratio"],
        json!({"mode": "limit", "value": 1.5})
    );
    assert_eq!(
        p["share_limits"]["inactive_seeding_time"],
        json!({"mode": "unlimited"})
    );
    let s = t
        .wait_for(&h_seed, "seeding after restart", 30, |x| {
            x["state"] == "seeding"
        })
        .await;
    assert_eq!(s["tags"], json!(["keep"]));
    assert_eq!(s["progress"], 1.0);
    let m = t.torrent("2222222222222222222222222222222222222222").await;
    assert_eq!(m["has_metadata"], false);
    assert_eq!(m["state"], "metadata");
    assert_eq!(t.get("/api/v1/settings").await["upload_limit"], 123456);
    assert_eq!(t.get("/api/v1/tags").await, json!(["keep", "spare"]));
    assert!(t.get("/api/v1/categories").await["iso"].is_object());
    t.stop().await;
}

/// The library does not mark resume data for transfer counters: the daemon
/// saves a torrent whose counters moved, and at shutdown every torrent that
/// changed, so what a seed uploaded survives the restart.
#[tokio::test]
async fn a_seeds_upload_survives_a_restart() {
    let seeder = TestDaemon::start(45, |_| {}).await;
    let leecher = TestDaemon::start(46, |_| {}).await;
    let f = fixture(
        "shared.bin",
        &[("shared.bin", 300_000)],
        16_384,
        None,
        false,
        21,
    );
    f.write_to(&seeder.save_path());
    let hash = seeder.add(&f, json!({})).await;
    seeder
        .wait_for(&hash, "seeding", 30, |x| x["state"] == "seeding")
        .await;
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
    let before = seeder
        .wait_for(&hash, "upload counted", 30, |x| {
            x["uploaded"].as_u64().unwrap() >= 300_000
        })
        .await["uploaded"]
        .as_u64()
        .unwrap();
    leecher.stop().await;

    let dir = seeder.stop().await;
    let seeder = TestDaemon::start_in(dir, 45, None).await;
    let t = seeder
        .wait_for(&hash, "seeding after restart", 30, |x| {
            x["state"] == "seeding"
        })
        .await;
    assert!(t["uploaded"].as_u64().unwrap() >= before, "{t}");
    assert_eq!(t["uploaded_session"], 0, "{t}");
    seeder.stop().await;
}

#[tokio::test]
async fn a_0_1_data_directory_is_imported() {
    common::init_log();
    // What a 0.1.0 daemon left behind: JSON files and per-torrent files.
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let save = dir.path().join("downloads");
    std::fs::create_dir_all(data.join("torrents")).unwrap();
    std::fs::create_dir_all(data.join("resume")).unwrap();
    std::fs::write(
        data.join("settings.json"),
        serde_json::to_vec(&common::settings(44, &save)).unwrap(),
    )
    .unwrap();
    std::fs::write(data.join("tags.json"), br#"["old"]"#).unwrap();
    std::fs::write(
        data.join("categories.json"),
        br#"{"linux": {"save_path": null, "download_path": null}}"#,
    )
    .unwrap();
    let f = fixture(
        "legacy.iso",
        &[("legacy.iso", 50_000)],
        16_384,
        None,
        false,
        81,
    );
    f.write_to(&save);
    let record = json!({
        "format": 1, "info_hash": f.hash, "save_path": save.to_string_lossy(),
        "stopped": false, "category": "linux", "tags": ["old"], "name": "Legacy",
        "sequential": false, "queue_position": 0, "last_activity": 1, "seen_complete": 1,
    });
    std::fs::write(
        data.join(format!("torrents/{}.json", f.hash)),
        serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    std::fs::write(
        data.join(format!("torrents/{}.torrent", f.hash)),
        &f.torrent,
    )
    .unwrap();

    let t = TestDaemon::start_in(dir, 44, None).await;
    let x = t
        .wait_for(&f.hash, "seeding the imported torrent", 30, |x| {
            x["state"] == "seeding"
        })
        .await;
    assert_eq!(x["name"], "Legacy");
    assert_eq!(x["category"], "linux");
    assert_eq!(x["tags"], json!(["old"]));
    assert_eq!(t.get("/api/v1/tags").await, json!(["old"]));
    let data = t.dir.path().join("data");
    assert!(data.join("urtorrentd.db").exists());
    assert!(data.join("imported-0.1/torrents").is_dir());
    assert!(!data.join("torrents").exists());
    let log = t.get("/api/v1/log").await;
    assert!(
        log.as_array().unwrap().iter().any(|e| e["message"]
            .as_str()
            .unwrap()
            .contains("imported 1 torrents")),
        "{log}"
    );
    t.stop().await;
}

// ------------------------------------------------------------------ the binary

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

fn spawn(data: &std::path::Path, port: u16) -> Child {
    Command::new(env!("CARGO_BIN_EXE_urtorrentd"))
        .arg("--data-dir")
        .arg(data)
        .arg("--api-listen")
        .arg(format!("127.0.0.1:{port}"))
        .env("RUST_LOG", "warn")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap()
}

async fn wait_api(client: &reqwest::Client, base: &str) {
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(r) = client.get(format!("{base}/app")).send().await
            && r.status().is_success()
        {
            return;
        }
        assert!(Instant::now() < deadline, "the API never came up");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

async fn wait_exit(child: &mut Child, secs: u64) -> std::process::ExitStatus {
    let deadline = Instant::now() + Duration::from_secs(secs);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        assert!(Instant::now() < deadline, "the daemon did not exit");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn torrent_state(client: &reqwest::Client, base: &str, hash: &str) -> Value {
    client
        .get(format!("{base}/torrents/{hash}"))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap()
}

#[tokio::test]
async fn binary_survives_kill_and_stops_gracefully() {
    common::init_log();
    let dir = tempfile::tempdir().unwrap();
    let data = dir.path().join("data");
    let save = dir.path().join("downloads");
    std::fs::create_dir_all(&data).unwrap();
    std::fs::write(
        data.join("settings.json"),
        serde_json::to_vec(&common::settings(43, &save)).unwrap(),
    )
    .unwrap();
    let f = fixture(
        "kept",
        &[("x", 60_000), ("y", 10_000)],
        16_384,
        None,
        false,
        21,
    );
    f.write_to(&save);

    let port = free_port();
    let base = format!("http://127.0.0.1:{port}/api/v1");
    let client = reqwest::Client::new();
    let mut child = spawn(&data, port);
    wait_api(&client, &base).await;
    let r: Value = client
        .post(format!("{base}/torrents"))
        .json(&json!({"torrents": [f.b64()], "options": {"category": "c"}}))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(r["added"][0]["hash"], f.hash.as_str(), "{r}");
    let deadline = Instant::now() + Duration::from_secs(30);
    while torrent_state(&client, &base, &f.hash).await["state"] != "seeding" {
        assert!(Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    // kill -9: nothing graceful happens, and everything comes back.
    child.kill().unwrap();
    child.wait().unwrap();
    let port = free_port();
    let base = format!("http://127.0.0.1:{port}/api/v1");
    let mut child = spawn(&data, port);
    wait_api(&client, &base).await;
    let deadline = Instant::now() + Duration::from_secs(30);
    let t = loop {
        let t = torrent_state(&client, &base, &f.hash).await;
        if t["state"] == "seeding" {
            break t;
        }
        assert!(Instant::now() < deadline, "{t}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(t["category"], "c");
    assert_eq!(t["progress"], 1.0);

    // SIGTERM with an event stream open: still a clean exit (streams end
    // before the HTTP server drains).
    let stream = client.get(format!("{base}/events")).send().await.unwrap();
    assert_eq!(stream.status().as_u16(), 200);
    let pid = child.id().to_string();
    assert!(
        Command::new("kill")
            .args(["-TERM", &pid])
            .status()
            .unwrap()
            .success()
    );
    assert!(wait_exit(&mut child, 30).await.success());
    drop(stream);

    // And the shutdown endpoint.
    let port = free_port();
    let base = format!("http://127.0.0.1:{port}/api/v1");
    let mut child = spawn(&data, port);
    wait_api(&client, &base).await;
    let r = client
        .post(format!("{base}/app/shutdown"))
        .send()
        .await
        .unwrap();
    assert_eq!(r.status().as_u16(), 202);
    assert!(wait_exit(&mut child, 30).await.success());
}
