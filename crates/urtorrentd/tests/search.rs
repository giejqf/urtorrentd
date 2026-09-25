// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Search over the managed torrents, on a real daemon: the list filtered by
//! name, category, tag, tracker host or info-hash prefix, and file names
//! searched across torrents (kept current through renames, priority
//! changes and removals).

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use axum::http::{Method, StatusCode};
use common::{Fixture, TestDaemon, fixture};
use serde_json::{Value, json};

/// Three torrents: one with no content on disk (downloading), two complete
/// (seeding), in two categories, with tags and trackers that never work.
struct Library {
    ubuntu: String,
    show: String,
    notes: String,
}

fn fixtures() -> (Fixture, Fixture, Fixture) {
    let ubuntu = fixture(
        "Ubuntu 24.04 Desktop",
        &[
            ("ubuntu-24.04-desktop-amd64.iso", 40_000),
            ("SHA256SUMS", 100),
        ],
        16_384,
        Some("http://localhost:1/announce"),
        false,
        1,
    );
    let show = fixture(
        "Show.S01.1080p",
        &[
            ("Show.S01E01.mkv", 30_000),
            ("Show.S01E02.mkv", 30_000),
            ("Show.S01E02.en.srt", 500),
        ],
        16_384,
        Some("udp://127.0.0.1:1/announce"),
        false,
        2,
    );
    let notes = fixture("notes.txt", &[("notes.txt", 1_000)], 16_384, None, false, 3);
    (ubuntu, show, notes)
}

async fn library(t: &TestDaemon) -> Library {
    let (ubuntu, show, notes) = fixtures();
    show.write_to(&t.save_path());
    notes.write_to(&t.save_path());
    for c in ["linux", "tv"] {
        let (s, v) = t
            .post(
                "/api/v1/categories",
                json!({"name": c, "save_path": null, "download_path": null}),
            )
            .await;
        assert_eq!(s, StatusCode::NO_CONTENT, "{v}");
    }
    let lib = Library {
        ubuntu: t
            .add(&ubuntu, json!({"category": "linux", "tags": ["iso"]}))
            .await,
        show: t
            .add(&show, json!({"category": "tv", "tags": ["weekly", "hd"]}))
            .await,
        notes: t.add(&notes, json!({"rename": "My Notes"})).await,
    };
    for h in [&lib.show, &lib.notes] {
        t.wait_for(h, "seeding", 30, |v| v["state"] == "seeding")
            .await;
    }
    lib
}

const UBUNTU: &str = "Ubuntu 24.04 Desktop";
const SHOW: &str = "Show.S01.1080p";
const NOTES: &str = "My Notes";
const NONE: [&str; 0] = [];

async fn names(t: &TestDaemon, query: &str) -> Vec<String> {
    let mut v: Vec<String> = t
        .get(&format!("/api/v1/torrents?{query}"))
        .await
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["name"].as_str().unwrap().to_string())
        .collect();
    v.sort();
    v
}

async fn files(t: &TestDaemon, query: &str) -> Value {
    t.get(&format!("/api/v1/torrents/files?{query}")).await
}

