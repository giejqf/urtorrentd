// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Test harness: daemons on loopback with real engines, a request helper
//! that validates every response against the OpenAPI document (so the
//! schema a frontend SDK is generated from is exactly what the API sends),
//! and `.torrent` fixtures.

#![allow(
    dead_code,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    missing_docs
)]

pub mod mmdb;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use axum::body::Body;
use axum::extract::connect_info::MockConnectInfo;
use axum::http::{HeaderMap, Method, Request, StatusCode};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha1::{Digest, Sha1};
use tower::ServiceExt;
use urtorrentd::settings::Settings;
use urtorrentd::{Daemon, DaemonConfig, api};

// ------------------------------------------------------------------ fixtures

fn bstr(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(format!("{}:", s.len()).as_bytes());
    out.extend_from_slice(s);
}

fn bint(out: &mut Vec<u8>, n: u64) {
    out.extend_from_slice(format!("i{n}e").as_bytes());
}

/// Deterministic pseudo-random bytes.
pub fn data(len: usize, seed: u32) -> Vec<u8> {
    let mut x = seed.max(1);
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 17;
            x ^= x << 5;
            x as u8
        })
        .collect()
}

/// A test torrent: the `.torrent` and its files.
pub struct Fixture {
    pub name: String,
    pub torrent: Vec<u8>,
    pub hash: String,
    /// `(path relative to the save path, contents)`.
    pub files: Vec<(String, Vec<u8>)>,
}

impl Fixture {
    /// Write the content under `dir` (as a seeder would have it).
    pub fn write_to(&self, dir: &Path) {
        for (path, bytes) in &self.files {
            let p = dir.join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, bytes).unwrap();
        }
    }

    /// The `.torrent`, base64.
    pub fn b64(&self) -> String {
        use base64::Engine as _;
        base64::engine::general_purpose::STANDARD.encode(&self.torrent)
    }
}

/// A multi-file torrent `name/<file>` (or a single file when `files` has one
/// entry named like `name`). Optional `announce` and `private` flag.
pub fn fixture(
    name: &str,
    files: &[(&str, usize)],
    piece_len: usize,
    announce: Option<&str>,
    private: bool,
    seed: u32,
) -> Fixture {
    let single = files.len() == 1 && files[0].0 == name;
    let contents: Vec<Vec<u8>> = files
        .iter()
        .enumerate()
        .map(|(i, (_, len))| data(*len, seed.wrapping_add(i as u32 * 7919)))
        .collect();
    let stream: Vec<u8> = contents.iter().flatten().copied().collect();
    let mut pieces = Vec::new();
    for chunk in stream.chunks(piece_len) {
        pieces.extend_from_slice(&Sha1::digest(chunk));
    }
    let mut info = b"d".to_vec();
    if single {
        bstr(&mut info, b"length");
        bint(&mut info, files[0].1 as u64);
    } else {
        bstr(&mut info, b"files");
        info.push(b'l');
        for (path, len) in files {
            info.push(b'd');
            bstr(&mut info, b"length");
            bint(&mut info, *len as u64);
            bstr(&mut info, b"path");
            info.push(b'l');
            for part in path.split('/') {
                bstr(&mut info, part.as_bytes());
            }
            info.push(b'e');
            info.push(b'e');
        }
        info.push(b'e');
    }
    bstr(&mut info, b"name");
    bstr(&mut info, name.as_bytes());
    bstr(&mut info, b"piece length");
    bint(&mut info, piece_len as u64);
    bstr(&mut info, b"pieces");
    bstr(&mut info, &pieces);
    if private {
        bstr(&mut info, b"private");
        bint(&mut info, 1);
    }
    info.push(b'e');
    let hash = urtorrentd::util::hex(&Sha1::digest(&info));
    let mut t = b"d".to_vec();
    if let Some(a) = announce {
        bstr(&mut t, b"announce");
        bstr(&mut t, a.as_bytes());
    }
    bstr(&mut t, b"comment");
    bstr(&mut t, b"fixture");
    bstr(&mut t, b"info");
    t.extend_from_slice(&info);
    t.push(b'e');
    let files = files
        .iter()
        .zip(contents)
        .map(|((path, _), bytes)| {
            let p = if single {
                name.to_string()
            } else {
                format!("{name}/{path}")
            };
            (p, bytes)
        })
        .collect();
    Fixture {
        name: name.to_string(),
        torrent: t,
        hash,
        files,
    }
}

// ------------------------------------------------------------------ schema validation

