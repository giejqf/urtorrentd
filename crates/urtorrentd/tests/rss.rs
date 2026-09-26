// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! RSS against a local feed server: feeds in folders, articles, read marks,
//! download rules (wildcards, the smart filter, repacks), conditional
//! requests, errors; and the client data store.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::extract::{Path, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::response::IntoResponse;
use common::{TestDaemon, fixture, settings};
use serde_json::{Value, json};

/// The feed's items (title, torrent number) and the `.torrent` files.
#[derive(Default)]
struct Feed {
    items: Vec<(String, u32)>,
    torrents: HashMap<u32, Vec<u8>>,
    /// Requests answered 304 (not modified).
    not_modified: u32,
}

type Shared = Arc<Mutex<Feed>>;

fn document(f: &Feed, addr: SocketAddr) -> String {
    let mut s = String::from(
        r#"<?xml version="1.0"?><rss version="2.0"><channel><title>Test indexer</title>"#,
    );
    // Newest first, as feeds list them.
    for (title, n) in f.items.iter().rev() {
        s.push_str(&format!(
            r#"<item><title>{title}</title><guid>item-{n}</guid><enclosure url="http://{addr}/t/{n}.torrent" type="application/x-bittorrent" length="1000"/></item>"#
        ));
    }
    s.push_str("</channel></rss>");
    s
}

