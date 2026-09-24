// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Geolocation (ADR 0005): the database layouts users have, peers located
//! in the API, and peer traffic by place that adds up to the torrents'
//! traffic. The databases are written by the tests (`common::mmdb`) and map
//! loopback addresses.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::net::IpAddr;
use std::path::Path;
use std::time::{Duration, Instant};

use axum::http::{Method, StatusCode};
use common::mmdb::{self, V};
use common::{TestDaemon, fixture};
use serde_json::{Value, json};
use urtorrentd::geo::{GeoIp, Location};

fn ip(s: &str) -> IpAddr {
    s.parse().unwrap()
}

fn located(country: &str, asn: u32, org: &str) -> Location {
    Location {
        country: Some(country.into()),
        asn: Some(asn),
        as_org: Some(org.into()),
    }
}

/// A GeoLite2-style pair: loopback is in New Zealand, AS64500.
fn write_loopback_dbs(dir: &Path, epoch: u64) -> (String, String) {
    let country = dir.join("country.mmdb");
    let asn = dir.join("asn.mmdb");
    mmdb::write(
        &country,
        6,
        "GeoLite2-Country",
        epoch,
        vec![
            ("127.0.0.0/8", mmdb::country("NZ", "New Zealand")),
            ("2001:db8::/32", mmdb::country("DE", "Germany")),
        ],
    );
    mmdb::write(
        &asn,
        4,
        "GeoLite2-ASN",
        epoch,
        vec![("127.0.0.0/8", mmdb::asn(64_500, "Test Net"))],
    );
    (
        country.to_string_lossy().into_owned(),
        asn.to_string_lossy().into_owned(),
    )
}

#[test]
fn lookups_read_the_common_layouts() {
    let dir = tempfile::tempdir().unwrap();
    let (country, asn) = write_loopback_dbs(dir.path(), 1_700_000_000);
    for p in [&country, &asn] {
        maxminddb::Reader::open_readfile(p)
            .unwrap()
            .verify()
            .unwrap();
    }

    let geo = GeoIp::default();
    assert!(geo.configure(Some(&country), Some(&asn)).is_empty());
    assert!(geo.enabled());
    assert_eq!(
        geo.lookup(ip("127.0.0.5")),
        located("NZ", 64_500, "Test Net")
    );
    assert_eq!(
        geo.lookup(ip("::ffff:127.0.0.5")),
        located("NZ", 64_500, "Test Net")
    );
    // IPv6 is in the country database only (the ASN one is IPv4-only).
    assert_eq!(
        geo.lookup(ip("2001:db8::1")),
        Location {
            country: Some("DE".into()),
            ..Default::default()
        }
    );
    assert_eq!(geo.lookup(ip("10.1.2.3")), Location::default());
    let info = geo.info();
    assert_eq!(
        info.country.as_ref().unwrap().database_type.as_deref(),
        Some("GeoLite2-Country")
    );
    assert_eq!(info.asn.as_ref().unwrap().built, Some(1_700_000_000));

    // IPinfo Lite: both in one file, the ASN as "AS64501".
    let lite = dir.path().join("ipinfo.mmdb");
    mmdb::write(
        &lite,
        6,
        "ipinfo lite",
        1,
        vec![(
            "127.0.0.0/8",
            mmdb::ipinfo("AU", "Australia", 64_501, "Info Net"),
        )],
    );
    let geo = GeoIp::default();
    geo.configure(Some(lite.to_str().unwrap()), None);
    assert_eq!(
        geo.lookup(ip("127.0.0.9")),
        located("AU", 64_501, "Info Net")
    );

    // A file that is not a database: reported, nothing located.
    let junk = dir.path().join("junk.mmdb");
    std::fs::write(&junk, b"not a database").unwrap();
    let geo = GeoIp::default();
    let errors = geo.configure(Some(junk.to_str().unwrap()), None);
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert!(!geo.enabled());
    assert!(geo.info().country.unwrap().error.is_some());
    assert_eq!(geo.lookup(ip("127.0.0.5")), Location::default());

    // Replaced on disk: read again.
    mmdb::write(
        &junk,
        4,
        "GeoLite2-Country",
        2,
        vec![("127.0.0.0/8", mmdb::country("FJ", "Fiji"))],
    );
    assert_eq!(geo.refresh().len(), 1);
    assert_eq!(geo.lookup(ip("127.0.0.5")).country.as_deref(), Some("FJ"));
    assert!(geo.refresh().is_empty(), "unchanged: not read again");
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
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}

fn sum(points: &Value, field: &str) -> u64 {
    points
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p[field].as_u64().unwrap())
        .sum()
}