fn doc() -> &'static Value {
    static DOC: OnceLock<Value> = OnceLock::new();
    DOC.get_or_init(|| serde_json::from_str(&api::openapi_json()).unwrap())
}

fn path_matches(template: &str, path: &str) -> bool {
    let t: Vec<&str> = template.split('/').collect();
    let p: Vec<&str> = path.split('/').collect();
    t.len() == p.len()
        && t.iter()
            .zip(&p)
            .all(|(a, b)| (a.starts_with('{') && a.ends_with('}')) || a == b)
}

/// The operation documented for `method path`; panics if there is none
/// (an undocumented endpoint breaks the typed-SDK guarantee).
fn operation(method: &Method, path: &str) -> &'static Value {
    let path = path.split('?').next().unwrap();
    let paths = doc()["paths"].as_object().unwrap();
    // Literal segments beat parameters (`/torrents/count` over `/torrents/{hash}`).
    let mut candidates: Vec<(&String, &Value)> = paths
        .iter()
        .filter(|(t, _)| path_matches(t, path))
        .collect();
    candidates.sort_by_key(|(t, _)| t.matches('{').count());
    for (_, item) in candidates {
        if let Some(op) = item.get(method.as_str().to_ascii_lowercase()) {
            return op;
        }
    }
    panic!("{method} {path} is not in the OpenAPI document");
}

/// Check a response against the documented schema for its status.
pub fn validate_response(
    method: &Method,
    path: &str,
    status: StatusCode,
    body: &[u8],
    headers: &HeaderMap,
) {
    let op = operation(method, path);
    let resp = op["responses"]
        .get(status.as_str())
        .unwrap_or_else(|| panic!("{method} {path}: status {status} is not documented"));
    let Some(content) = resp.get("content").and_then(Value::as_object) else {
        assert!(
            body.is_empty(),
            "{method} {path}: {status} is documented without a body"
        );
        return;
    };
    let ctype = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .split(';')
        .next()
        .unwrap_or("")
        .to_string();
    let media = content
        .get(&ctype)
        .unwrap_or_else(|| panic!("{method} {path}: content type {ctype:?} is not documented"));
    if ctype != "application/json" {
        return;
    }
    let instance: Value = serde_json::from_slice(body)
        .unwrap_or_else(|e| panic!("{method} {path}: body is not JSON: {e}"));
    let mut schema = media["schema"].clone();
    if let Some(obj) = schema.as_object_mut() {
        obj.insert("components".into(), doc()["components"].clone());
    }
    let validator = jsonschema::validator_for(&schema)
        .unwrap_or_else(|e| panic!("{method} {path}: bad schema: {e}"));
    let errors: Vec<String> = validator
        .iter_errors(&instance)
        .map(|e| format!("{} at {}", e, e.instance_path))
        .collect();
    assert!(
        errors.is_empty(),
        "{method} {path} ({status}) does not match its schema:\n{}\nbody: {}",
        errors.join("\n"),
        String::from_utf8_lossy(body)
    );
}

/// Check a value against a named component schema.
pub fn validate_schema(name: &str, instance: &Value) {
    let schema = json!({
        "$ref": format!("#/components/schemas/{name}"),
        "components": doc()["components"].clone(),
    });
    let validator = jsonschema::validator_for(&schema).unwrap();
    let errors: Vec<String> = validator
        .iter_errors(instance)
        .map(|e| format!("{} at {}", e, e.instance_path))
        .collect();
    assert!(
        errors.is_empty(),
        "{name}: {}\n{instance}",
        errors.join("\n")
    );
}

// ------------------------------------------------------------------ daemons

/// Settings for a test daemon: peers on `127.0.0.<n>`, no DHT / LSD, a
/// temporary save path, loopback clients need no login.
pub fn settings(n: u8, save: &Path) -> Settings {
    Settings {
        listen_port: 0,
        listen_v4: Some(Ipv4Addr::new(127, 0, 0, n)),
        listen_v6: None,
        dht: false,
        lsd: false,
        dht_bootstrap_nodes: Some(Vec::new()),
        save_path: save.to_string_lossy().into_owned(),
        api_bypass_local_auth: true,
        ..Settings::default()
    }
}

/// A daemon under test with its own data directory.
pub struct TestDaemon {
    pub daemon: Arc<Daemon>,
    pub router: axum::Router,
    pub dir: tempfile::TempDir,
    pub n: u8,
    /// The client address requests appear to come from.
    pub client: SocketAddr,
}

pub fn init_log() {
    let _ = tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("warn")),
        )
        .with_test_writer()
        .try_init();
}

