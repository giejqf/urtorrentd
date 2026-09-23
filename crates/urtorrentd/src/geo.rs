// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Peer geolocation (ADR 0005): MaxMind DB (`.mmdb`) files the user provides
//! (GeoLite2 or DB-IP Lite country and ASN databases, or IPinfo Lite, which
//! has both), read into memory and reloaded when the file changes. The
//! daemon never downloads a database, and looks up countries and autonomous
//! systems only, never cities.

use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};
use std::time::SystemTime;

use maxminddb::{PathElement, Reader, path};
use serde_json::Value;

use crate::model::{GeoDatabaseInfo, GeoIpInfo};
use crate::util::normalize_ip;

/// Where an address is, as far as the databases know.
#[derive(Debug, Clone, Default, PartialEq, Eq, Hash)]
pub struct Location {
    /// ISO 3166-1 alpha-2 country code, upper case.
    pub country: Option<String>,
    /// Autonomous system number.
    pub asn: Option<u32>,
    /// The autonomous system's organization.
    pub as_org: Option<String>,
}

/// A file's identity, to notice when it is replaced.
type Stamp = (Option<SystemTime>, u64);

fn stamp(path: &Path) -> Option<Stamp> {
    std::fs::metadata(path)
        .ok()
        .map(|m| (m.modified().ok(), m.len()))
}

fn load(path: &Path) -> Result<Reader<Vec<u8>>, String> {
    Reader::open_readfile(path).map_err(|e| format!("{}: {e}", path.display()))
}

/// Whether `path` is a database this daemon can read (for the settings).
pub fn check(path: &str) -> Result<(), String> {
    let p = Path::new(path);
    if !p.is_absolute() {
        return Err(format!("{path:?} is not an absolute path"));
    }
    load(p).map(|_| ())
}

/// One configured file: loaded, or why not.
struct Slot {
    path: PathBuf,
    reader: Option<Arc<Reader<Vec<u8>>>>,
    stamp: Option<Stamp>,
    error: Option<String>,
}

impl Slot {
    fn open(path: &str) -> Slot {
        let path = PathBuf::from(path);
        let stamp = stamp(&path);
        match load(&path) {
            Ok(r) => Slot {
                path,
                reader: Some(Arc::new(r)),
                stamp,
                error: None,
            },
            Err(e) => Slot {
                path,
                reader: None,
                stamp,
                error: Some(e),
            },
        }
    }

    /// Reload if the file changed. Returns what to log. A file that cannot
    /// be read keeps the database loaded before (a download may be half
    /// written); it is tried again when the file changes again.
    fn refresh(&mut self) -> Option<String> {
        let now = stamp(&self.path);
        if now.is_none() || now == self.stamp {
            return None;
        }
        self.stamp = now;
        match load(&self.path) {
            Ok(r) => {
                self.reader = Some(Arc::new(r));
                self.error = None;
                Some(format!("GeoIP database {} reloaded", self.path.display()))
            }
            Err(e) => {
                let msg = format!("GeoIP database not reloaded: {e}");
                self.error = Some(e);
                Some(msg)
            }
        }
    }

    fn info(&self) -> GeoDatabaseInfo {
        GeoDatabaseInfo {
            path: self.path.to_string_lossy().into_owned(),
            database_type: self
                .reader
                .as_ref()
                .map(|r| r.metadata().database_type.clone()),
            built: self.reader.as_ref().map(|r| r.metadata().build_epoch),
            error: self.error.clone(),
        }
    }
}

