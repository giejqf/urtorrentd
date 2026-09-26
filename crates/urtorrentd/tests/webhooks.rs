// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Webhooks (run-on-completion as HTTP calls): signed deliveries of a
//! torrent's added / finished / moved / removed events to a local receiver,
//! retries, redirects not followed, the test call, and persistence.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::http::{HeaderMap, Method, StatusCode};
use common::{TestDaemon, fixture, settings};
use hmac::{Hmac, Mac};
use serde_json::{Value, json};
use sha2::Sha256;

/// What the receiver got: (path, headers, body, the body's bytes).
type Got = Arc<Mutex<Vec<(String, HeaderMap, Value, Vec<u8>)>>>;

/// `/ok` answers 200, `/flaky` 500 then 200, `/moved` a redirect to `/ok`.
async fn receiver() -> (SocketAddr, Got) {
    let got: Got = Arc::default();
    let flaky = Arc::new(Mutex::new(0u32));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let record = |path: &'static str, got: Got| {
        move |headers: HeaderMap, body: axum::body::Bytes| {
            let got = got.clone();
            async move {
                let v: Value = serde_json::from_slice(&body).unwrap();
                got.lock()
                    .unwrap()
                    .push((path.to_string(), headers, v, body.to_vec()));
            }
        }
    };
    let app = axum::Router::new()
        .route("/ok", axum::routing::post(record("/ok", got.clone())))
        .route(
            "/flaky",
            axum::routing::post({
                let got = got.clone();
                move |headers: HeaderMap, body: axum::body::Bytes| {
                    let (got, flaky) = (got.clone(), flaky.clone());
                    async move {
                        let v: Value = serde_json::from_slice(&body).unwrap();
                        got.lock()
                            .unwrap()
                            .push(("/flaky".into(), headers, v, body.to_vec()));
                        let mut n = flaky.lock().unwrap();
                        *n += 1;
                        if *n == 1 {
                            StatusCode::INTERNAL_SERVER_ERROR
                        } else {
                            StatusCode::OK
                        }
                    }
                }
            }),
        )
        .route(
            "/moved",
            axum::routing::post(|| async {
                (StatusCode::FOUND, [(axum::http::header::LOCATION, "/ok")])
            }),
        );
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    (addr, got)
}

fn events(got: &Got, path: &str, hash: &str) -> Vec<String> {
    got.lock()
        .unwrap()
        .iter()
        .filter(|(p, _, v, _)| p == path && v["hash"] == hash)
        .map(|(_, _, v, _)| v["event"].as_str().unwrap().to_string())
        .collect()
}