async fn serve(feed: Shared) -> SocketAddr {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new()
        .route(
            "/feed.xml",
            axum::routing::get(
                move |State(f): State<Shared>, headers: HeaderMap| async move {
                    let mut f = f.lock().unwrap();
                    let doc = document(&f, addr);
                    let etag = format!("\"{}\"", doc.len());
                    if headers
                        .get(header::IF_NONE_MATCH)
                        .and_then(|v| v.to_str().ok())
                        == Some(&etag)
                    {
                        f.not_modified += 1;
                        return StatusCode::NOT_MODIFIED.into_response();
                    }
                    ([(header::ETAG, etag)], doc).into_response()
                },
            ),
        )
        .route(
            "/t/{file}",
            axum::routing::get(
                |State(f): State<Shared>, Path(file): Path<String>| async move {
                    let n: u32 = file.trim_end_matches(".torrent").parse().unwrap();
                    f.lock()
                        .unwrap()
                        .torrents
                        .get(&n)
                        .cloned()
                        .unwrap_or_default()
                },
            ),
        )
        .with_state(feed);
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    addr
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

fn titles(articles: &Value) -> Vec<String> {
    articles
        .as_array()
        .unwrap()
        .iter()
        .map(|a| a["title"].as_str().unwrap().to_string())
        .collect()
}

#[tokio::test]
async fn feeds_articles_and_download_rules() {
    let feed: Shared = Arc::default();
    let mut hashes = HashMap::new();
    for (n, title) in [
        (1, "Show.S01E01.1080p"),
        (2, "Show.S01E02.1080p"),
        (3, "Other.Thing.1080p"),
        (4, "Show.S01E02.REPACK.1080p"),
        (5, "Show.S01E03.1080p"),
        (6, "Show.S01E01.1080p.AGAIN"),
    ] {
        let f = fixture(
            &format!("rss{n}.bin"),
            &[(&format!("rss{n}.bin"), 20_000)],
            16_384,
            None,
            false,
            90 + n,
        );
        hashes.insert(n, f.hash.clone());
        let mut s = feed.lock().unwrap();
        s.torrents.insert(n, f.torrent);
        if n <= 3 {
            s.items.push((title.to_string(), n));
        }
    }
    let addr = serve(feed.clone()).await;
    let t = TestDaemon::start(77, |_| {}).await;

    // A feed in a folder: refreshed at once, even with rss_enabled off.
    let (s, f) = t
        .post(
            "/api/v1/rss/feeds",
            json!({"url": format!("http://{addr}/feed.xml"), "name": "Indexer", "folder": "tv/shows"}),
        )
        .await;
    assert_eq!(s, StatusCode::CREATED, "{f}");
    let id = f["id"].as_u64().unwrap();
    let path = format!("/api/v1/rss/feeds/{id}");
    let v = wait_get(&t, &path, "the first refresh", |v| {
        v["feed"]["articles"] == 3
    })
    .await;
    assert_eq!(v["feed"]["title"], "Test indexer");
    assert_eq!(v["feed"]["error"], Value::Null);
    assert_eq!(
        titles(&v["articles"]),
        [
            "Other.Thing.1080p",
            "Show.S01E02.1080p",
            "Show.S01E01.1080p"
        ],
        "newest first"
    );
    assert_eq!(
        v["articles"][0]["torrent_url"],
        format!("http://{addr}/t/3.torrent")
    );
    assert_eq!(v["articles"][0]["size"], 1000);
    assert_eq!(
        t.get("/api/v1/rss/folders").await,
        json!(["tv", "tv/shows"])
    );

    // Read marks.
    let (s, _) = t
        .post(&format!("{path}/read"), json!({"articles": ["item-3"]}))
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&path).await["feed"]["unread"], 2);
    let unread = t.get("/api/v1/rss/articles?unread=true").await;
    assert_eq!(unread.as_array().unwrap().len(), 2);
    // Unread again; every feed read at once; all unread again.
    let (s, _) = t
        .post(
            &format!("{path}/read"),
            json!({"articles": ["item-3"], "unread": true}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&path).await["feed"]["unread"], 3);
    let (s, _) = t
        .post("/api/v1/rss/feeds/read", json!({"feeds": "all"}))
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&path).await["feed"]["unread"], 0);
    let (s, _) = t
        .post(
            &format!("{path}/read"),
            json!({"articles": "all", "unread": true}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&path).await["feed"]["unread"], 3);
    let (s, v) = t
        .post("/api/v1/rss/feeds/read", json!({"feeds": [id, 999]}))
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{v}");
    assert_eq!(t.get(&path).await["feed"]["unread"], 3, "nothing marked");

    // A rule: what it would take (auto-download off: nothing is added).
    let rule = json!({
        "must_contain": "show 1080p",
        "must_not_contain": "720p",
        "smart_filter": true,
        "feeds": [id],
        "add_options": {"category": "tv", "stopped": true},
    });
    let (s, r) = t
        .call(Method::PUT, "/api/v1/rss/rules/shows", Some(rule.clone()))
        .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(r["enabled"], true);
    let m = t.get("/api/v1/rss/rules/shows/matches").await;
    assert_eq!(titles(&m), ["Show.S01E02.1080p", "Show.S01E01.1080p"]);
    assert_eq!(m[0]["matched_rule"], "shows");
    // Every article says which rule would take it.
    let all = t.get("/api/v1/rss/articles").await;
    let by_rule: Vec<(&str, &Value)> = all
        .as_array()
        .unwrap()
        .iter()
        .map(|a| (a["title"].as_str().unwrap(), &a["matched_rule"]))
        .collect();
    assert_eq!(
        by_rule,
        [
            ("Other.Thing.1080p", &Value::Null),
            ("Show.S01E02.1080p", &json!("shows")),
            ("Show.S01E01.1080p", &json!("shows")),
        ]
    );
    // A disabled rule matches nothing; an earlier name comes first.
    let mut first = rule.clone();
    first["must_contain"] = json!("s01e01");
    let (s, _) = t
        .call(Method::PUT, "/api/v1/rss/rules/aaa", Some(first.clone()))
        .await;
    assert_eq!(s, StatusCode::OK);
    let v = t.get(&path).await;
    assert_eq!(v["articles"][2]["matched_rule"], "aaa", "{v}");
    assert_eq!(v["articles"][1]["matched_rule"], "shows");
    first["enabled"] = json!(false);
    let (s, _) = t
        .call(Method::PUT, "/api/v1/rss/rules/aaa", Some(first))
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(t.get(&path).await["articles"][2]["matched_rule"], "shows");
    let (s, _) = t.call(Method::DELETE, "/api/v1/rss/rules/aaa", None).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert_eq!(t.get("/api/v1/torrents").await, json!([]));

    // Auto-download on: saving the rule runs it over the feed.
    let (s, _) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"rss_auto_download": true})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let (s, _) = t
        .call(Method::PUT, "/api/v1/rss/rules/shows", Some(rule.clone()))
        .await;
    assert_eq!(s, StatusCode::OK);
    wait_get(&t, "/api/v1/torrents", "two episodes", |v| {
        v.as_array().unwrap().len() == 2
    })
    .await;
    for n in [1, 2] {
        let x = t.torrent(&hashes[&n]).await;
        assert_eq!(x["category"], "tv", "{x}");
        assert_eq!(x["state"], "stopped");
    }
    let r = t.get("/api/v1/rss/rules").await[0].clone();
    assert_eq!(r["matched_episodes"], json!(["1x1", "1x2"]), "{r}");
    assert!(r["last_match"].as_u64().is_some());
    let v = t.get(&path).await;
    let downloaded: Vec<&str> = v["articles"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|a| a["downloaded"] == true)
        .map(|a| a["id"].as_str().unwrap())
        .collect();
    assert_eq!(downloaded, ["item-2", "item-1"]);

    // A dry run of a rule being edited: each article, what the rule would
    // do with it, and why its filters leave one. Nothing is saved.
    let (s, v) = t
        .post(
            "/api/v1/rss/dry-run",
            json!({"must_contain": "show 1080p", "must_not_contain": "e01", "feeds": [id]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let verdicts: Vec<(&str, &str, &Value)> = v
        .as_array()
        .unwrap()
        .iter()
        .map(|a| {
            (
                a["title"].as_str().unwrap(),
                a["verdict"].as_str().unwrap(),
                &a["reason"],
            )
        })
        .collect();
    assert_eq!(
        verdicts,
        [
            (
                "Other.Thing.1080p",
                "filtered",
                &json!("does not match: show")
            ),
            ("Show.S01E02.1080p", "taken", &Value::Null),
            (
                "Show.S01E01.1080p",
                "filtered",
                &json!("excluded by must not contain: e01")
            ),
        ]
    );
    let (s, _) = t
        .post(
            "/api/v1/rss/dry-run",
            json!({"must_contain": "(", "use_regex": true, "feeds": [id]}),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "a bad expression");
    assert_eq!(
        t.get("/api/v1/rss/rules").await.as_array().unwrap().len(),
        1,
        "nothing saved"
    );

    // New articles: a repack of episode 2 and episode 3 are taken, another
    // release of episode 1 is not (smart filter).
    {
        let mut f = feed.lock().unwrap();
        f.items.push(("Show.S01E02.REPACK.1080p".into(), 4));
        f.items.push(("Show.S01E03.1080p".into(), 5));
        f.items.push(("Show.S01E01.1080p.AGAIN".into(), 6));
    }
    let (s, _) = t.post(&format!("{path}/refresh"), json!({})).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    wait_get(&t, "/api/v1/torrents", "the new episodes", |v| {
        v.as_array().unwrap().len() == 4
    })
    .await;
    let (s, _) = t
        .call(
            Method::GET,
            &format!("/api/v1/torrents/{}", hashes[&6]),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "the same episode again");
    let r = t.get("/api/v1/rss/rules").await[0].clone();
    assert_eq!(
        r["matched_episodes"],
        json!(["1x1", "1x2", "1x2:repack", "1x3"])
    );

    // Unchanged: a conditional request, answered 304.
    let before = feed.lock().unwrap().not_modified;
    let (s, _) = t.post(&format!("{path}/refresh"), json!({})).await;
    assert_eq!(s, StatusCode::ACCEPTED);
    let deadline = Instant::now() + Duration::from_secs(20);
    while feed.lock().unwrap().not_modified == before {
        assert!(Instant::now() < deadline, "no conditional request");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // Every feed at once; an unknown one refreshes nothing.
    let (s, v) = t
        .post("/api/v1/rss/feeds/refresh", json!({"feeds": [999]}))
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{v}");
    let before = feed.lock().unwrap().not_modified;
    let (s, _) = t
        .post("/api/v1/rss/feeds/refresh", json!({"feeds": "all"}))
        .await;
    assert_eq!(s, StatusCode::ACCEPTED);
    let deadline = Instant::now() + Duration::from_secs(20);
    while feed.lock().unwrap().not_modified == before {
        assert!(Instant::now() < deadline, "no refresh of every feed");
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    // The rule's additions, in the main log with their torrents.
    let log = t.get("/api/v1/log?topics=rss").await;
    let added: Vec<&str> = log
        .as_array()
        .unwrap()
        .iter()
        .filter(|e| e["message"].as_str().unwrap().contains("added"))
        .map(|e| e["torrent"].as_str().unwrap())
        .collect();
    assert!(added.contains(&hashes[&1].as_str()), "{log}");
    assert!(log.as_array().unwrap().iter().all(|e| e["topic"] == "rss"));

    // Rules: rename, refusals, removal.
    let (s, r) = t
        .post(
            "/api/v1/rss/rules/shows/rename",
            json!({"name": "My shows"}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{r}");
    assert_eq!(t.get("/api/v1/rss/rules").await[0]["name"], "My shows");
    for bad in [
        json!({"must_contain": "(", "use_regex": true}),
        json!({"episode_filter": "x1;"}),
        json!({"feeds": [999]}),
        json!({"add_options": {"file_priorities": [9]}}),
    ] {
        let (s, v) = t
            .call(Method::PUT, "/api/v1/rss/rules/bad", Some(bad.clone()))
            .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{bad}: {v}");
    }
    let (s, _) = t
        .call(Method::DELETE, "/api/v1/rss/rules/My%20shows", None)
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(t.get("/api/v1/rss/rules").await, json!([]));

    // Feeds: refusals, a failing one, folders moved and removed.
    for (bad, code) in [
        (json!({"url": "ftp://x/feed"}), StatusCode::BAD_REQUEST),
        (
            json!({"url": format!("http://{addr}/feed.xml")}),
            StatusCode::CONFLICT,
        ),
        (
            json!({"url": "http://x/f", "folder": "a//b"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            json!({"url": "http://x/f", "refresh_interval": 5}),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let (s, v) = t.post("/api/v1/rss/feeds", bad.clone()).await;
        assert_eq!(s, code, "{bad}: {v}");
    }
    let (_, broken) = t
        .post(
            "/api/v1/rss/feeds",
            json!({"url": format!("http://{addr}/missing.xml")}),
        )
        .await;
    let broken_id = broken["id"].as_u64().unwrap();
    let v = wait_get(
        &t,
        &format!("/api/v1/rss/feeds/{broken_id}"),
        "the error",
        |v| v["feed"]["error"].is_string(),
    )
    .await;
    assert!(v["feed"]["error"].as_str().unwrap().contains("404"), "{v}");
    let (s, _) = t
        .post(
            "/api/v1/rss/folders/move",
            json!({"from": "tv", "to": "video"}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(t.get(&path).await["feed"]["folder"], "video/shows");
    assert_eq!(
        t.get("/api/v1/rss/folders").await,
        json!(["video", "video/shows"])
    );
    let (s, _) = t
        .post(
            "/api/v1/rss/folders/move",
            json!({"from": "video", "to": "video/x"}),
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);
    let (s, _) = t
        .post("/api/v1/rss/folders/remove", json!({"path": "video"}))
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let left: Vec<u64> = t
        .get("/api/v1/rss/feeds")
        .await
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["id"].as_u64().unwrap())
        .collect();
    assert_eq!(left, [broken_id], "the folder's feed went with it");
    let (s, _) = t.call(Method::GET, &path, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    t.stop().await;
}

#[tokio::test]
async fn the_client_data_store() {
    let t = TestDaemon::start(78, |_| {}).await;
    let (s, _) = t
        .call(
            Method::PATCH,
            "/api/v1/client-data",
            Some(json!({"ui.theme": "dark", "ui.columns": ["name", "size"], "n": 3})),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    assert_eq!(
        t.get("/api/v1/client-data?keys=ui.theme,missing").await,
        json!({"ui.theme": "dark"})
    );
    let (s, _) = t
        .call(
            Method::PATCH,
            "/api/v1/client-data",
            Some(json!({"n": null})),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    for bad in [json!({"": 1}), json!({"k": "x".repeat(70_000)})] {
        let (s, _) = t
            .call(Method::PATCH, "/api/v1/client-data", Some(bad))
            .await;
        assert_eq!(s, StatusCode::BAD_REQUEST);
    }
    // Kept across a restart.
    let dir = t.stop().await;
    let s = settings(78, &dir.path().join("downloads"));
    let t = TestDaemon::start_in(dir, 78, Some(s)).await;
    assert_eq!(
        t.get("/api/v1/client-data").await,
        json!({"ui.columns": ["name", "size"], "ui.theme": "dark"})
    );
    t.stop().await;
}
