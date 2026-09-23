// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! A MaxMind DB writer for tests (format: maxmind.github.io/MaxMind-DB),
//! so the tests locate loopback addresses without a real database.
//! 24-bit records; more specific networks must come after the ones they
//! split.

use std::net::IpAddr;
use std::path::Path;

/// A value in the data section.
pub enum V {
    S(String),
    U16(u16),
    U32(u32),
    U64(u64),
    Map(Vec<(String, V)>),
    Arr(Vec<V>),
}

pub fn s(x: &str) -> V {
    V::S(x.to_string())
}

pub fn map(kv: Vec<(&str, V)>) -> V {
    V::Map(kv.into_iter().map(|(k, v)| (k.to_string(), v)).collect())
}

/// GeoLite2-Country's layout.
pub fn country(code: &str, name: &str) -> V {
    map(vec![
        (
            "country",
            map(vec![
                ("iso_code", s(code)),
                ("names", map(vec![("en", s(name))])),
            ]),
        ),
        ("registered_country", map(vec![("iso_code", s(code))])),
    ])
}

/// GeoLite2-ASN's layout.
pub fn asn(number: u32, org: &str) -> V {
    map(vec![
        ("autonomous_system_number", V::U32(number)),
        ("autonomous_system_organization", s(org)),
    ])
}

/// IPinfo Lite's layout (country and ASN in one record).
pub fn ipinfo(code: &str, name: &str, number: u32, org: &str) -> V {
    map(vec![
        ("country", s(name)),
        ("country_code", s(code)),
        ("asn", s(&format!("AS{number}"))),
        ("as_name", s(org)),
    ])
}

fn head(out: &mut Vec<u8>, ty: u8, size: usize) {
    let (first, extra): (u8, Vec<u8>) = if size < 29 {
        (size as u8, Vec::new())
    } else if size < 285 {
        (29, vec![(size - 29) as u8])
    } else {
        (30, ((size - 285) as u16).to_be_bytes().to_vec())
    };
    if ty <= 7 {
        out.push(ty << 5 | first);
    } else {
        out.push(first);
        out.push(ty - 7);
    }
    out.extend(extra);
}

fn uint(n: u64) -> Vec<u8> {
    let b = n.to_be_bytes();
    let skip = b.iter().take_while(|x| **x == 0).count();
    b[skip..].to_vec()
}

fn encode(v: &V, out: &mut Vec<u8>) {
    match v {
        V::S(x) => {
            head(out, 2, x.len());
            out.extend(x.as_bytes());
        }
        V::U16(n) => {
            let b = uint(u64::from(*n));
            head(out, 5, b.len());
            out.extend(b);
        }
        V::U32(n) => {
            let b = uint(u64::from(*n));
            head(out, 6, b.len());
            out.extend(b);
        }
        V::U64(n) => {
            let b = uint(*n);
            head(out, 9, b.len());
            out.extend(b);
        }
        V::Map(kv) => {
            head(out, 7, kv.len());
            for (k, v) in kv {
                encode(&V::S(k.clone()), out);
                encode(v, out);
            }
        }
        V::Arr(a) => {
            head(out, 11, a.len());
            for v in a {
                encode(v, out);
            }
        }
    }
}

#[derive(Clone, Copy)]
enum Child {
    Empty,
    Node(usize),
    Data(usize),
}

/// Write a database: `ip_version` 4 or 6 (IPv4 networks then live under
/// `::/96`), each network (`127.0.0.0/8`, `2001:db8::/32`) with its record.
pub fn write(
    path: &Path,
    ip_version: u16,
    database_type: &str,
    build_epoch: u64,
    entries: Vec<(&str, V)>,
) {
    let bits: u32 = if ip_version == 4 { 32 } else { 128 };
    let mut nodes: Vec<[Child; 2]> = vec![[Child::Empty, Child::Empty]];
    let mut data = Vec::new();
    let mut offsets = Vec::new();
    for (i, (cidr, value)) in entries.iter().enumerate() {
        offsets.push(data.len());
        encode(value, &mut data);
        let (addr, len) = cidr.split_once('/').unwrap();
        let len: u32 = len.parse().unwrap();
        let (addr, len) = match addr.parse::<IpAddr>().unwrap() {
            IpAddr::V4(v4) if bits == 128 => (u128::from(u32::from(v4)), len + 96),
            IpAddr::V4(v4) => (u128::from(u32::from(v4)), len),
            IpAddr::V6(v6) => (u128::from(v6), len),
        };
        let mut n = 0;
        for depth in 0..len {
            let bit = ((addr >> (bits - 1 - depth)) & 1) as usize;
            if depth == len - 1 {
                nodes[n][bit] = Child::Data(i);
                break;
            }
            n = match nodes[n][bit] {
                Child::Node(m) => m,
                other => {
                    // Split a less specific network (or open an empty branch).
                    nodes.push([other, other]);
                    let m = nodes.len() - 1;
                    nodes[n][bit] = Child::Node(m);
                    m
                }
            };
        }
    }
    let count = nodes.len();
    let record = |c: Child| -> u32 {
        (match c {
            Child::Empty => count,
            Child::Node(m) => m,
            Child::Data(i) => count + 16 + offsets[i],
        }) as u32
    };
    let mut out = Vec::new();
    for [l, r] in &nodes {
        out.extend(&record(*l).to_be_bytes()[1..]);
        out.extend(&record(*r).to_be_bytes()[1..]);
    }
    out.extend([0u8; 16]);
    out.extend(&data);
    out.extend(b"\xAB\xCD\xEFMaxMind.com");
    encode(
        &map(vec![
            ("binary_format_major_version", V::U16(2)),
            ("binary_format_minor_version", V::U16(0)),
            ("build_epoch", V::U64(build_epoch)),
            ("database_type", s(database_type)),
            ("description", map(vec![("en", s("urtorrentd test data"))])),
            ("ip_version", V::U16(ip_version)),
            ("languages", V::Arr(vec![s("en")])),
            ("node_count", V::U32(count as u32)),
            ("record_size", V::U16(24)),
        ]),
        &mut out,
    );
    // Write then rename, as a download would, so a reader never sees half.
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, out).unwrap();
    std::fs::rename(&tmp, path).unwrap();
}
