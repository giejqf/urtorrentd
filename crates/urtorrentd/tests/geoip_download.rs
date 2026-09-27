// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! GeoIP databases downloaded on request (ADR 0009) from a local mirror of
//! DB-IP Lite's downloads: last month's files when this month's are not
//! out, checked before use, and a bad download that changes nothing.

#![allow(clippy::unwrap_used, clippy::expect_used, clippy::panic, missing_docs)]

mod common;

use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use common::TestDaemon;
use common::mmdb;
use serde_json::{Value, json};

type Files = Arc<Mutex<HashMap<String, Vec<u8>>>>;

/// A mirror serving `files` under `/free/`, 404 for anything else.
async fn mirror(files: Files) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let app = axum::Router::new().route(
        "/free/{name}",
        axum::routing::get(
            move |axum::extract::Path(name): axum::extract::Path<String>| {
                let body = files.lock().unwrap().get(&name).cloned();
                async move {
                    match body {
                        Some(b) => (StatusCode::OK, b),
                        None => (StatusCode::NOT_FOUND, Vec::new()),
                    }
                }
            },
        ),
    );
    tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    format!("http://{addr}/free")
}

fn gz(bytes: &[u8]) -> Vec<u8> {
    let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
    e.write_all(bytes).unwrap();
    e.finish().unwrap()
}

/// A database of `kind`, gzipped, placing loopback as `code` / AS64500.
fn database(kind: &str, code: &str) -> Vec<u8> {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("x.mmdb");
    let record = if kind.contains("ASN") {
        mmdb::asn(64_500, "Test Net")
    } else {
        mmdb::country(code, "Somewhere")
    };
    mmdb::write(&path, 4, kind, 1_788_226_365, vec![("127.0.0.0/8", record)]);
    gz(&std::fs::read(path).unwrap())
}

/// Last month (UTC), as DB-IP names its files.
fn last_month() -> String {
    let today = jiff::Timestamp::now()
        .to_zoned(jiff::tz::TimeZone::UTC)
        .date();
    let d = today.first_of_month().yesterday().unwrap();
    format!("{:04}-{:02}", d.year(), d.month())
}

#[tokio::test]
async fn dbip_lite_is_downloaded_checked_and_used() {
    let files: Files = Arc::default();
    let month = last_month();
    let country = format!("dbip-country-lite-{month}.mmdb.gz");
    let asn = format!("dbip-asn-lite-{month}.mmdb.gz");
    files
        .lock()
        .unwrap()
        .insert(country.clone(), database("DBIP-Country-Lite", "NZ"));
    files.lock().unwrap().insert(
        asn.clone(),
        database("DBIP-ASN-Lite (compat=GeoLite2-ASN)", ""),
    );
    let base = mirror(files.clone()).await;
    let t = TestDaemon::start_with_mirror(100, |_| {}, &base).await;

    // This month's are not out: last month's, both, and in use.
    let (s, v) = t
        .post("/api/v1/app/geoip/download", json!({"source": "dbip_lite"}))
        .await;
    assert_eq!(s, StatusCode::OK, "{v}");
    assert_eq!(v["country"]["database_type"], "DBIP-Country-Lite", "{v}");
    assert_eq!(
        v["asn"]["database_type"], "DBIP-ASN-Lite (compat=GeoLite2-ASN)",
        "{v}"
    );
    assert_eq!(v["country"]["error"], Value::Null);
    let settings = t.get("/api/v1/settings").await;
    let path = settings["geoip_database"].as_str().unwrap().to_string();
    assert!(
        path.ends_with("/geoip/dbip-country-lite.mmdb"),
        "{settings}"
    );
    assert!(
        settings["geoip_asn_database"]
            .as_str()
            .unwrap()
            .ends_with("/geoip/dbip-asn-lite.mmdb")
    );
    assert_eq!(t.get("/api/v1/app").await["geoip"], v);
    let before = std::fs::read(&path).unwrap();

    // A download that is not a database changes nothing.
    files
        .lock()
        .unwrap()
        .insert(country.clone(), gz(b"not a database"));
    let (s, e) = t
        .post("/api/v1/app/geoip/download", json!({"source": "dbip_lite"}))
        .await;
    assert_eq!(s, StatusCode::BAD_GATEWAY, "{e}");
    assert_eq!(e["error"]["code"], "download_failed");
    assert!(
        e["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not a MaxMind DB"),
        "{e}"
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(t.get("/api/v1/app").await["geoip"], v, "still loaded");

    // Nor does a database of the wrong kind, or nothing published at all.
    files
        .lock()
        .unwrap()
        .insert(country.clone(), database("GeoLite2-City", "NZ"));
    let (s, e) = t
        .post("/api/v1/app/geoip/download", json!({"source": "dbip_lite"}))
        .await;
    assert_eq!(s, StatusCode::BAD_GATEWAY, "{e}");
    assert!(
        e["error"]["message"]
            .as_str()
            .unwrap()
            .contains("not DBIP-Country-Lite"),
        "{e}"
    );
    files.lock().unwrap().clear();
    let (s, e) = t
        .post("/api/v1/app/geoip/download", json!({"source": "dbip_lite"}))
        .await;
    assert_eq!(s, StatusCode::BAD_GATEWAY, "{e}");
    assert!(
        e["error"]["message"]
            .as_str()
            .unwrap()
            .contains("nothing published"),
        "{e}"
    );
    assert_eq!(std::fs::read(&path).unwrap(), before);

    // Only the sources there are.
    let (s, _) = t
        .post("/api/v1/app/geoip/download", json!({"source": "anywhere"}))
        .await;
    assert!(s.is_client_error(), "{s}");
    t.stop().await;
}