fn paths(v: &Value) -> Vec<&str> {
    v["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f["path"].as_str().unwrap())
        .collect()
}

#[tokio::test(flavor = "multi_thread")]
async fn list_search() {
    let t = TestDaemon::start(84, |_| {}).await;
    let lib = library(&t).await;

    // The name, case ignored; every word must match.
    assert_eq!(names(&t, "search=ubuntu").await, [UBUNTU]);
    assert_eq!(names(&t, "search=UBUNTU%20desktop").await, [UBUNTU]);
    assert_eq!(names(&t, "search=ubuntu%20xyz").await, NONE);
    // A display-name override is what is searched.
    assert_eq!(names(&t, "search=my%20notes").await, [NOTES]);
    assert_eq!(names(&t, "search=notes.txt").await, NONE);
    // Wildcards: `*` any text, `?` one character; `.` is literal.
    assert_eq!(names(&t, "search=S01*1080p").await, [SHOW]);
    assert_eq!(names(&t, "search=24.0?").await, [UBUNTU]);
    assert_eq!(names(&t, "search=24x04").await, NONE);
    // Category and tags.
    assert_eq!(names(&t, "search=linux").await, [UBUNTU]);
    assert_eq!(names(&t, "search=weekly").await, [SHOW]);
    // Every word must match the same torrent (ubuntu's name, show's
    // category: none).
    assert_eq!(names(&t, "search=ubuntu%20tv").await, NONE);
    assert_eq!(names(&t, "search=show%20tv%20hd").await, [SHOW]);
    // A tracker's host, even though that tracker never works.
    let row = &t.get("/api/v1/torrents?search=localhost").await[0];
    assert_eq!(row["name"], UBUNTU);
    assert_eq!(row["tracker"], Value::Null);
    // List rows carry every tracker's host (never the URL), and the list
    // filters by host (`""`: torrents without trackers).
    assert_eq!(row["tracker_hosts"], json!(["localhost"]));
    let show_row = t.torrent(&lib.show).await;
    assert_eq!(show_row["tracker_hosts"], json!(["127.0.0.1"]));
    assert_eq!(t.torrent(&lib.notes).await["tracker_hosts"], json!([]));
    assert_eq!(names(&t, "tracker=localhost").await, [UBUNTU]);
    assert_eq!(names(&t, "tracker=LOCALHOST").await, [UBUNTU]);
    assert_eq!(names(&t, "tracker=127.0.0.1").await, [SHOW]);
    assert_eq!(names(&t, "tracker=").await, [NOTES]);
    assert_eq!(names(&t, "tracker=example.org").await, NONE);
    // Only the info-hashes, filtered as the list is.
    let hashes = t.get("/api/v1/torrents/hashes?search=s01%20tv").await;
    assert_eq!(hashes, json!([lib.show]));
    let mut all: Vec<String> =
        serde_json::from_value(t.get("/api/v1/torrents/hashes").await).unwrap();
    all.sort();
    let mut expected = vec![lib.ubuntu.clone(), lib.show.clone(), lib.notes.clone()];
    expected.sort();
    assert_eq!(all, expected);
    assert_eq!(
        t.get("/api/v1/torrents/hashes?tracker=&filter=seeding")
            .await,
        json!([lib.notes])
    );
    // The start of an info-hash (6 hex digits or more).
    assert_eq!(
        names(&t, &format!("search={}", &lib.show[..8])).await,
        [SHOW]
    );
    assert_eq!(
        names(&t, &format!("search={}", lib.notes.to_ascii_uppercase())).await,
        [NOTES]
    );
    // Together with the other filters.
    assert_eq!(names(&t, "search=s01&category=linux").await, NONE);
    assert_eq!(names(&t, "search=s01&filter=seeding").await, [SHOW]);
    assert_eq!(names(&t, "search=").await.len(), 3);
    assert_eq!(names(&t, "search=%20%20").await.len(), 3);

    // Too many words.
    let many = vec!["a"; 17].join("%20");
    let (s, v) = t
        .call(
            Method::GET,
            &format!("/api/v1/torrents?search={many}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST, "{v}");
    assert_eq!(v["error"]["code"], "bad_request");
    t.stop().await;
}

#[tokio::test(flavor = "multi_thread")]
async fn file_search() {
    let t = TestDaemon::start(85, |_| {}).await;
    let lib = library(&t).await;
    // A magnet without metadata has no files yet (and breaks nothing).
    let (s, v) = t
        .post(
            "/api/v1/torrents",
            json!({"urls": [format!("magnet:?xt=urn:btih:{}", "ab".repeat(20))]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["failed"], json!([]), "{v}");

    // Every file: torrents by display name ("My Notes", "Show...",
    // "Ubuntu..."), files in their order.
    let all = files(&t, "").await;
    assert_eq!(all["total"], 6);
    assert_eq!(
        paths(&all),
        [
            "notes.txt",
            "Show.S01.1080p/Show.S01E01.mkv",
            "Show.S01.1080p/Show.S01E02.mkv",
            "Show.S01.1080p/Show.S01E02.en.srt",
            "Ubuntu 24.04 Desktop/ubuntu-24.04-desktop-amd64.iso",
            "Ubuntu 24.04 Desktop/SHA256SUMS",
        ]
    );
    let first = &all["files"][0];
    assert_eq!(first["hash"], lib.notes.as_str());
    assert_eq!(first["torrent"], "My Notes");
    assert_eq!(first["index"], 0);
    assert_eq!(first["size"], 1_000);
    assert_eq!(first["progress"], 1.0);
    let iso = &all["files"][4];
    assert_eq!(iso["hash"], lib.ubuntu.as_str());
    assert_eq!(iso["index"], 0);
    assert_eq!(iso["progress"], 0.0);
    // The same priority as the torrent's own file list shows.
    let listed = t
        .get(&format!("/api/v1/torrents/{}/files", lib.ubuntu))
        .await;
    assert_eq!(iso["priority"], listed[0]["priority"]);

    // Words, wildcards, case.
    let mkv = files(&t, "search=mkv").await;
    assert_eq!(mkv["total"], 2);
    assert!(
        mkv["files"]
            .as_array()
            .unwrap()
            .iter()
            .all(|f| { f["hash"] == lib.show.as_str() && f["torrent"] == SHOW })
    );
    assert_eq!(files(&t, "search=s01e02").await["total"], 2);
    assert_eq!(
        paths(&files(&t, "search=S01E0?%20mkv").await),
        [
            "Show.S01.1080p/Show.S01E01.mkv",
            "Show.S01.1080p/Show.S01E02.mkv"
        ]
    );
    assert_eq!(
        paths(&files(&t, "search=*.iso").await),
        ["Ubuntu 24.04 Desktop/ubuntu-24.04-desktop-amd64.iso"]
    );
    // The torrent's folder is part of the path.
    assert_eq!(files(&t, "search=desktop").await["total"], 2);
    assert_eq!(files(&t, "search=nothing-like-this").await["total"], 0);

    // Paging: `total` counts every match.
    let page = files(&t, "limit=2&offset=1").await;
    assert_eq!(page["total"], 6);
    assert_eq!(
        paths(&page),
        [
            "Show.S01.1080p/Show.S01E01.mkv",
            "Show.S01.1080p/Show.S01E02.mkv"
        ]
    );
    assert_eq!(files(&t, "offset=10").await["files"], json!([]));

    // One torrent.
    let one = files(&t, &format!("hash={}", lib.ubuntu)).await;
    assert_eq!(one["total"], 2);
    let zeros = "0".repeat(40);
    for (query, status) in [
        (format!("hash={zeros}"), StatusCode::NOT_FOUND),
        ("hash=xyz".to_string(), StatusCode::BAD_REQUEST),
        ("limit=0".to_string(), StatusCode::BAD_REQUEST),
        ("limit=1001".to_string(), StatusCode::BAD_REQUEST),
    ] {
        let (s, v) = t
            .call(
                Method::GET,
                &format!("/api/v1/torrents/files?{query}"),
                None,
            )
            .await;
        assert_eq!(s, status, "{query}: {v}");
    }

    // A file renamed: found by its new name only.
    let (s, v) = t
        .post(
            &format!("/api/v1/torrents/{}/files/rename", lib.show),
            json!({
                "old_path": "Show.S01.1080p/Show.S01E01.mkv",
                "new_path": "Show.S01.1080p/Pilot.mkv"
            }),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT, "{v}");
    assert_eq!(files(&t, "search=s01e01").await["total"], 0);
    let pilot = files(&t, "search=pilot").await;
    assert_eq!(paths(&pilot), ["Show.S01.1080p/Pilot.mkv"]);
    assert_eq!(pilot["files"][0]["index"], 0);
    assert_eq!(pilot["files"][0]["progress"], 1.0);
    // A folder renamed: every file under it.
    let (s, v) = t
        .post(
            &format!("/api/v1/torrents/{}/folders/rename", lib.show),
            json!({"old_path": "Show.S01.1080p", "new_path": "Season 1"}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT, "{v}");
    assert_eq!(
        paths(&files(&t, "search=season").await),
        [
            "Season 1/Pilot.mkv",
            "Season 1/Show.S01E02.mkv",
            "Season 1/Show.S01E02.en.srt"
        ]
    );
    assert_eq!(files(&t, "search=1080p").await["total"], 0);

    // A priority change shows at once.
    let (s, _) = t
        .post(
            &format!("/api/v1/torrents/{}/files/priority", lib.ubuntu),
            json!({"indexes": [1], "priority": 0}),
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let sums = files(&t, "search=sha256").await;
    assert_eq!(sums["files"][0]["priority"], 0);
    assert_eq!(sums["files"][0]["index"], 1);

    // A removed torrent's files are gone.
    let (s, v) = t
        .post(
            "/api/v1/torrents/delete",
            json!({"hashes": [lib.notes.clone()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(files(&t, "search=notes").await["total"], 0);
    assert_eq!(files(&t, "").await["total"], 5);
    t.stop().await;
}
