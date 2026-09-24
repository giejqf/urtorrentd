// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! What leaves the daemon leaves from its listen address (urtorrent 0.13.4):
//! announces to an HTTP tracker and web-seed downloads come from the
//! daemon's `listen_v4`, and from the new one once the setting changes,
//! never from the address the default route would pick. A local server is
//! the tracker and the web seed, and records where each request came from.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, Path, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::{IntoResponse, Response};
use common::{Fixture, TestDaemon, fixture};
use serde_json::json;

/// Where requests came from: `(what, source address)` in arrival order;
/// `what` is `announce` or the web-seed file asked for.
type Seen = Arc<Mutex<Vec<(String, IpAddr)>>>;

#[derive(Clone)]
struct Server {
    seen: Seen,
    /// The web seed's files by name.
    files: Arc<Mutex<HashMap<String, Vec<u8>>>>,
}

async fn announce(State(s): State<Server>, ConnectInfo(from): ConnectInfo<SocketAddr>) -> Vec<u8> {
    s.seen.lock().unwrap().push(("announce".into(), from.ip()));
    b"d8:intervali1800e5:peers0:e".to_vec()
}

/// A web seed: whole files or `Range: bytes=a-b`.
async fn seed(
    State(s): State<Server>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    Path(name): Path<String>,
    headers: HeaderMap,
) -> Response {
    s.seen.lock().unwrap().push((name.clone(), from.ip()));
    let Some(body) = s.files.lock().unwrap().get(&name).cloned() else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("bytes="))
        .and_then(|v| v.split_once('-'))
        .and_then(|(a, b)| Some((a.parse::<usize>().ok()?, b.parse::<usize>().ok()?)));
    match range {
        Some((a, b)) if a <= b && b < body.len() => (
            StatusCode::PARTIAL_CONTENT,
            [(
                header::CONTENT_RANGE,
                format!("bytes {a}-{b}/{}", body.len()),
            )],
            body[a..=b].to_vec(),
        )
            .into_response(),
        Some(_) => StatusCode::RANGE_NOT_SATISFIABLE.into_response(),
        None => body.into_response(),
    }
}

async fn server() -> (SocketAddr, Server) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let s = Server {
        seen: Arc::default(),
        files: Arc::default(),
    };
    let app = axum::Router::new()
        .route("/announce", axum::routing::get(announce))
        .route("/seed/{name}", axum::routing::get(seed))
        .with_state(s.clone());
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    (addr, s)
}

fn blob(name: &str, tracker: SocketAddr, seed: u32) -> Fixture {
    fixture(
        name,
        &[(name, 70_000)],
        16_384,
        Some(&format!("http://{tracker}/announce")),
        false,
        seed,
    )
}

/// Add `f` (content served by the web seed only) and wait until it is
/// complete.
async fn fetch(t: &TestDaemon, srv: &Server, tracker: SocketAddr, f: &Fixture) -> String {
    srv.files
        .lock()
        .unwrap()
        .insert(f.name.clone(), f.files[0].1.clone());
    let hash = t.add(f, json!({})).await;
    let (s, v) = t
        .post(
            &format!("/api/v1/torrents/{hash}/webseeds"),
            json!({"urls": [format!("http://{tracker}/seed/")]}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT, "{v}");
    t.wait_for(&hash, "the web-seed download", 30, |v| v["progress"] == 1.0)
        .await;
    hash
}

async fn wait_seen(srv: &Server, what: &str, from: Ipv4Addr) {
    let deadline = Instant::now() + Duration::from_secs(30);
    while !srv
        .seen
        .lock()
        .unwrap()
        .iter()
        .any(|(w, ip)| *w == what && *ip == IpAddr::V4(from))
    {
        assert!(
            Instant::now() < deadline,
            "no {what} from {from}: {:?}",
            srv.seen.lock().unwrap()
        );
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test(flavor = "multi_thread")]
async fn trackers_and_web_seeds_leave_from_the_listen_address() {
    let (addr, srv) = server().await;
    let t = TestDaemon::start(86, |_| {}).await;
    let first = Ipv4Addr::new(127, 0, 0, 86);
    let second = Ipv4Addr::new(127, 0, 0, 87);

    // Unbound, these would come from 127.0.0.1 (the route to the server).
    fetch(&t, &srv, addr, &blob("one.bin", addr, 11)).await;
    wait_seen(&srv, "announce", first).await;
    wait_seen(&srv, "one.bin", first).await;

    // The listen address changes live; what follows leaves from the new
    // one: a reannounce, and a second torrent's announces and web seed.
    let (s, v) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"listen_v4": second.to_string()})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let (s, v) = t
        .post("/api/v1/torrents/reannounce", json!({"hashes": "all"}))
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    wait_seen(&srv, "announce", second).await;
    fetch(&t, &srv, addr, &blob("two.bin", addr, 12)).await;

    // Nothing ever came from anywhere else, and the second torrent's
    // content came from the new address only.
    let seen = srv.seen.lock().unwrap().clone();
    assert!(
        seen.iter()
            .all(|(_, ip)| *ip == IpAddr::V4(first) || *ip == IpAddr::V4(second)),
        "{seen:?}"
    );
    let two: Vec<&IpAddr> = seen
        .iter()
        .filter(|(w, _)| w == "two.bin")
        .map(|(_, ip)| ip)
        .collect();
    assert!(!two.is_empty(), "{seen:?}");
    assert!(two.iter().all(|ip| **ip == IpAddr::V4(second)), "{seen:?}");
    t.stop().await;
}
