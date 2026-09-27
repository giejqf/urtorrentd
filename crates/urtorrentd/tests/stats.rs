// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Statistics (ADR 0005) on real engines: recorded traffic adds up to the
//! library's counters, history outlives torrents and restarts, recording can
//! be turned off, and a broken `stats.db` does not stop the daemon.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use common::{TestDaemon, fixture, settings};
use serde_json::{Value, json};

fn sum(points: &Value, field: &str) -> u64 {
    points
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p[field].as_u64().unwrap())
        .sum()
}

/// Poll `GET path` until `pred` holds (statistics follow the 2 s tick).
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

fn kinds(timeline: &Value) -> Vec<String> {
    timeline
        .as_array()
        .unwrap()
        .iter()
        .map(|e| match e["kind"].as_str().unwrap() {
            "state" => format!("state:{}", e["state"].as_str().unwrap()),
            k => k.to_string(),
        })
        .collect()
}

#[tokio::test]
async fn a_transfer_is_recorded_and_adds_up() {
    let seeder = TestDaemon::start(61, |_| {}).await;
    let leecher = TestDaemon::start(62, |_| {}).await;
    let f = fixture(
        "stats.bin",
        &[("stats.bin", 400_000)],
        16_384,
        None,
        false,
        31,
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

    // Per torrent, every step adds up to the library's counter (the torrent
    // was added in this run, so its all-time counter is what was observed).
    let traffic = format!("/api/v1/stats/torrents/{hash}/traffic");
    let t = seeder
        .wait_for(&hash, "the upload counted", 30, |x| {
            x["uploaded"].as_u64().unwrap() >= 400_000
        })
        .await;
    let up = t["uploaded"].as_u64().unwrap();
    let v = wait_get(
        &seeder,
        &format!("{traffic}?step=minute"),
        "minutes add up",
        |v| sum(&v["points"], "uploaded") == up,
    )
    .await;
    assert_eq!(v["step"], "minute");
    assert_eq!(v["name"], "stats.bin");
    assert_eq!(v["removed"], Value::Null);
    // Maxima are sampled every 2 s: a loopback transfer can finish, and
    // its peer leave, between two samples.
    assert!(v["points"][0]["peers_max"].as_u64().is_some(), "{v}");
    let periods = v["periods"].as_array().unwrap();
    assert_eq!(periods.len(), 1, "{v}");
    assert_eq!(periods[0]["ended"], Value::Null);
    assert_eq!(periods[0]["clean"], true);
    let hours = seeder.get(&format!("{traffic}?step=hour")).await;
    assert_eq!(sum(&hours["points"], "uploaded"), up, "{hours}");
    let days = seeder
        .get(&format!("/api/v1/stats/torrents/{hash}/days"))
        .await;
    assert_eq!(sum(&days["days"], "uploaded"), up, "{days}");
    let today = days["days"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(today["uploaded_total"].as_u64().unwrap(), up, "{today}");
    assert!(today["seeding_time_total"].as_u64().is_some());
    // The default step is the finest kept for the range.
    assert_eq!(seeder.get(&traffic).await["step"], "minute");

    let down = leecher.torrent(&hash).await["downloaded"].as_u64().unwrap();
    wait_get(
        &leecher,
        &format!("{traffic}?step=minute"),
        "leecher minutes",
        |v| sum(&v["points"], "downloaded") == down,
    )
    .await;

    // The session as a whole.
    let transfer = seeder.get("/api/v1/transfer").await;
    let session_up = transfer["uploaded_session"].as_u64().unwrap();
    assert!(session_up >= up);
    let v = wait_get(&seeder, "/api/v1/stats/transfer", "session minutes", |v| {
        sum(&v["points"], "uploaded") >= session_up
    })
    .await;
    assert!(
        v["points"]
            .as_array()
            .unwrap()
            .iter()
            .any(|p| p["torrents_max"] == 1)
    );

    // Rankings.
    let top = seeder.get("/api/v1/stats/top").await;
    assert_eq!(top["torrents"][0]["hash"], hash.as_str(), "{top}");
    assert_eq!(top["torrents"][0]["uploaded"].as_u64().unwrap(), up);
    let top = leecher.get("/api/v1/stats/top?by=downloaded&limit=1").await;
    assert_eq!(top["torrents"][0]["downloaded"].as_u64().unwrap(), down);

    // The timeline, then history that outlives the torrent.
    let tl = leecher
        .get(&format!("/api/v1/stats/timeline?hash={hash}"))
        .await;
    let k = kinds(&tl);
    assert!(k.contains(&"added".to_string()), "{tl}");
    assert!(k.contains(&"finished".to_string()), "{tl}");
    let (s, _) = leecher
        .post("/api/v1/torrents/delete", json!({"hashes": [hash.clone()]}))
        .await;
    assert_eq!(s, StatusCode::OK);
    let tl = leecher.get("/api/v1/stats/timeline").await;
    assert_eq!(kinds(&tl)[0], "removed", "{tl}");
    let gone = leecher.get(&format!("{traffic}?step=minute")).await;
    assert!(gone["removed"].as_u64().is_some(), "{gone}");
    assert_eq!(sum(&gone["points"], "downloaded"), down);
    let top = leecher.get("/api/v1/stats/top?by=downloaded").await;
    assert!(top["torrents"][0]["removed"].as_u64().is_some(), "{top}");
    let (s, _) = leecher
        .call(
            Method::DELETE,
            &format!("/api/v1/stats/torrents/{hash}"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let (s, v) = leecher.call(Method::GET, &traffic, None).await;
    assert_eq!(s, StatusCode::NOT_FOUND, "{v}");

    // Refused queries.
    for bad in [
        format!("{traffic}?step=minute&from=0"),
        format!("{traffic}?from=10&to=5"),
        "/api/v1/stats/torrents/xyz/traffic".to_string(),
        "/api/v1/stats/top?limit=0".to_string(),
        "/api/v1/stats/timeline?limit=20000".to_string(),
    ] {
        let (s, v) = seeder.call(Method::GET, &bad, None).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{bad}: {v}");
    }

    let info = seeder.get("/api/v1/stats").await;
    assert_eq!(info["enabled"], true);
    assert_eq!(info["torrents"], 1);
    assert!(info["oldest_minute"].as_u64().is_some(), "{info}");
    assert!(info["size"].as_u64().unwrap() > 0);
    leecher.stop().await;
    seeder.stop().await;
}

#[tokio::test]
async fn history_outlives_restarts_and_recording_can_stop() {
    let t = TestDaemon::start(63, |_| {}).await;
    let f = fixture("kept.bin", &[("kept.bin", 50_000)], 16_384, None, false, 32);
    f.write_to(&t.save_path());
    let hash = t.add(&f, json!({})).await;
    t.wait_for(&hash, "seeding", 30, |x| x["state"] == "seeding")
        .await;
    let days = format!("/api/v1/stats/torrents/{hash}/days");
    let timeline = format!("/api/v1/stats/timeline?hash={hash}");

    // Stopping and starting show on the timeline.
    wait_get(&t, &days, "a day with seeding time", |v| {
        v["days"][0]["seeding_time"].as_u64().unwrap_or(0) >= 1
    })
    .await;
    let (s, _) = t
        .post("/api/v1/torrents/stop", json!({"hashes": [hash.clone()]}))
        .await;
    assert_eq!(s, StatusCode::OK);
    wait_get(&t, &timeline, "stopped on the timeline", |v| {
        kinds(v).first().map(String::as_str) == Some("state:stopped")
    })
    .await;
    let (s, _) = t
        .post("/api/v1/torrents/start", json!({"hashes": [hash.clone()]}))
        .await;
    assert_eq!(s, StatusCode::OK);
    wait_get(&t, &timeline, "seeding again", |v| {
        kinds(v).first().map(String::as_str) == Some("state:seeding")
    })
    .await;
    let before = t.get(&days).await["days"][0].clone();

    // A restart keeps the history and starts a new recording period.
    let dir = t.stop().await;
    let t = TestDaemon::start_in(dir, 63, None).await;
    let after = t.get(&days).await["days"][0].clone();
    assert!(
        after["seeding_time"].as_u64() >= before["seeding_time"].as_u64(),
        "{before} {after}"
    );
    // Restored counters are baselines, not new time: added today, the day
    // cannot hold more than the all-time counters.
    tokio::time::sleep(Duration::from_secs(3)).await;
    let after = t.get(&days).await["days"][0].clone();
    for (day, total) in [
        ("seeding_time", "seeding_time_total"),
        ("active_time", "active_time_total"),
    ] {
        assert!(
            after[day].as_u64().unwrap() <= after[total].as_u64().unwrap(),
            "{after}"
        );
    }
    let periods = t.get("/api/v1/stats/transfer").await["periods"].clone();
    let p = periods.as_array().unwrap();
    assert_eq!(p.len(), 2, "{periods}");
    assert_eq!(p[0]["clean"], true);
    assert!(p[0]["ended"].as_u64().is_some());
    assert_eq!(p[1]["ended"], Value::Null);
    let k = kinds(&t.get(&timeline).await);
    assert_eq!(
        k.iter().filter(|k| *k == "added").count(),
        1,
        "a restart is not an add: {k:?}"
    );

    // Off: the period ends, nothing new is recorded; on again: a new one.
    let (s, _) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"stats_enabled": false})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    assert_eq!(t.get("/api/v1/stats").await["enabled"], false);
    let (s, _) = t
        .post("/api/v1/torrents/stop", json!({"hashes": [hash.clone()]}))
        .await;
    assert_eq!(s, StatusCode::OK);
    tokio::time::sleep(Duration::from_secs(3)).await;
    assert_eq!(
        kinds(&t.get(&timeline).await).first().map(String::as_str),
        Some("state:seeding"),
        "nothing recorded while off"
    );
    let (s, _) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"stats_enabled": true, "stats_minute_retention": 3600})),
        )
        .await;
    assert_eq!(s, StatusCode::OK);
    let p = t.get("/api/v1/stats/transfer").await["periods"].clone();
    assert_eq!(p.as_array().unwrap().len(), 3, "{p}");
    assert_eq!(p[1]["clean"], true);
    t.stop().await;
}