#[tokio::test]
async fn peers_are_located_and_their_traffic_adds_up() {
    let dbs = tempfile::tempdir().unwrap();
    let (country, asn) = write_loopback_dbs(dbs.path(), 1_700_000_000);
    let seeder = TestDaemon::start(65, |s| {
        s.geoip_database = Some(country.clone());
        s.geoip_asn_database = Some(asn.clone());
    })
    .await;
    // Slow enough that peers are sampled while the transfer runs.
    let leecher = TestDaemon::start(66, |s| s.download_limit = Some(80_000)).await;
    let f = fixture(
        "far.bin",
        &[("far.bin", 1_000_000)],
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
    leecher.add(&f, json!({})).await;
    let (s, _) = leecher
        .post(
            "/api/v1/torrents/peers",
            json!({"hashes": [hash.clone()], "peers": [seeder.peer_addr()]}),
        )
        .await;
    assert_eq!(s, StatusCode::OK);

    // Live peers carry their place.
    let peers = wait_get(
        &seeder,
        &format!("/api/v1/torrents/{hash}/peers"),
        "a connected peer",
        |v| !v.as_array().unwrap().is_empty(),
    )
    .await;
    assert_eq!(peers[0]["country"], "NZ", "{peers}");
    assert_eq!(peers[0]["asn"], 64_500);
    assert_eq!(peers[0]["as_org"], "Test Net");
    let lp = leecher.get(&format!("/api/v1/torrents/{hash}/peers")).await;
    if let Some(p) = lp.as_array().unwrap().first() {
        assert_eq!(p["country"], Value::Null, "no database on the leecher: {p}");
    }
    leecher
        .wait_for(&hash, "download", 90, |x| x["complete"] == true)
        .await;
    let up = seeder
        .wait_for(&hash, "upload counted", 30, |x| {
            x["uploaded"].as_u64().unwrap() >= 1_000_000
        })
        .await["uploaded"]
        .as_u64()
        .unwrap();

    // The torrent's own traffic first: `unattributed` is measured against it.
    wait_get(
        &seeder,
        &format!("/api/v1/stats/torrents/{hash}/traffic?step=hour"),
        "the torrent's traffic",
        |v| sum(&v["points"], "uploaded") == up,
    )
    .await;

    // By country: everything went to New Zealand, nothing unattributed.
    let geo = format!("/api/v1/stats/geo?hash={hash}&series=true");
    let v = wait_get(&seeder, &geo, "attributed upload", |v| {
        v["rows"][0]["uploaded"].as_u64() == Some(up) && v["unattributed"]["uploaded"] == 0
    })
    .await;
    assert_eq!(v["dim"], "country");
    assert_eq!(v["step"], "hour");
    assert_eq!(v["located"], true);
    assert_eq!(v["rows"].as_array().unwrap().len(), 1, "{v}");
    assert_eq!(v["rows"][0]["country"], "NZ");
    assert_eq!(v["rows"][0]["peers_max"], 1, "one address: {v}");
    assert_eq!(sum(&v["points"], "uploaded"), up);
    // By network, per day, over all torrents: the same bytes.
    let v = seeder.get("/api/v1/stats/geo?dim=asn&step=day").await;
    assert_eq!(v["rows"][0]["asn"], 64_500, "{v}");
    assert_eq!(v["rows"][0]["as_org"], "Test Net");
    assert_eq!(v["rows"][0]["uploaded"].as_u64(), Some(up));
    assert_eq!(v["unattributed"]["uploaded"], 0);

    // The leecher has no database: its peers are recorded, not located.
    let down = leecher.torrent(&hash).await["downloaded"].as_u64().unwrap();
    wait_get(
        &leecher,
        &format!("/api/v1/stats/torrents/{hash}/traffic?step=hour"),
        "the leecher's traffic",
        |v| sum(&v["points"], "downloaded") == down,
    )
    .await;
    let v = wait_get(&leecher, "/api/v1/stats/geo", "attributed download", |v| {
        v["rows"][0]["downloaded"].as_u64() == Some(down)
    })
    .await;
    assert_eq!(v["rows"][0]["country"], Value::Null, "{v}");
    assert_eq!(v["located"], false);
    assert_eq!(v["unattributed"]["downloaded"], 0);

    // Refused.
    for bad in [
        "/api/v1/stats/geo?step=minute",
        "/api/v1/stats/geo?limit=0",
        "/api/v1/stats/geo?from=0&series=true&limit=250",
    ] {
        let (s, v) = seeder.call(Method::GET, bad, None).await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{bad}: {v}");
    }
    let (s, _) = seeder
        .call(
            Method::GET,
            "/api/v1/stats/geo?hash=0000000000000000000000000000000000000000",
            None,
        )
        .await;
    assert_eq!(s, StatusCode::NOT_FOUND);
    leecher.stop().await;
    seeder.stop().await;
}

#[tokio::test]
async fn geoip_settings_are_checked_and_files_reloaded() {
    let dbs = tempfile::tempdir().unwrap();
    let (country, _) = write_loopback_dbs(dbs.path(), 100);
    let t = TestDaemon::start(67, |_| {}).await;
    assert_eq!(
        t.get("/api/v1/app").await["geoip"],
        json!({"country": null, "asn": null})
    );
    let junk = dbs.path().join("junk.mmdb");
    std::fs::write(&junk, b"junk").unwrap();
    for bad in [
        json!({"geoip_database": "relative/country.mmdb"}),
        json!({"geoip_database": dbs.path().join("missing.mmdb")}),
        json!({"geoip_asn_database": junk}),
    ] {
        let (s, v) = t
            .call(Method::PATCH, "/api/v1/settings", Some(bad.clone()))
            .await;
        assert_eq!(s, StatusCode::BAD_REQUEST, "{bad}: {v}");
    }
    let (s, v) = t
        .call(
            Method::PATCH,
            "/api/v1/settings",
            Some(json!({"geoip_database": country})),
        )
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    let g = t.get("/api/v1/app").await["geoip"].clone();
    assert_eq!(g["country"]["database_type"], "GeoLite2-Country", "{g}");
    assert_eq!(g["country"]["built"], 100);
    assert_eq!(g["country"]["error"], Value::Null);

    // A monthly update replaces the file: it is read again.
    mmdb::write(
        Path::new(&country),
        6,
        "GeoLite2-Country",
        200,
        vec![("127.0.0.0/8", V::Map(Vec::new()))],
    );
    wait_get(&t, "/api/v1/app", "the new database", |v| {
        v["geoip"]["country"]["built"] == 200
    })
    .await;
    let log = t.get("/api/v1/log").await;
    assert!(log.to_string().contains("reloaded"), "{log}");
    t.stop().await;
}