impl TestDaemon {
    /// Start with [`settings`] (adjusted by `f`).
    pub async fn start(n: u8, f: impl FnOnce(&mut Settings)) -> TestDaemon {
        init_log();
        let dir = tempfile::tempdir().unwrap();
        let mut s = settings(n, &dir.path().join("downloads"));
        f(&mut s);
        Self::start_in(dir, n, Some(s)).await
    }

    /// Start (or restart) on an existing data directory.
    pub async fn start_in(dir: tempfile::TempDir, n: u8, initial: Option<Settings>) -> TestDaemon {
        let daemon = Daemon::start(DaemonConfig {
            data_dir: dir.path().join("data"),
            initial_settings: initial,
        })
        .await
        .unwrap();
        let client: SocketAddr = "127.0.0.1:40000".parse().unwrap();
        let router = api::router(daemon.clone()).layer(MockConnectInfo(client));
        TestDaemon {
            daemon,
            router,
            dir,
            n,
            client,
        }
    }

    /// Stop and hand back the data directory (for a restart).
    pub async fn stop(self) -> tempfile::TempDir {
        self.daemon.shutdown().await;
        self.dir
    }

    pub fn save_path(&self) -> PathBuf {
        PathBuf::from(self.daemon.settings().save_path)
    }

    /// The engine's peer address.
    pub fn peer_addr(&self) -> String {
        format!("127.0.0.{}:{}", self.n, self.daemon.session().listen_port())
    }

    /// A request; the response is validated against the OpenAPI document.
    pub async fn request(&self, req: Request<Body>) -> (StatusCode, HeaderMap, Vec<u8>) {
        let method = req.method().clone();
        let path = req.uri().path().to_string();
        let resp = self.router.clone().oneshot(req).await.unwrap();
        let status = resp.status();
        let headers = resp.headers().clone();
        let body = resp
            .into_body()
            .collect()
            .await
            .unwrap()
            .to_bytes()
            .to_vec();
        if path != "/api/v1/openapi.json"
            && path.starts_with("/api/v1/")
            && operation_exists(&method, &path)
        {
            validate_response(&method, &path, status, &body, &headers);
        }
        (status, headers, body)
    }

    /// JSON request helper: `(status, body as JSON or Null)`.
    pub async fn call(
        &self,
        method: Method,
        path: &str,
        body: Option<Value>,
    ) -> (StatusCode, Value) {
        let mut b = Request::builder().method(method).uri(path);
        let body = match body {
            Some(v) => {
                b = b.header("content-type", "application/json");
                Body::from(v.to_string())
            }
            None => Body::empty(),
        };
        let (status, _, bytes) = self.request(b.body(body).unwrap()).await;
        let v = if bytes.is_empty() {
            Value::Null
        } else {
            serde_json::from_slice(&bytes).unwrap_or(Value::Null)
        };
        (status, v)
    }

    pub async fn get(&self, path: &str) -> Value {
        let (s, v) = self.call(Method::GET, path, None).await;
        assert_eq!(s, StatusCode::OK, "GET {path}: {v}");
        v
    }

    pub async fn post(&self, path: &str, body: Value) -> (StatusCode, Value) {
        self.call(Method::POST, path, Some(body)).await
    }

    /// Add a `.torrent` with options; returns the info-hash.
    pub async fn add(&self, f: &Fixture, options: Value) -> String {
        let (s, v) = self
            .post(
                "/api/v1/torrents",
                json!({"torrents": [f.b64()], "options": options}),
            )
            .await;
        assert_eq!(s, StatusCode::OK, "{v}");
        assert_eq!(v["failed"], json!([]), "{v}");
        v["added"][0]["hash"].as_str().unwrap().to_string()
    }

    pub async fn torrent(&self, hash: &str) -> Value {
        self.get(&format!("/api/v1/torrents/{hash}")).await
    }

    /// Poll a torrent until `pred` holds.
    pub async fn wait_for(
        &self,
        hash: &str,
        what: &str,
        secs: u64,
        pred: impl Fn(&Value) -> bool,
    ) -> Value {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            let t = self.torrent(hash).await;
            if pred(&t) {
                return t;
            }
            assert!(
                Instant::now() < deadline,
                "timed out waiting for {what}: {t}"
            );
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

fn operation_exists(method: &Method, path: &str) -> bool {
    let path = path.split('?').next().unwrap_or(path);
    doc()["paths"].as_object().unwrap().iter().any(|(t, item)| {
        path_matches(t, path) && item.get(method.as_str().to_ascii_lowercase()).is_some()
    })
}