#[tokio::test]
async fn a_broken_stats_database_turns_statistics_off() {
    let dir = tempfile::tempdir().unwrap();
    // A directory where the database file should be.
    std::fs::create_dir_all(dir.path().join("data").join("stats.db")).unwrap();
    let s = settings(64, &dir.path().join("downloads"));
    let t = TestDaemon::start_in(dir, 64, Some(s)).await;
    let (s, v) = t.call(Method::GET, "/api/v1/stats", None).await;
    assert_eq!(s, StatusCode::SERVICE_UNAVAILABLE, "{v}");
    assert_eq!(v["error"]["code"], "unavailable");
    assert_eq!(t.get("/api/v1/torrents").await, json!([]));
    let log = t.get("/api/v1/log").await;
    assert!(log.to_string().contains("statistics are off"), "{log}");
    t.stop().await;
}

#[tokio::test]
async fn removed_history_and_everything_can_be_deleted() {
    let t = TestDaemon::start(59, |_| {}).await;
    let add = |name: &'static str, seed: u32| {
        let f = fixture(name, &[(name, 50_000)], 16_384, None, false, seed);
        f.write_to(&t.save_path());
        f
    };
    let (a, b) = (add("gone.bin", 41), add("kept.bin", 42));
    let gone = t.add(&a, json!({})).await;
    let kept = t.add(&b, json!({})).await;
    for h in [&gone, &kept] {
        t.wait_for(h, "seeding", 30, |x| x["state"] == "seeding")
            .await;
    }
    // Seeding days are recorded for both.
    wait_get(&t, "/api/v1/stats", "two torrents", |v| v["torrents"] == 2).await;
    let (s, _) = t
        .post("/api/v1/torrents/delete", json!({"hashes": [gone.clone()]}))
        .await;
    assert_eq!(s, StatusCode::OK);
    let info = t.get("/api/v1/stats").await;
    assert_eq!(
        (&info["torrents"], &info["removed"]),
        (&json!(2), &json!(1))
    );

    // Found by name, the removed one first, even when it went before the
    // recorder saw it (its size is then unknown, never made up); a torrent
    // still in the session may have no name recorded yet. Or only one kind.
    let found = t.get("/api/v1/stats/torrents?search=BIN").await;
    assert_eq!(found[0]["hash"], json!(gone), "{found}");
    assert_eq!(found[0]["name"], json!("gone.bin"));
    assert!(
        matches!(found[0]["size"].as_u64(), None | Some(50_000)),
        "{found}"
    );
    assert!(found[0]["removed"].as_u64().is_some(), "{found}");
    let all = t.get("/api/v1/stats/torrents").await;
    assert_eq!(all.as_array().unwrap().len(), 2, "{all}");
    assert_eq!(all[1]["hash"], json!(kept));
    assert_eq!(all[1]["removed"], Value::Null);
    let removed = t
        .get("/api/v1/stats/torrents?search=g*e&removed=true")
        .await;
    assert_eq!(removed.as_array().unwrap().len(), 1, "{removed}");
    assert_eq!(removed[0]["hash"], json!(gone));
    let present = t.get("/api/v1/stats/torrents?removed=false&limit=5").await;
    assert_eq!(present.as_array().unwrap().len(), 1, "{present}");
    assert_eq!(present[0]["hash"], json!(kept));
    let none = t.get("/api/v1/stats/torrents?search=gone+kept").await;
    assert_eq!(none, json!([]));
    let (s, _) = t
        .call(Method::GET, "/api/v1/stats/torrents?limit=0", None)
        .await;
    assert_eq!(s, StatusCode::BAD_REQUEST);

    // The removed torrent's history goes; the other's stays.
    let (s, _) = t.call(Method::DELETE, "/api/v1/stats/removed", None).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let info = t.get("/api/v1/stats").await;
    assert_eq!(
        (&info["torrents"], &info["removed"]),
        (&json!(1), &json!(0))
    );
    let (s, _) = t
        .call(
            Method::GET,
            &format!("/api/v1/stats/torrents/{gone}/days"),
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    t.get(&format!("/api/v1/stats/torrents/{kept}/days")).await;

    // Everything goes, the timeline too; recording goes on.
    let cleared = urtorrentd::util::now();
    let (s, _) = t.call(Method::DELETE, "/api/v1/stats", None).await;
    assert_eq!(s, StatusCode::NO_CONTENT);
    let tl = t.get("/api/v1/stats/timeline").await;
    assert_eq!(tl, json!([]), "{tl}");
    let v = t.get("/api/v1/stats/transfer").await;
    let periods = v["periods"].as_array().unwrap();
    assert_eq!(periods.len(), 1, "{v}");
    assert!(periods[0]["started"].as_u64().unwrap() >= cleared, "{v}");
    let info = wait_get(&t, "/api/v1/stats", "the seed recorded again", |v| {
        v["torrents"] == 1
    })
    .await;
    assert_eq!(info["enabled"], true);
    assert_eq!(info["removed"], 0);
    t.stop().await;
}