fn lookup_in(reader: &Reader<Vec<u8>>, ip: IpAddr) -> Location {
    let Ok(found) = reader.lookup(ip) else {
        return Location::default();
    };
    if !found.has_data() {
        return Location::default();
    }
    // Each field by its path, as whatever type the file stores it: the
    // decoder is strict about integer widths, and the layouts differ
    // (GeoLite2 and DB-IP nest `country.iso_code`; IPinfo has
    // `country_code` and `asn` as "AS13335").
    let get = |p: &[PathElement<'_>]| found.decode_path::<Value>(p).ok().flatten();
    let text = |v: Option<Value>| match v {
        Some(Value::String(s)) if !s.is_empty() => Some(s),
        _ => None,
    };
    let country = text(get(&path!["country", "iso_code"]))
        .or_else(|| text(get(&path!["country_code"])))
        .or_else(|| text(get(&path!["registered_country", "iso_code"])))
        .map(|c| c.trim().to_ascii_uppercase())
        .filter(|c| c.len() == 2 && c.bytes().all(|b| b.is_ascii_uppercase()));
    let number = |v: Option<Value>| match v {
        Some(Value::Number(n)) => n.as_u64(),
        Some(Value::String(s)) => {
            let s = s.trim();
            s.strip_prefix("AS").unwrap_or(s).parse().ok()
        }
        _ => None,
    };
    let asn = number(get(&path!["autonomous_system_number"]))
        .or_else(|| number(get(&path!["asn"])))
        .and_then(|n| u32::try_from(n).ok())
        .filter(|&n| n > 0);
    let as_org = text(get(&path!["autonomous_system_organization"]))
        .or_else(|| text(get(&path!["as_name"])));
    Location {
        country,
        asn,
        as_org: asn.and(as_org),
    }
}

/// The configured databases (settings `geoip_database`,
/// `geoip_asn_database`).
#[derive(Default)]
pub struct GeoIp {
    slots: RwLock<[Option<Slot>; 2]>,
}

impl std::fmt::Debug for GeoIp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GeoIp").field("info", &self.info()).finish()
    }
}

impl GeoIp {
    /// Use these files (absolute paths; `None` = none). Files already open
    /// under the same path are kept. Returns errors to log.
    pub fn configure(&self, country: Option<&str>, asn: Option<&str>) -> Vec<String> {
        let mut slots = self.slots.write().unwrap_or_else(|e| e.into_inner());
        let mut errors = Vec::new();
        for (slot, path) in slots.iter_mut().zip([country, asn]) {
            match path {
                None => *slot = None,
                Some(p) if slot.as_ref().is_some_and(|s| s.path == Path::new(p)) => {}
                Some(p) => {
                    let s = Slot::open(p);
                    if let Some(e) = &s.error {
                        errors.push(format!("GeoIP database: {e}"));
                    }
                    *slot = Some(s);
                }
            }
        }
        errors
    }

    /// Reload files that changed on disk. Returns what to log.
    pub fn refresh(&self) -> Vec<String> {
        let changed = {
            let slots = self.slots.read().unwrap_or_else(|e| e.into_inner());
            slots
                .iter()
                .flatten()
                .any(|s| stamp(&s.path).is_some_and(|now| Some(now) != s.stamp))
        };
        if !changed {
            return Vec::new();
        }
        let mut slots = self.slots.write().unwrap_or_else(|e| e.into_inner());
        slots
            .iter_mut()
            .flatten()
            .filter_map(Slot::refresh)
            .collect()
    }

    /// Where `ip` is. The country database answers first (IPinfo Lite also
    /// has the ASN); the ASN database fills what it left out.
    pub fn lookup(&self, ip: IpAddr) -> Location {
        let readers: Vec<Arc<Reader<Vec<u8>>>> = {
            let slots = self.slots.read().unwrap_or_else(|e| e.into_inner());
            slots
                .iter()
                .flatten()
                .filter_map(|s| s.reader.clone())
                .collect()
        };
        let ip = normalize_ip(ip);
        let mut loc = Location::default();
        for r in &readers {
            let l = lookup_in(r, ip);
            loc.country = loc.country.or(l.country);
            if loc.asn.is_none() {
                loc.asn = l.asn;
                loc.as_org = l.as_org;
            }
        }
        loc
    }

    /// Whether any database is loaded.
    pub fn enabled(&self) -> bool {
        let slots = self.slots.read().unwrap_or_else(|e| e.into_inner());
        slots.iter().flatten().any(|s| s.reader.is_some())
    }

    /// The files in use.
    pub fn info(&self) -> GeoIpInfo {
        let slots = self.slots.read().unwrap_or_else(|e| e.into_inner());
        GeoIpInfo {
            country: slots[0].as_ref().map(Slot::info),
            asn: slots[1].as_ref().map(Slot::info),
        }
    }
}
