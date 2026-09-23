// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Torrents end to end through the API: two daemons on loopback, one seeding
//! and one leeching; every response is checked against the OpenAPI schema.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use common::{TestDaemon, fixture};
use serde_json::{Value, json};

#[tokio::test]
async fn leech_from_a_seeding_daemon() {
    let seeder = TestDaemon::start(31, |_| {}).await;
    let leecher = TestDaemon::start(32, |_| {}).await;
    let f = fixture(
        "album",
        &[
            ("01.flac", 200_000),
            ("02.flac", 150_000),
            ("cover/front.jpg", 30_000),
        ],
        16_384,
        None,
        false,
        7,
    );
    f.write_to(&seeder.save_path());

    // The seeder checks its data and seeds.
    let hash = seeder.add(&f, json!({})).await;
    assert_eq!(hash, f.hash);
    let t = seeder
        .wait_for(&hash, "seeding", 30, |t| t["state"] == "seeding")
        .await;
    assert_eq!(t["progress"], 1.0);
    assert_eq!(t["complete"], true);
    assert_eq!(t["comment"], "fixture");

    // The leecher gets it from the seeder.
    let (s, v) = leecher
        .post(
            "/api/v1/torrents",
            json!({"torrents": [f.b64()], "options": {"category": "music", "tags": ["flac", "new"], "sequential": true}}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["added"][0]["name"], "album");
    let (s, v) = leecher
        .post(
            "/api/v1/torrents/peers",
            json!({"hashes": [hash.clone()], "peers": [seeder.peer_addr()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["applied"], json!([hash.clone()]));
    let t = leecher
        .wait_for(&hash, "download", 60, |t| {
            t["complete"] == true && t["state"] == "seeding"
        })
        .await;
    assert_eq!(t["category"], "music");
    assert_eq!(t["tags"], json!(["flac", "new"]));
    assert_eq!(t["sequential"], true);
    assert!(t["downloaded"].as_u64().unwrap() >= 380_000, "{t}");
    assert_eq!(t["size"], 380_000);
    let save = leecher.save_path();
    for (path, bytes) in &f.files {
        assert_eq!(&std::fs::read(save.join(path)).unwrap(), bytes, "{path}");
    }
    assert_eq!(
        t["content_path"],
        save.join("album").to_string_lossy().as_ref()
    );
    assert_eq!(
        t["root_path"],
        save.join("album").to_string_lossy().as_ref()
    );

    // Files, pieces, hashes, the .torrent back.
    let files = leecher.get(&format!("/api/v1/torrents/{hash}/files")).await;
    let files = files.as_array().unwrap();
    assert_eq!(files.len(), 3);
    assert_eq!(files[0]["path"], "album/01.flac");
    assert_eq!(files[0]["first_piece"], 0);
    assert_eq!(files[1]["first_piece"], 200_000 / 16_384);
    assert_eq!(files[2]["progress"], 1.0);
    let pieces = leecher
        .get(&format!("/api/v1/torrents/{hash}/pieces"))
        .await;
    let n = (380_000usize).div_ceil(16_384);
    assert_eq!(pieces["states"].as_array().unwrap().len(), n);
    assert!(
        pieces["states"]
            .as_array()
            .unwrap()
            .iter()
            .all(|s| s == "have")
    );
    let hashes = leecher
        .get(&format!("/api/v1/torrents/{hash}/pieces/hashes"))
        .await;
    assert_eq!(hashes.as_array().unwrap().len(), n);
    let (s, headers, body) = leecher
        .request(
            Request::builder()
                .uri(format!("/api/v1/torrents/{hash}/torrent-file"))
                .body(Body::empty())
                .unwrap(),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(headers["content-type"], "application/x-bittorrent");
    let (s, meta) = leecher
        .post(
            "/api/v1/torrents/parse",
            json!({"torrent": base64_of(&body)}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        meta["hash"],
        hash.as_str(),
        "the exported .torrent has the same info-hash"
    );
    assert_eq!(meta["files"].as_array().unwrap().len(), 3);

    // Peers and sources. Two complete peers drop their connection, so the
    // peer list may be empty by now; the seeder's counters tell the story.
    let peers = seeder.get(&format!("/api/v1/torrents/{hash}/peers")).await;
    assert!(peers.is_array());
    let st = seeder.torrent(&hash).await;
    assert!(st["uploaded"].as_u64().unwrap() >= 380_000, "{st}");
    assert!(st["seen_complete"].is_u64());
    let trackers = leecher
        .get(&format!("/api/v1/torrents/{hash}/trackers"))
        .await;
    assert_eq!(trackers["trackers"], json!([]));
    assert_eq!(trackers["dht"]["enabled"], false, "DHT is off in the tests");
    assert_eq!(trackers["pex"]["enabled"], true);

    // Trackers and web seeds are editable.
    let tpath = format!("/api/v1/torrents/{hash}/trackers");
    let (s, v) = leecher
        .post(&tpath, json!({"urls": ["http://127.0.0.1:1/announce"]}))
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT, "{v}");
    let (s, _) = leecher
        .post(
            &format!("{tpath}/edit"),
            json!({"url": "http://127.0.0.1:1/announce", "new_url": "udp://127.0.0.1:2/announce"}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let trackers = leecher.get(&tpath).await;
    assert_eq!(trackers["trackers"][0]["url"], "udp://127.0.0.1:2/announce");
    let (s, _) = leecher
        .post(
            &format!("{tpath}/remove"),
            json!({"urls": ["udp://127.0.0.1:2/announce"]}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, v) = leecher.post(&tpath, json!({"urls": ["ftp://nope"]})).await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    let wpath = format!("/api/v1/torrents/{hash}/webseeds");
    let (s, _) = leecher
        .post(&wpath, json!({"urls": ["http://127.0.0.1:1/files/"]}))
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(
        leecher.get(&wpath).await,
        json!(["http://127.0.0.1:1/files/"])
    );
    let (s, _) = leecher
        .post(
            &format!("{wpath}/remove"),
            json!({"urls": ["http://127.0.0.1:1/files/"]}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);

    // Stop, start, limits, queue, share limits, rename.
    let one = json!({"hashes": [hash.clone()]});
    let (s, _) = leecher.post("/api/v1/torrents/stop", one.clone()).await;
    assert_eq!(s, StatusCode::OK);
    leecher
        .wait_for(&hash, "stopped", 10, |t| t["state"] == "stopped")
        .await;
    let listed = leecher.get("/api/v1/torrents?filter=stopped").await;
    assert_eq!(listed.as_array().unwrap().len(), 1);
    assert_eq!(
        leecher.get("/api/v1/torrents?filter=running").await,
        json!([])
    );
    let (s, _) = leecher.post("/api/v1/torrents/start", one.clone()).await;
    assert_eq!(s, StatusCode::OK);
    leecher
        .wait_for(&hash, "seeding again", 10, |t| t["state"] == "seeding")
        .await;
    let (s, _) = leecher
        .post(
            "/api/v1/torrents/limits",
            json!({"hashes": "all", "upload_limit": 50000, "max_connections": 7}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let t = leecher.torrent(&hash).await;
    assert_eq!(t["upload_limit"], 50000);
    assert_eq!(t["download_limit"], Value::Null);
    assert_eq!(t["max_connections"], 7);
    let (s, _) = leecher
        .post(
            "/api/v1/torrents/share-limits",
            json!({"hashes": [hash.clone()], "share_limits": {"ratio": {"mode": "limit", "value": 2.5}, "seeding_time": {"mode": "unlimited"}, "inactive_seeding_time": {"mode": "global"}, "action": "stop"}}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = leecher
        .call(
            Method::PATCH,
            &format!("/api/v1/torrents/{hash}"),
            Some(json!({"name": "My Album"})),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let t = leecher.torrent(&hash).await;
    assert_eq!(t["name"], "My Album");
    assert_eq!(
        t["share_limits"]["ratio"],
        json!({"mode": "limit", "value": 2.5})
    );

    // Tags and categories.
    let (s, _) = leecher
        .post(
            "/api/v1/torrents/tags",
            json!({"hashes": [hash.clone()], "mode": "remove", "tags": ["new"]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(leecher.torrent(&hash).await["tags"], json!(["flac"]));
    assert_eq!(leecher.get("/api/v1/tags").await, json!(["flac", "new"]));
    assert_eq!(
        leecher
            .get("/api/v1/torrents?tag=flac")
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        leecher.get("/api/v1/torrents?category=other").await,
        json!([])
    );
    let cats = leecher.get("/api/v1/categories").await;
    assert_eq!(
        cats["music"],
        json!({"save_path": null, "download_path": null})
    );
    let (s, _) = leecher
        .post("/api/v1/tags/remove", json!({"tags": ["flac"]}))
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(leecher.torrent(&hash).await["tags"], json!([]));

    // Automatic management moves the content to the category's path.
    let (s, _) = leecher
        .post(
            "/api/v1/torrents/auto-management",
            json!({"hashes": [hash.clone()], "value": true}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let moved = save.join("music");
    let t = leecher
        .wait_for(&hash, "moved to the category path", 30, |t| {
            t["save_path"] == moved.to_string_lossy().as_ref() && t["state"] != "moving"
        })
        .await;
    assert_eq!(t["auto_management"], true);
    assert!(moved.join("album/01.flac").exists());
    assert!(!save.join("album/01.flac").exists());

    // Rename a file.
    let (s, v) = leecher
        .post(
            &format!("/api/v1/torrents/{hash}/files/rename"),
            json!({"old_path": "album/cover/front.jpg", "new_path": "album/front.jpg"}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT, "{v}");
    assert!(moved.join("album/front.jpg").exists());

    // Delete with files.
    let (s, v) = leecher
        .post(
            "/api/v1/torrents/delete",
            json!({"hashes": [hash.clone()], "delete_files": true}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["applied"], json!([hash.clone()]));
    assert_eq!(leecher.get("/api/v1/torrents").await, json!([]));
    assert!(!moved.join("album/01.flac").exists());
    let (s, _) = leecher
        .call(Method::GET, &format!("/api/v1/torrents/{hash}"), None)
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    let log = leecher.get("/api/v1/log").await;
    let messages: Vec<&str> = log
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["message"].as_str().unwrap())
        .collect();
    assert!(
        messages
            .iter()
            .any(|m| m.starts_with("added torrent album")),
        "{messages:?}"
    );
    assert!(
        messages
            .iter()
            .any(|m| m.starts_with("finished downloading")),
        "{messages:?}"
    );
    assert!(
        messages.iter().any(|m| m.starts_with("removed torrent")),
        "{messages:?}"
    );

    seeder.stop().await;
    leecher.stop().await;
}

fn base64_of(b: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(b)
}

#[tokio::test]
async fn sync_sends_changes_only() {
    let t = TestDaemon::start(33, |_| {}).await;
    let first = t.get("/api/v1/sync").await;
    assert_eq!(first["full"], true);
    assert_eq!(first["torrents"], json!({}));
    let rev = first["rev"].as_u64().unwrap();

    let a = fixture("a.bin", &[("a.bin", 40_000)], 16_384, None, false, 1);
    let b = fixture("b.bin", &[("b.bin", 40_000)], 16_384, None, false, 2);
    let ha = t.add(&a, json!({"stopped": true})).await;
    let hb = t.add(&b, json!({"stopped": true})).await;
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    let diff = t.get(&format!("/api/v1/sync?rev={rev}")).await;
    assert_eq!(diff["full"], false);
    let keys: Vec<&String> = diff["torrents"].as_object().unwrap().keys().collect();
    assert_eq!(keys.len(), 2);
    assert_eq!(diff["tags"], Value::Null, "tags did not change");
    let rev = diff["rev"].as_u64().unwrap();

    // Nothing changed: an empty diff.
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    let same = t.get(&format!("/api/v1/sync?rev={rev}")).await;
    assert_eq!(same["torrents"], json!({}), "{same}");
    let rev = same["rev"].as_u64().unwrap();

    // One torrent changes, one goes away, a category appears.
    let (s, _) = t
        .post(
            "/api/v1/torrents/category",
            json!({"hashes": [ha.clone()], "category": "x"}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = t
        .post("/api/v1/torrents/delete", json!({"hashes": [hb.clone()]}))
        .await;
    assert_eq!(s, StatusCode::OK);
    tokio::time::sleep(std::time::Duration::from_millis(600)).await;
    let diff = t.get(&format!("/api/v1/sync?rev={rev}")).await;
    let keys: Vec<&String> = diff["torrents"].as_object().unwrap().keys().collect();
    assert_eq!(keys, vec![&ha]);
    assert_eq!(diff["torrents"][&ha]["category"], "x");
    assert_eq!(diff["torrents_removed"], json!([hb]));
    assert!(diff["categories"]["x"].is_object());

    // An unknown revision gets everything again.
    let full = t.get("/api/v1/sync?rev=999999").await;
    assert_eq!(full["full"], true);
    assert_eq!(full["torrents"].as_object().unwrap().len(), 1);
    t.stop().await;
}

#[tokio::test]
async fn add_options_and_layouts() {
    let t = TestDaemon::start(34, |_| {}).await;
    let single = fixture(
        "movie.mkv",
        &[("movie.mkv", 50_000)],
        16_384,
        None,
        false,
        3,
    );
    let multi = fixture(
        "Show",
        &[("e1.mkv", 20_000), ("e2.mkv", 20_000)],
        16_384,
        None,
        false,
        4,
    );
    let private = fixture(
        "secret",
        &[("secret", 20_000)],
        16_384,
        Some("http://127.0.0.1:1/a"),
        true,
        5,
    );
    let (s, _) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"add_trackers": ["udp://127.0.0.1:9/announce"]})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);

    let h1 = t
        .add(
            &single,
            json!({"stopped": true, "content_layout": "subfolder", "rename": "The Movie"}),
        )
        .await;
    let h2 = t
        .add(
            &multi,
            json!({"stopped": true, "content_layout": "no_subfolder", "file_priorities": [1, 0]}),
        )
        .await;
    let h3 = t.add(&private, json!({"stopped": true})).await;

    let f1 = t.get(&format!("/api/v1/torrents/{h1}/files")).await;
    assert_eq!(f1[0]["path"], "movie/movie.mkv");
    assert_eq!(t.torrent(&h1).await["name"], "The Movie");
    let f2 = t.get(&format!("/api/v1/torrents/{h2}/files")).await;
    assert_eq!(f2[0]["path"], "e1.mkv");
    assert_eq!(f2[1]["priority"], 0);

    // The automatic tracker list reaches public torrents only.
    let tr1 = t.get(&format!("/api/v1/torrents/{h1}/trackers")).await;
    assert_eq!(tr1["trackers"][0]["url"], "udp://127.0.0.1:9/announce");
    let tr3 = t.get(&format!("/api/v1/torrents/{h3}/trackers")).await;
    let urls: Vec<&str> = tr3["trackers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["url"].as_str().unwrap())
        .collect();
    assert_eq!(
        urls,
        vec!["http://127.0.0.1:1/a"],
        "no extra tracker on a private torrent"
    );
    assert_eq!(tr3["pex"]["enabled"], false);
    assert_eq!(t.torrent(&h3).await["private"], true);

    // Duplicates, file priorities, count, list filters.
    let (s, v) = t
        .post("/api/v1/torrents", json!({"torrents": [single.b64()]}))
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["failed"][0]["error"]["code"], "duplicate");
    assert_eq!(v["failed"][0]["hash"], h1.as_str());
    let (s, _) = t
        .post(
            &format!("/api/v1/torrents/{h2}/files/priority"),
            json!({"indexes": [1], "priority": 7}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let f2 = t.get(&format!("/api/v1/torrents/{h2}/files")).await;
    assert_eq!(f2[1]["priority"], 7);
    let (s, _) = t
        .post(
            &format!("/api/v1/torrents/{h2}/files/priority"),
            json!({"indexes": [9], "priority": 1}),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    assert_eq!(t.get("/api/v1/torrents/count").await["count"], 3);
    assert_eq!(
        t.get("/api/v1/torrents?private=true")
            .await
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let sorted = t
        .get("/api/v1/torrents?sort=name&reverse=true&limit=2")
        .await;
    let names: Vec<&str> = sorted
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["The Movie", "Show"]);

    // A magnet link and a bare info-hash wait for metadata.
    let (s, v) = t
        .post(
            "/api/v1/torrents",
            json!({"urls": ["magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&dn=wanted", "fedcba9876543210fedcba9876543210fedcba98"]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["added"].as_array().unwrap().len(), 2, "{v}");
    let m = t.torrent("0123456789abcdef0123456789abcdef01234567").await;
    assert_eq!(m["state"], "metadata");
    assert_eq!(m["has_metadata"], false);
    assert_eq!(m["name"], "wanted");
    let (s, v) = t
        .call(
            Method::GET,
            "/api/v1/torrents/0123456789abcdef0123456789abcdef01234567/files",
            None,
        )
        .await;
    assert_eq!((s, v), (StatusCode::OK, json!([])));
    t.stop().await;
}

#[tokio::test]
async fn add_from_a_url() {
    let t = TestDaemon::start(35, |_| {}).await;
    let f = fixture("web.bin", &[("web.bin", 30_000)], 16_384, None, false, 9);
    let torrent = f.torrent.clone();
    // A tiny HTTP server: /t.torrent serves the file, /m redirects to a magnet,
    // /404 fails. It records the User-Agent it saw.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let agents = std::sync::Arc::new(std::sync::Mutex::new(Vec::<String>::new()));
    let seen = agents.clone();
    let app = axum::Router::new()
        .route(
            "/t.torrent",
            axum::routing::get(move |h: axum::http::HeaderMap| {
                let torrent = torrent.clone();
                let seen = seen.clone();
                async move {
                    let ua = h
                        .get("user-agent")
                        .and_then(|v| v.to_str().ok())
                        .unwrap_or("")
                        .to_string();
                    seen.lock().unwrap().push(ua);
                    torrent
                }
            }),
        )
        .route(
            "/m",
            axum::routing::get(|| async {
                axum::response::Redirect::to(
                    "magnet:?xt=urn:btih:1111111111111111111111111111111111111111",
                )
            }),
        );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let (s, v) = t
        .post(
            "/api/v1/torrents",
            json!({"urls": [format!("http://{addr}/t.torrent"), format!("http://{addr}/m"), format!("http://{addr}/404")], "options": {"stopped": true}}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let added: Vec<&str> = v["added"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["hash"].as_str().unwrap())
        .collect();
    assert_eq!(
        added,
        vec![f.hash.as_str(), "1111111111111111111111111111111111111111"],
        "{v}"
    );
    assert_eq!(v["failed"][0]["error"]["code"], "download_failed");
    assert!(
        agents.lock().unwrap()[0].starts_with("urtorrent/"),
        "the identity's user agent"
    );
    let d = t.torrent(&f.hash).await;
    assert_eq!(d["source_url"], format!("http://{addr}/t.torrent"));
    t.stop().await;
}

#[tokio::test]
async fn policies_stop_conditions_share_limits_download_path() {
    let seeder = TestDaemon::start(36, |_| {}).await;
    let leecher = TestDaemon::start(37, |_| {}).await;
    let f = fixture("p.bin", &[("p.bin", 120_000)], 16_384, None, false, 31);
    f.write_to(&seeder.save_path());

    // Stop condition: the seeder stops as soon as its files are checked.
    let hash = seeder
        .add(&f, json!({"stop_condition": "files_checked"}))
        .await;
    seeder
        .wait_for(&hash, "stopped after the check", 30, |t| {
            t["state"] == "stopped" && t["complete"] == true
        })
        .await;
    let (s, _) = seeder
        .post("/api/v1/torrents/start", json!({"hashes": [hash.clone()]}))
        .await;
    assert_eq!(s, StatusCode::OK);
    seeder
        .wait_for(&hash, "seeding", 30, |t| t["state"] == "seeding")
        .await;

    // Download path: incomplete data lives there, then moves to the save path.
    let staging = leecher.dir.path().join("incomplete");
    leecher
        .add(
            &f,
            json!({"download_path": staging.to_string_lossy(), "category": "done"}),
        )
        .await;
    let (s, _) = leecher
        .post(
            "/api/v1/torrents/peers",
            json!({"hashes": [hash.clone()], "peers": [seeder.peer_addr()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let save = leecher.save_path();
    let t = leecher
        .wait_for(&hash, "complete and moved", 60, |t| {
            t["complete"] == true && t["download_path"].is_null() && t["state"] == "seeding"
        })
        .await;
    assert_eq!(t["save_path"], save.to_string_lossy().as_ref());
    assert_eq!(std::fs::read(save.join("p.bin")).unwrap(), f.files[0].1);
    assert!(!staging.join("p.bin").exists());

    // Share limits: the seeder stops once its ratio reaches the limit.
    let (s, _) = seeder
        .post(
            "/api/v1/torrents/share-limits",
            json!({"hashes": [hash.clone()], "share_limits": {"ratio": {"mode": "limit", "value": 0.5}, "seeding_time": {"mode": "global"}, "inactive_seeding_time": {"mode": "global"}, "action": "stop"}}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let t = seeder
        .wait_for(&hash, "stopped by the ratio limit", 30, |t| {
            t["state"] == "stopped"
        })
        .await;
    assert!(t["ratio"].as_f64().unwrap() >= 0.5, "{t}");
    let log = seeder.get("/api/v1/log").await;
    assert!(
        log.as_array()
            .unwrap()
            .iter()
            .any(|e| e["message"].as_str().unwrap().contains("ratio limit")),
        "{log}"
    );
    seeder.stop().await;
    leecher.stop().await;
}

#[tokio::test]
async fn errored_torrents_recover() {
    let seeder = TestDaemon::start(38, |_| {}).await;
    let leecher = TestDaemon::start(39, |_| {}).await;
    let f = fixture(
        "locked.bin",
        &[("locked.bin", 40_000)],
        16_384,
        None,
        false,
        41,
    );
    f.write_to(&seeder.save_path());
    let hash = seeder.add(&f, json!({})).await;
    seeder
        .wait_for(&hash, "seeding", 30, |x| x["state"] == "seeding")
        .await;

    // A magnet whose save directory cannot be written: the files cannot be
    // created once the metadata arrives, and the torrent stops with an error.
    let locked = leecher.dir.path().join("read-only");
    std::fs::create_dir_all(&locked).unwrap();
    let mut perms = std::fs::metadata(&locked).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o555);
    std::fs::set_permissions(&locked, perms).unwrap();
    let (s, v) = leecher
        .post(
            "/api/v1/torrents",
            json!({"urls": [hash.clone()], "options": {"save_path": locked.to_string_lossy()}}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["added"][0]["hash"], hash.as_str(), "{v}");
    let (s, _) = leecher
        .post(
            "/api/v1/torrents/peers",
            json!({"hashes": [hash.clone()], "peers": [seeder.peer_addr()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let e = leecher
        .wait_for(&hash, "an error", 30, |x| x["state"] == "error")
        .await;
    assert!(e["error"].is_string(), "{e}");

    assert_eq!(e["error_kind"], "io", "{e}");

    // Recovery (urtorrent 0.12): once the directory is writable again,
    // `start` retries and the download completes.
    let mut perms = std::fs::metadata(&locked).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut perms, 0o755);
    std::fs::set_permissions(&locked, perms).unwrap();
    let (s, v) = leecher
        .post("/api/v1/torrents/start", json!({"hashes": [hash.clone()]}))
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["applied"], json!([hash.clone()]), "{v}");
    let (s, _) = leecher
        .post(
            "/api/v1/torrents/peers",
            json!({"hashes": [hash.clone()], "peers": [seeder.peer_addr()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let t = leecher
        .wait_for(&hash, "recovered and complete", 60, |x| {
            x["complete"] == true
        })
        .await;
    assert_eq!(t["error"], Value::Null);
    assert_eq!(
        std::fs::read(locked.join("locked.bin")).unwrap(),
        f.files[0].1
    );
    seeder.stop().await;
    leecher.stop().await;
}

#[tokio::test]
async fn magnets_are_held_for_stop_conditions_and_layouts() {
    let seeder = TestDaemon::start(51, |_| {}).await;
    let leecher = TestDaemon::start(52, |_| {}).await;
    let f = fixture(
        "Season",
        &[("e1.mkv", 50_000), ("e2.mkv", 40_000)],
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

    // A magnet that stops once its metadata is known, laid out without its
    // top-level folder: held by the engine, so nothing is downloaded before
    // the daemon applies the layout.
    let (s, v) = leecher
        .post(
            "/api/v1/torrents",
            json!({"urls": [hash.clone()], "options": {"stop_condition": "metadata_received", "content_layout": "no_subfolder"}}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let (s, _) = leecher
        .post(
            "/api/v1/torrents/peers",
            json!({"hashes": [hash.clone()], "peers": [seeder.peer_addr()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let t = leecher
        .wait_for(&hash, "stopped after its metadata", 30, |x| {
            x["has_metadata"] == true && x["state"] == "stopped"
        })
        .await;
    assert_eq!(t["downloaded"], 0, "no payload before the stop: {t}");
    let files = leecher.get(&format!("/api/v1/torrents/{hash}/files")).await;
    let paths: Vec<&str> = files
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["path"].as_str().unwrap())
        .collect();
    assert_eq!(paths, vec!["e1.mkv", "e2.mkv"]);

    // Started, it downloads into the new layout.
    let (s, v) = leecher
        .post("/api/v1/torrents/start", json!({"hashes": [hash.clone()]}))
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["applied"], json!([hash.clone()]), "{v}");
    let (s, v) = leecher
        .post(
            "/api/v1/torrents/peers",
            json!({"hashes": [hash.clone()], "peers": [seeder.peer_addr()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["applied"], json!([hash.clone()]), "{v}");
    leecher
        .wait_for(&hash, "complete", 30, |x| x["complete"] == true)
        .await;
    let save = leecher.save_path();
    assert_eq!(std::fs::read(save.join("e1.mkv")).unwrap(), f.files[0].1);
    assert!(!save.join("Season").exists());
    seeder.stop().await;
    leecher.stop().await;
}

#[tokio::test]
async fn first_and_last_pieces_first() {
    let t = TestDaemon::start(53, |_| {}).await;
    // Two files over 16 KiB pieces: a.bin covers pieces 0..=3, b.bin 3..=5.
    let f = fixture(
        "pair",
        &[("a.bin", 60_000), ("b.bin", 30_000)],
        16_384,
        None,
        false,
        71,
    );
    let hash = t
        .add(
            &f,
            json!({"stopped": true, "first_last_piece_priority": true}),
        )
        .await;
    let d = t.torrent(&hash).await;
    assert_eq!(d["first_last_piece_priority"], true);
    let p = t.get(&format!("/api/v1/torrents/{hash}/pieces")).await;
    let prios: Vec<u64> = p["priorities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x.as_u64().unwrap())
        .collect();
    assert_eq!(prios.len(), 6);
    assert_eq!(prios[0], 7, "{prios:?}");
    assert_eq!(prios[3], 7, "a's last and b's first: {prios:?}");
    assert_eq!(prios[5], 7, "{prios:?}");
    assert!(prios[1] < 7 && prios[2] < 7 && prios[4] < 7, "{prios:?}");

    // File priorities decide every piece again; the flag re-applies.
    let (s, _) = t
        .post(
            &format!("/api/v1/torrents/{hash}/files/priority"),
            json!({"indexes": [1], "priority": 0}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let p = t.get(&format!("/api/v1/torrents/{hash}/pieces")).await;
    assert_eq!(p["priorities"][0], 7);
    assert_eq!(p["priorities"][5], 0, "b is skipped now");

    // Off: back to what the file priorities say.
    let (s, v) = t
        .post(
            "/api/v1/torrents/first-last-piece-priority",
            json!({"hashes": [hash.clone()], "value": false}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["applied"], json!([hash.clone()]));
    let p = t.get(&format!("/api/v1/torrents/{hash}/pieces")).await;
    assert!(p["priorities"][0].as_u64().unwrap() < 7, "{p}");
    assert_eq!(t.torrent(&hash).await["first_last_piece_priority"], false);
    t.stop().await;
}
