// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The smaller preferences of the checklist, on real daemons: add
//! defaults, category paths in manual mode, excluded file names, merged
//! trackers, `.torrent` export, the download path after adding, recheck on
//! completion, the cookie jar, trackers from a URL, trusted proxies and
//! network interfaces.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::net::SocketAddr;
use std::sync::Arc;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::http::{HeaderMap, Method, Request, StatusCode, header};
use common::{TestDaemon, fixture};
use serde_json::{Value, json};

async fn patch(t: &TestDaemon, body: Value) -> (StatusCode, Value) {
    t.call(Method::PATCH, "/api/v1/settings", Some(body)).await
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
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

fn priorities(files: &Value) -> Vec<(String, u64)> {
    files
        .as_array()
        .unwrap()
        .iter()
        .map(|f| {
            (
                f["path"].as_str().unwrap().to_string(),
                f["priority"].as_u64().unwrap(),
            )
        })
        .collect()
}

#[tokio::test]
async fn add_defaults_paths_exclusions_merges_and_exports() {
    let t = TestDaemon::start(79, |_| {}).await;
    let dirs = tempfile::tempdir().unwrap();
    let export = dirs.path().join("export");
    let (s, v) = patch(
        &t,
        json!({
            "instance_name": "attic",
            "content_layout": "subfolder",
            "stop_condition": "files_checked",
            "category_paths_in_manual_mode": true,
            "excluded_file_names": ["*.nfo", "sample"],
            "merge_trackers": true,
            "export_dir": export,
        }),
    )
    .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(t.get("/api/v1/app").await["instance_name"], "attic");
    let iso = dirs.path().join("iso");
    let (s, _) = t
        .post(
            "/api/v1/categories",
            json!({"name": "iso", "save_path": iso, "download_path": null}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);

    // Defaults: a single file gets its own folder, and it stops once checked;
    // with a category and no save path it goes to the category's.
    let one = fixture(
        "one.iso",
        &[("one.iso", 20_000)],
        16_384,
        Some("http://127.0.0.1:1/a"),
        false,
        101,
    );
    let h = t.add(&one, json!({"category": "iso"})).await;
    let x = t
        .wait_for(&h, "stopped", 30, |x| x["state"] == "stopped")
        .await;
    assert_eq!(x["save_path"], iso.to_string_lossy().as_ref(), "{x}");
    assert_eq!(x["auto_management"], false);
    let files = t.get(&format!("/api/v1/torrents/{h}/files")).await;
    assert_eq!(priorities(&files), [("one/one.iso".to_string(), 4)]);

    // Excluded names: a file, and a folder on the path.
    let pack = fixture(
        "pack",
        &[
            ("movie.mkv", 30_000),
            ("info.NFO", 100),
            ("Sample/s.mkv", 5_000),
        ],
        16_384,
        None,
        false,
        102,
    );
    let p = t
        .add(
            &pack,
            json!({"content_layout": "original", "stopped": true}),
        )
        .await;
    let files = t.get(&format!("/api/v1/torrents/{p}/files")).await;
    assert_eq!(
        priorities(&files),
        [
            ("pack/movie.mkv".to_string(), 4),
            ("pack/info.NFO".to_string(), 0),
            ("pack/Sample/s.mkv".to_string(), 0)
        ]
    );

    // Exported when added.
    let exported = std::fs::read(export.join("one.iso.torrent")).unwrap();
    assert_eq!(
        exported,
        t.get_bytes(&format!("/api/v1/torrents/{h}/torrent-file"))
            .await
    );

    // The same torrent again, with another tracker: merged, and still a 409.
    let again = fixture(
        "one.iso",
        &[("one.iso", 20_000)],
        16_384,
        Some("http://127.0.0.1:2/b"),
        false,
        101,
    );
    assert_eq!(again.hash, one.hash);
    let (s, v) = t
        .post("/api/v1/torrents", json!({"torrents": [again.b64()]}))
        .await;
    assert_eq!(s, StatusCode::OK);
    let msg = v["failed"][0]["error"]["message"].as_str().unwrap();
    assert!(msg.contains("1 trackers or web seeds merged"), "{v}");
    let urls: Vec<String> = t.get(&format!("/api/v1/torrents/{h}/trackers")).await["trackers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["url"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(urls, ["http://127.0.0.1:1/a", "http://127.0.0.1:2/b"]);
    // Never into a private torrent.
    let private = fixture(
        "p.iso",
        &[("p.iso", 10_000)],
        16_384,
        Some("http://127.0.0.1:1/p"),
        true,
        103,
    );
    let hp = t.add(&private, json!({"stopped": true})).await;
    let private2 = fixture(
        "p.iso",
        &[("p.iso", 10_000)],
        16_384,
        Some("http://127.0.0.1:3/q"),
        true,
        103,
    );
    let (_, v) = t
        .post("/api/v1/torrents", json!({"torrents": [private2.b64()]}))
        .await;
    assert!(!v.to_string().contains("merged"), "{v}");
    assert_eq!(
        t.get(&format!("/api/v1/torrents/{hp}/trackers")).await["trackers"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    // The download path after adding: the incomplete torrent moves there
    // and back; a complete one would keep its content in place.
    let staging = dirs.path().join("staging");
    let (s, v) = t
        .post(
            "/api/v1/torrents/download-path",
            json!({"hashes": [p.clone()], "path": staging}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["applied"], json!([p.clone()]));
    let x = t
        .wait_for(&p, "the move", 30, |x| {
            x["download_path"] == staging.to_string_lossy().as_ref() && x["state"] != "moving"
        })
        .await;
    assert_eq!(x["auto_management"], false);
    // A new save path while it downloads there: recorded, nothing moves
    // until it completes (or the download path goes).
    let later = dirs.path().join("later");
    let (s, v) = t
        .post(
            "/api/v1/torrents/location",
            json!({"hashes": [p.clone()], "path": later}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["applied"], json!([p.clone()]));
    let x = t.torrent(&p).await;
    assert_eq!(x["save_path"], later.to_string_lossy().as_ref(), "{x}");
    assert_eq!(x["download_path"], staging.to_string_lossy().as_ref());
    assert_ne!(x["state"], "moving");
    assert!(!later.exists(), "nothing moved yet");
    let (s, _) = t
        .post(
            "/api/v1/torrents/download-path",
            json!({"hashes": [p.clone()], "path": null}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    t.wait_for(&p, "the move to the new save path", 30, |x| {
        x["download_path"].is_null()
            && x["state"] != "moving"
            && x["save_path"] == later.to_string_lossy().as_ref()
    })
    .await;
    let (s, _) = t
        .post(
            "/api/v1/torrents/download-path",
            json!({"hashes": [p], "path": "relative"}),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // Interfaces: loopback is there, and listening follows it.
    let ifaces = t.get("/api/v1/app/interfaces").await;
    assert!(
        ifaces.as_array().unwrap().iter().any(|i| i["name"] == "lo"),
        "{ifaces}"
    );
    let (s, _) = patch(&t, json!({"listen_interface": "lo"})).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        t.get("/api/v1/app").await["listen_addresses"],
        json!(["127.0.0.1"])
    );
    let (s, _) = patch(&t, json!({"listen_interface": "gone0"})).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(
        t.get("/api/v1/app").await["listen_addresses"],
        json!(["127.0.0.1"]),
        "no address: loopback only"
    );

    // Refusals.
    for bad in [
        json!({"export_dir": "relative"}),
        json!({"add_trackers_url": "ftp://x/list"}),
        json!({"excluded_file_names": [""]}),
        json!({"api_trusted_proxies": ["not an address"]}),
        json!({"listen_interface": ""}),
    ] {
        let (s, v) = patch(&t, bad.clone()).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{bad}: {v}");
    }
    t.stop().await;
}

#[tokio::test]
async fn trusted_proxies_forward_the_client_address_and_host() {
    // Tests call as 127.0.0.1 with api_bypass_local_auth on.
    let t = TestDaemon::start(80, |_| {}).await;
    let get = |xff: &'static str, host: Option<&'static str>| {
        let mut b = Request::get("/api/v1/app").header("x-forwarded-for", xff);
        if let Some(h) = host {
            b = b.header("x-forwarded-host", h);
        }
        b.body(Body::empty()).unwrap()
    };
    // Not trusted: the header is not believed, and a relayed request's
    // client is unknown, so the loopback exemption does not apply (ADR
    // 0008); without the header the loopback client passes.
    assert_eq!(
        t.request(get("203.0.113.9", None)).await.0,
        StatusCode::UNAUTHORIZED
    );
    let direct = Request::get("/api/v1/app").body(Body::empty()).unwrap();
    assert_eq!(t.request(direct).await.0, StatusCode::OK);
    let (s, _) = patch(&t, json!({"api_trusted_proxies": ["127.0.0.1"]})).await;
    assert_eq!(s, StatusCode::OK);
    // Trusted: the forwarded client is not local and must log in.
    assert_eq!(
        t.request(get("203.0.113.9", None)).await.0,
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(t.request(get("127.0.0.1", None)).await.0, StatusCode::OK);
    // The forwarded host is checked like `Host`.
    assert_eq!(
        t.request(get("127.0.0.1", Some("evil.example"))).await.0,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        t.request(get("127.0.0.1", Some("localhost"))).await.0,
        StatusCode::OK
    );
    t.stop().await;
}

#[tokio::test]
async fn magnets_are_excluded_rechecked_and_exported_when_finished() {
    let dirs = tempfile::tempdir().unwrap();
    let done = dirs.path().join("done");
    let seeder = TestDaemon::start(81, |_| {}).await;
    let done2 = done.clone();
    let leecher = TestDaemon::start(82, move |s| {
        s.excluded_file_names = vec!["*.txt".into()];
        s.recheck_on_completion = true;
        s.export_dir_finished = Some(done2.to_string_lossy().into_owned());
    })
    .await;
    let f = fixture(
        "bundle",
        &[("a.bin", 60_000), ("readme.txt", 3_000)],
        16_384,
        None,
        false,
        104,
    );
    f.write_to(&seeder.save_path());
    let hash = seeder.add(&f, json!({})).await;
    seeder
        .wait_for(&hash, "seeding", 30, |x| x["state"] == "seeding")
        .await;
    let magnet = format!("magnet:?xt=urn:btih:{hash}&x.pe={}", seeder.peer_addr());
    let (s, v) = leecher
        .post("/api/v1/torrents", json!({"urls": [magnet]}))
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    leecher
        .wait_for(&hash, "download", 60, |x| x["complete"] == true)
        .await;
    let files = leecher.get(&format!("/api/v1/torrents/{hash}/files")).await;
    assert_eq!(
        priorities(&files),
        [
            ("bundle/a.bin".to_string(), 4),
            ("bundle/readme.txt".to_string(), 0)
        ],
        "excluded before any file existed"
    );
    assert!(!leecher.save_path().join("bundle/readme.txt").exists());
    wait_get(&leecher, "/api/v1/log", "the recheck", |v| {
        v.to_string().contains("recheck_on_completion")
    })
    .await;
    let deadline = Instant::now() + Duration::from_secs(20);
    while !done.join("bundle.torrent").exists() {
        assert!(Instant::now() < deadline, "not exported when finished");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    leecher.stop().await;
    seeder.stop().await;
}

/// `/list` is a tracker list; `/t.torrent` wants the cookie `uid=42`.
async fn server(torrent: Vec<u8>, hits: Arc<AtomicU32>) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .route(
            "/list",
            axum::routing::get(move || {
                let hits = hits.clone();
                async move {
                    hits.fetch_add(1, Ordering::SeqCst);
                    "# trackers\nhttp://127.0.0.1:5/announce\n\nudp://127.0.0.1:6/announce\n"
                }
            }),
        )
        .route(
            "/t.torrent",
            axum::routing::get(move |headers: HeaderMap| {
                let torrent = torrent.clone();
                async move {
                    let ok = headers
                        .get(header::COOKIE)
                        .and_then(|v| v.to_str().ok())
                        .is_some_and(|c| c.split("; ").any(|kv| kv == "uid=42"));
                    if ok {
                        (StatusCode::OK, torrent)
                    } else {
                        (StatusCode::FORBIDDEN, Vec::new())
                    }
                }
            }),
        );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
}

#[tokio::test]
async fn cookies_and_trackers_from_a_url() {
    let f = fixture(
        "cookie.iso",
        &[("cookie.iso", 10_000)],
        16_384,
        None,
        false,
        105,
    );
    let hits = Arc::new(AtomicU32::new(0));
    let addr = server(f.torrent.clone(), hits.clone()).await;
    let t = TestDaemon::start(83, |_| {}).await;
    let url = format!("http://{addr}/t.torrent");

    // Without the cookie the download is refused; with it in the jar, it works.
    let (_, v) = t
        .post(
            "/api/v1/torrents",
            json!({"urls": [url.clone()], "options": {"stopped": true}}),
        )
        .await;
    assert!(
        v["failed"][0]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("403"),
        "{v}"
    );
    let jar = json!([{"name": "uid", "value": "42", "domain": "127.0.0.1"}]);
    let (s, _) = t.call(Method::PUT, "/api/v1/app/cookies", Some(jar)).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(t.get("/api/v1/app/cookies").await[0]["path"], "/");
    for bad in [
        json!([{"name": "", "value": "1", "domain": "x"}]),
        json!([{"name": "a", "value": "1;2", "domain": "x"}]),
        json!([{"name": "a", "value": "1", "domain": "x", "path": "rel"}]),
    ] {
        let (s, _) = t.call(Method::PUT, "/api/v1/app/cookies", Some(bad)).await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }

    // The tracker list, fetched at once, then added to new public torrents.
    let (s, _) = patch(
        &t,
        json!({"add_trackers_url": format!("http://{addr}/list")}),
    )
    .await;
    assert_eq!(s, StatusCode::OK);
    let app = wait_get(&t, "/api/v1/app", "the list", |v| {
        v["fetched_trackers"]["fetched"].is_u64()
    })
    .await;
    assert_eq!(
        app["fetched_trackers"]["trackers"],
        json!(["http://127.0.0.1:5/announce", "udp://127.0.0.1:6/announce"])
    );
    assert_eq!(hits.load(Ordering::SeqCst), 1);
    assert_eq!(app["fetched_trackers"]["fetching"], false);
    // In the log, by host (a list's URL can carry a token).
    let log = t.get("/api/v1/log?topics=trackers").await;
    assert_eq!(
        log[0]["message"], "fetched 2 trackers from 127.0.0.1",
        "{log}"
    );
    // Fetched again when asked, not only once a day.
    let (s, _) = t
        .call(Method::POST, "/api/v1/app/fetched-trackers/refresh", None)
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);
    wait_get(&t, "/api/v1/app", "the list again", |v| {
        v["fetched_trackers"]["fetching"] == false && hits.load(Ordering::SeqCst) == 2
    })
    .await;
    let (s, v) = t
        .post(
            "/api/v1/torrents",
            json!({"urls": [url], "options": {"stopped": true}}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(v["added"][0]["hash"], f.hash.as_str(), "{v}");
    let urls: Vec<String> = t
        .get(&format!("/api/v1/torrents/{}/trackers", f.hash))
        .await["trackers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|x| x["url"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(
        urls,
        ["http://127.0.0.1:5/announce", "udp://127.0.0.1:6/announce"]
    );
    let (s, _) = patch(&t, json!({"add_trackers_url": null})).await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(t.get("/api/v1/app").await["fetched_trackers"], Value::Null);
    let (s, v) = t
        .call(Method::POST, "/api/v1/app/fetched-trackers/refresh", None)
        .await;
    assert_eq!(s, StatusCode::CONFLICT, "{v}");
    t.stop().await;
}