async fn wait(what: &str, secs: u64, pred: impl Fn() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(secs);
    while !pred() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

fn verify(headers: &HeaderMap, body: &[u8], secret: &str) {
    let ts = headers["x-urtorrentd-timestamp"].to_str().unwrap();
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap();
    mac.update(format!("{ts}.").as_bytes());
    mac.update(body);
    let want: String = mac
        .finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect();
    assert_eq!(
        headers["x-urtorrentd-signature"].to_str().unwrap(),
        format!("sha256={want}")
    );
}

#[tokio::test]
async fn torrent_events_are_posted_to_webhooks() {
    let (addr, got) = receiver().await;
    let seeder = TestDaemon::start(73, |_| {}).await;
    let staging = tempfile::tempdir().unwrap();
    let staging_path = staging.path().to_string_lossy().into_owned();
    let leecher = TestDaemon::start(74, |s| s.download_path = Some(staging_path.clone())).await;

    // A signed webhook for every event; its secret is never shown.
    let (s, hook) = leecher
        .post(
            "/api/v1/webhooks",
            json!({"url": format!("http://{addr}/ok"), "name": "arr", "secret": "s3cret"}),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{hook}");
    assert_eq!(hook["has_secret"], true);
    assert!(!hook.to_string().contains("s3cret"));
    let id = hook["id"].as_u64().unwrap();
    let (s, d) = leecher
        .post(&format!("/api/v1/webhooks/{id}/test"), json!({}))
        .await;
    assert_eq!(s, StatusCode::OK, "{d}");
    assert_eq!(d["status"], 200, "{d}");
    assert_eq!(d["error"], Value::Null);
    {
        let g = got.lock().unwrap();
        let (_, headers, body, raw) = g.last().unwrap();
        assert_eq!(body["event"], "test");
        assert_eq!(headers["x-urtorrentd-event"], "test");
        assert_eq!(
            headers["x-urtorrentd-delivery"],
            body["delivery"].as_str().unwrap()
        );
        verify(headers, raw, "s3cret");
    }

    // Download, finish in the staging directory, move to the save path.
    let f = fixture(
        "hooked.bin",
        &[("hooked.bin", 300_000)],
        16_384,
        None,
        false,
        71,
    );
    f.write_to(&seeder.save_path());
    let hash = seeder.add(&f, json!({})).await;
    seeder
        .wait_for(&hash, "seeding", 30, |x| x["state"] == "seeding")
        .await;
    leecher.add(&f, json!({"category": "linux"})).await;
    let (s, _) = leecher
        .post(
            "/api/v1/torrents/peers",
            json!({"hashes": [hash.clone()], "peers": [seeder.peer_addr()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    wait("added, finished, moved", 60, || {
        events(&got, "/ok", &hash) == ["added", "finished", "moved"]
    })
    .await;
    let save = leecher.save_path().to_string_lossy().into_owned();
    {
        let g = got.lock().unwrap();
        let of = |e: &str| {
            g.iter()
                .find(|(_, _, v, _)| v["hash"] == hash.as_str() && v["event"] == e)
                .unwrap()
                .clone()
        };
        let (_, headers, added, raw) = of("added");
        verify(&headers, &raw, "s3cret");
        assert_eq!(added["torrent"]["name"], "hooked.bin");
        assert_eq!(added["torrent"]["category"], "linux");
        let (_, _, finished, _) = of("finished");
        assert_eq!(finished["torrent"]["complete"], true);
        let (_, _, moved, _) = of("moved");
        assert_eq!(moved["detail"], save.as_str(), "{moved}");
    }

    // A flaky endpoint is retried; the removal carries the torrent's row.
    let (s, flaky) = leecher
        .post(
            "/api/v1/webhooks",
            json!({"url": format!("http://{addr}/flaky"), "events": ["removed"]}),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    let flaky_id = flaky["id"].as_u64().unwrap();
    // One that fails for good (a redirect is not followed, nor retried).
    let (s, relay) = leecher
        .post(
            "/api/v1/webhooks",
            json!({"url": format!("http://{addr}/moved?token=x"), "name": "Relay", "events": ["removed"]}),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED);
    let (s, _) = leecher
        .post("/api/v1/torrents/delete", json!({"hashes": [hash.clone()]}))
        .await;
    assert_eq!(s, StatusCode::OK);
    wait("removed", 20, || {
        events(&got, "/ok", &hash).last().map(String::as_str) == Some("removed")
            && events(&got, "/flaky", &hash).len() == 2
    })
    .await;
    // The failure is in the main log, about the torrent, without the URL.
    let deadline = Instant::now() + Duration::from_secs(10);
    let failed = loop {
        let log = leecher.get("/api/v1/log?topics=webhooks").await;
        if let Some(e) = log.as_array().unwrap().first() {
            break e.clone();
        }
        assert!(Instant::now() < deadline, "no failure logged");
        tokio::time::sleep(Duration::from_millis(100)).await;
    };
    assert_eq!(failed["level"], "warning");
    assert_eq!(failed["torrent"], hash.as_str());
    let msg = failed["message"].as_str().unwrap();
    assert!(msg.contains("\"Relay\""), "{msg}");
    assert!(
        msg.contains("removed delivery failed after 1 attempt"),
        "{msg}"
    );
    assert!(
        !msg.contains("token") && !msg.contains(&addr.to_string()),
        "{msg}"
    );
    let (s, _) = leecher
        .call(
            Method::DELETE,
            &format!("/api/v1/webhooks/{}", relay["id"]),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let removed = got
        .lock()
        .unwrap()
        .iter()
        .find(|(p, _, v, _)| p == "/ok" && v["event"] == "removed")
        .unwrap()
        .2
        .clone();
    assert_eq!(removed["torrent"]["name"], "hooked.bin", "{removed}");
    let flaky = leecher.get(&format!("/api/v1/webhooks/{flaky_id}")).await;
    assert_eq!(flaky["deliveries"][0]["attempts"], 2, "{flaky}");
    assert_eq!(flaky["deliveries"][0]["status"], 200);
    assert_eq!(flaky["has_secret"], false);

    // What a delivery sent can be read back, and sent again as it was.
    let hook_now = leecher.get(&format!("/api/v1/webhooks/{id}")).await;
    let delivery = hook_now["deliveries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["event"] == "removed")
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_string();
    let sent = leecher
        .get(&format!("/api/v1/webhooks/{id}/deliveries/{delivery}"))
        .await;
    assert_eq!(sent, removed);
    let before = got.lock().unwrap().len();
    let (s, d) = leecher
        .post(
            &format!("/api/v1/webhooks/{id}/deliveries/{delivery}/redeliver"),
            json!({}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{d}");
    assert_eq!(d["status"], 200, "{d}");
    assert_eq!(d["id"], delivery.as_str());
    {
        let g = got.lock().unwrap();
        assert_eq!(g.len(), before + 1);
        let (_, headers, body, raw) = g.last().unwrap();
        assert_eq!(body, &removed);
        assert_eq!(headers["x-urtorrentd-delivery"], delivery.as_str());
        verify(headers, raw, "s3cret");
    }
    let listed = leecher.get(&format!("/api/v1/webhooks/{id}")).await;
    assert_eq!(listed["deliveries"][0]["id"], delivery.as_str());
    let (s, _) = leecher
        .call(
            Method::GET,
            &format!("/api/v1/webhooks/{id}/deliveries/nope"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);

    // Redirects are not followed, nor retried.
    let (_, moved) = leecher
        .post(
            "/api/v1/webhooks",
            json!({"url": format!("http://{addr}/moved"), "events": ["test"]}),
        )
        .await;
    let moved_id = moved["id"].as_u64().unwrap();
    let (_, d) = leecher
        .post(&format!("/api/v1/webhooks/{moved_id}/test"), json!({}))
        .await;
    assert_eq!(d["status"], 302, "{d}");
    assert_eq!(d["attempts"], 1);
    assert!(d["error"].as_str().is_some());

    // Changes, removal, refusals.
    let (s, v) = leecher
        .call(
            Method::PATCH,
            &format!("/api/v1/webhooks/{id}"),
            Some(json!({"secret": null, "enabled": false, "events": ["finished", "moved"]})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["has_secret"], false);
    assert_eq!(v["enabled"], false);
    assert_eq!(v["events"], json!(["finished", "moved"]));
    let (s, _) = leecher
        .call(
            Method::DELETE,
            &format!("/api/v1/webhooks/{moved_id}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, _) = leecher
        .call(Method::GET, &format!("/api/v1/webhooks/{moved_id}"), None)
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    for bad in [
        json!({"url": "ftp://example.org/"}),
        json!({"url": "http://example.org/", "command": "rm -rf /"}),
        json!({"url": "http://example.org/", "events": ["exploded"]}),
        json!({"url": "http://example.org/", "secret": ""}),
    ] {
        let (s, v) = leecher.post("/api/v1/webhooks", bad.clone()).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{bad}: {v}");
    }

    // They survive a restart (the secret too).
    let (s, _) = leecher
        .call(
            Method::PATCH,
            &format!("/api/v1/webhooks/{flaky_id}"),
            Some(json!({"secret": "again"})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let dir = leecher.stop().await;
    let s = settings(74, &dir.path().join("downloads"));
    let leecher = TestDaemon::start_in(dir, 74, Some(s)).await;
    let hooks = leecher.get("/api/v1/webhooks").await;
    let hooks = hooks.as_array().unwrap();
    assert_eq!(hooks.len(), 2, "{hooks:?}");
    assert_eq!(hooks[0]["enabled"], false);
    assert_eq!(hooks[1]["has_secret"], true);
    assert_eq!(hooks[1]["deliveries"], json!([]), "deliveries are not kept");
    leecher.stop().await;
    seeder.stop().await;
}
