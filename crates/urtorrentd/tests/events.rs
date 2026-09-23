// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The server-sent event stream over a real TCP connection (the in-process
//! harness cannot hold a stream open): the first event, pushed changes,
//! resuming with `Last-Event-ID`, and the end of the stream at shutdown.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::net::SocketAddr;
use std::time::Duration;

use common::{TestDaemon, fixture, validate_schema};
use serde_json::{Value, json};

/// One parsed server-sent event.
#[derive(Debug)]
struct Sse {
    id: Option<String>,
    event: Option<String>,
    data: Value,
}

/// Reads events off a streaming response.
struct Reader {
    resp: reqwest::Response,
    buf: String,
}

impl Reader {
    /// The next event, or `None` when the stream ends; panics after `secs`.
    async fn next(&mut self, secs: u64) -> Option<Sse> {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
        loop {
            while let Some(end) = self.buf.find("\n\n") {
                let block: String = self.buf.drain(..end + 2).collect();
                let (mut id, mut event, mut data) = (None, None, String::new());
                for line in block.lines() {
                    if let Some(v) = line.strip_prefix("id:") {
                        id = Some(v.trim().to_string());
                    } else if let Some(v) = line.strip_prefix("event:") {
                        event = Some(v.trim().to_string());
                    } else if let Some(v) = line.strip_prefix("data:") {
                        data.push_str(v.trim_start());
                    }
                }
                if data.is_empty() {
                    continue; // a keep-alive comment
                }
                return Some(Sse {
                    id,
                    event,
                    data: serde_json::from_str(&data).unwrap(),
                });
            }
            let chunk = tokio::time::timeout_at(deadline, self.resp.chunk())
                .await
                .expect("no event in time")
                .unwrap();
            match chunk {
                Some(bytes) => self.buf.push_str(&String::from_utf8_lossy(&bytes)),
                None => return None,
            }
        }
    }

    /// The next `sync` event whose data satisfies `pred`.
    async fn until(&mut self, what: &str, pred: impl Fn(&Value) -> bool) -> Sse {
        loop {
            let ev = self
                .next(10)
                .await
                .unwrap_or_else(|| panic!("stream ended before {what}"));
            assert_eq!(ev.event.as_deref(), Some("sync"));
            validate_schema("SyncResponse", &ev.data);
            assert_eq!(ev.id.as_deref(), Some(ev.data["rev"].to_string().as_str()));
            if pred(&ev.data) {
                return ev;
            }
        }
    }
}

async fn serve(t: &TestDaemon) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = urtorrentd::api::router(t.daemon.clone());
    tokio::spawn(async move {
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .await
        .unwrap();
    });
    addr
}

async fn open(addr: SocketAddr, last_id: Option<&str>) -> Reader {
    let mut req = reqwest::Client::new().get(format!("http://{addr}/api/v1/events"));
    if let Some(id) = last_id {
        req = req.header("Last-Event-ID", id);
    }
    let resp = req.send().await.unwrap();
    assert_eq!(resp.status().as_u16(), 200);
    assert!(
        resp.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream")
    );
    Reader {
        resp,
        buf: String::new(),
    }
}

#[tokio::test]
async fn changes_are_pushed_and_streams_resume() {
    let t = TestDaemon::start(57, |_| {}).await;
    let addr = serve(&t).await;

    // At once: everything.
    let mut r = open(addr, None).await;
    let first = r.until("the first event", |_| true).await;
    assert_eq!(first.data["full"], true);
    assert_eq!(first.data["torrents"], json!({}));

    // A change arrives without asking.
    let f = fixture(
        "pushed.iso",
        &[("pushed.iso", 40_000)],
        16_384,
        None,
        false,
        101,
    );
    let hash = t.add(&f, json!({"stopped": true})).await;
    let ev = r
        .until("the new torrent", |d| d["torrents"].get(&hash).is_some())
        .await;
    assert_eq!(ev.data["full"], false);
    let last_id = ev.id.clone().unwrap();
    drop(r);

    // Reconnecting with the last id resumes: only what changed since.
    let (s, _) = t
        .post(
            "/api/v1/torrents/tags",
            json!({"hashes": [hash.clone()], "mode": "add", "tags": ["live"]}),
        )
        .await;
    assert_eq!(s.as_u16(), 200);
    let mut r = open(addr, Some(&last_id)).await;
    let ev = r
        .until("the tag change", |d| {
            d["torrents"]
                .get(&hash)
                .is_some_and(|x| x["tags"] == json!(["live"]))
        })
        .await;
    assert_eq!(ev.data["full"], false, "resumed, not restarted");
    assert_eq!(ev.data["tags"], json!(["live"]), "the tag list changed");

    // An id the daemon no longer knows gets everything.
    let mut stale = open(addr, Some("999999")).await;
    let ev = stale.until("a full state", |_| true).await;
    assert_eq!(ev.data["full"], true);
    assert!(ev.data["torrents"].get(&hash).is_some());

    // A removal is pushed as such.
    let (s, _) = t
        .post("/api/v1/torrents/delete", json!({"hashes": [hash.clone()]}))
        .await;
    assert_eq!(s.as_u16(), 200);
    r.until("the removal", |d| {
        d["torrents_removed"] == json!([hash.clone()])
    })
    .await;

    // Shutdown ends open streams (the HTTP server's graceful shutdown
    // would wait for them otherwise).
    t.daemon.request_shutdown();
    let end = tokio::time::timeout(Duration::from_secs(5), async {
        while r.next(5).await.is_some() {}
    })
    .await;
    assert!(end.is_ok(), "the stream did not end at shutdown");
    t.stop().await;
}
