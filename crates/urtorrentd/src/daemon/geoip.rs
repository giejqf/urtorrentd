// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! GeoIP databases downloaded on request ([ADR 0009]): DB-IP Lite's country
//! and ASN files, fetched when a client asks (never on the daemon's own
//! initiative), checked, put in place beside the old ones and used.
//!
//! [ADR 0009]: ../../../../docs/adr/0009-geoip-download.md

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use axum::http::StatusCode;

use super::Daemon;
use crate::error::{ApiError, ApiResult, ErrorCode};
use crate::log::LogTopic;
use crate::model::{GeoIpInfo, GeoIpSource};
use crate::settings::SettingsPatch;
use crate::util::blocking;

/// Where DB-IP Lite's files come from unless `--geoip-mirror` says otherwise.
pub const DBIP_MIRROR: &str = "https://download.db-ip.com/free";
/// A compressed file, at most.
const MAX_GZ: usize = 64 << 20;
/// A database, at most.
const MAX_MMDB: u64 = 256 << 20;
/// A download, at most.
const TIMEOUT: Duration = Duration::from_secs(600);
/// DB-IP Lite's files: the name in their URLs and on disk, and the
/// database type the file must have.
const DBIP_FILES: [(&str, &str); 2] = [("country", "DBIP-Country-Lite"), ("asn", "DBIP-ASN-Lite")];

fn failed(message: impl Into<String>) -> ApiError {
    ApiError::new(StatusCode::BAD_GATEWAY, ErrorCode::DownloadFailed, message)
}

/// The months to try (`YYYY-MM`): this one (UTC), then the one before, since
/// DB-IP publishes on the first of the month.
fn months(now: jiff::Timestamp) -> Vec<String> {
    let today = now.to_zoned(jiff::tz::TimeZone::UTC).date();
    let mut out = vec![format!("{:04}-{:02}", today.year(), today.month())];
    if let Ok(before) = today.first_of_month().yesterday() {
        out.push(format!("{:04}-{:02}", before.year(), before.month()));
    }
    out
}

/// Unpack a download, check that it is a database of `kind`, and put it in
/// place: written beside the file at `path` and renamed over it, so a bad
/// download leaves the old one as it was.
fn install(path: &Path, gz: &[u8], kind: &str) -> Result<(), String> {
    let mut db = Vec::new();
    flate2::read::GzDecoder::new(gz)
        .take(MAX_MMDB + 1)
        .read_to_end(&mut db)
        .map_err(|e| format!("unpacking: {e}"))?;
    if db.len() as u64 > MAX_MMDB {
        return Err("larger than 256 MiB unpacked".into());
    }
    let reader = maxminddb::Reader::from_source(db.as_slice())
        .map_err(|e| format!("not a MaxMind DB: {e}"))?;
    let found = &reader.metadata().database_type;
    if !found.starts_with(kind) {
        return Err(format!("a {found} database, not {kind}"));
    }
    let dir = path.parent().ok_or("no directory")?;
    std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let part = path.with_extension("mmdb.part");
    let write = || -> std::io::Result<()> {
        let mut f = std::fs::File::create(&part)?;
        f.write_all(&db)?;
        f.sync_all()?;
        std::fs::rename(&part, path)
    };
    write().map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("{}: {e}", path.display())
    })
}

impl Daemon {
    /// Download a source's databases now and use them (ADR 0009). One
    /// download at a time.
    pub(crate) async fn download_geoip(
        self: &Arc<Self>,
        source: GeoIpSource,
    ) -> ApiResult<GeoIpInfo> {
        let GeoIpSource::DbipLite = source;
        let _one = self
            .geoip_download
            .try_lock()
            .map_err(|_| ApiError::conflict("a GeoIP download is running"))?;
        let dir = self.store.root().join("geoip");
        let mut paths: Vec<PathBuf> = Vec::new();
        let mut month = String::new();
        for (name, kind) in DBIP_FILES {
            let (m, gz) = self.fetch_dbip(name).await?;
            let path = dir.join(format!("dbip-{name}-lite.mmdb"));
            let p = path.clone();
            blocking(move || install(&p, &gz, kind).map_err(std::io::Error::other))
                .await
                .map_err(|e| failed(format!("DB-IP Lite {name} {m}: {e}")))?;
            paths.push(path);
            month = m;
        }
        let text = |p: &PathBuf| p.to_string_lossy().into_owned();
        self.update_settings(SettingsPatch {
            geoip_database: paths.first().map(|p| Some(text(p))),
            geoip_asn_database: paths.get(1).map(|p| Some(text(p))),
            ..Default::default()
        })
        .await?;
        // Same paths as before: the files changed under them.
        for msg in self.geo.refresh() {
            self.logs.info(LogTopic::Statistics, msg);
        }
        self.logs.info(
            LogTopic::Statistics,
            format!("GeoIP: DB-IP Lite {month} downloaded (country and ASN)"),
        );
        Ok(self.geo.info())
    }

    /// One of DB-IP Lite's files, compressed, for the newest month published.
    async fn fetch_dbip(&self, name: &str) -> ApiResult<(String, Vec<u8>)> {
        let base = self.geoip_mirror.trim_end_matches('/');
        let mut tried = Vec::new();
        for month in months(jiff::Timestamp::now()) {
            let url = format!("{base}/dbip-{name}-lite-{month}.mmdb.gz");
            let mut resp = self
                .http
                .get(&url)
                .timeout(TIMEOUT)
                .send()
                .await
                .map_err(|e| failed(format!("fetching {url}: {e}")))?;
            if resp.status() == reqwest::StatusCode::NOT_FOUND {
                tried.push(month);
                continue;
            }
            if !resp.status().is_success() {
                return Err(failed(format!("{url}: HTTP {}", resp.status())));
            }
            if resp.content_length().is_some_and(|n| n > MAX_GZ as u64) {
                return Err(failed(format!("{url}: larger than 64 MiB")));
            }
            let mut body = Vec::new();
            while let Some(chunk) = resp
                .chunk()
                .await
                .map_err(|e| failed(format!("reading {url}: {e}")))?
            {
                if body.len() + chunk.len() > MAX_GZ {
                    return Err(failed(format!("{url}: larger than 64 MiB")));
                }
                body.extend_from_slice(&chunk);
            }
            return Ok((month, body));
        }
        Err(failed(format!(
            "DB-IP Lite {name}: nothing published for {}",
            tried.join(" or ")
        )))
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn tries_this_month_then_the_one_before() {
        let at = |s: &str| s.parse::<jiff::Timestamp>().unwrap();
        assert_eq!(months(at("2026-09-27T12:00:00Z")), ["2026-09", "2026-08"]);
        assert_eq!(months(at("2027-01-01T00:30:00Z")), ["2027-01", "2026-12"]);
    }

    #[test]
    fn installs_only_a_database_of_the_kind_asked() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("geoip/dbip-country-lite.mmdb");
        let gz = |bytes: &[u8]| {
            let mut e = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::fast());
            e.write_all(bytes).unwrap();
            e.finish().unwrap()
        };
        let err = install(&path, b"not gzip", "DBIP-Country-Lite").unwrap_err();
        assert!(err.starts_with("unpacking"), "{err}");
        let err = install(&path, &gz(b"not a database"), "DBIP-Country-Lite").unwrap_err();
        assert!(err.starts_with("not a MaxMind DB"), "{err}");
        assert!(!path.exists() && !path.with_extension("mmdb.part").exists());
    }
}
