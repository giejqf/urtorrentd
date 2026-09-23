// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Small helpers shared by the daemon and the API.

use std::io::Write;
use std::net::IpAddr;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use urtorrent::InfoHash;

/// Seconds since the unix epoch.
pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Lowercase hex.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push(char::from(DIGITS[usize::from(b >> 4)]));
        s.push(char::from(DIGITS[usize::from(b & 0x0f)]));
    }
    s
}

/// Parse a 40-character hex info-hash (either case).
pub fn parse_hash(s: &str) -> Option<InfoHash> {
    let b = s.as_bytes();
    if b.len() != 40 {
        return None;
    }
    let mut out = [0u8; 20];
    for (i, [hi, lo]) in b.as_chunks::<2>().0.iter().enumerate() {
        *out.get_mut(i)? = (hex_val(*hi)? << 4) | hex_val(*lo)?;
    }
    Some(out)
}

fn hex_val(c: u8) -> Option<u8> {
    match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        b'A'..=b'F' => Some(c - b'A' + 10),
        _ => None,
    }
}

/// `N` bytes from the OS random source.
pub fn random_bytes<const N: usize>() -> std::io::Result<[u8; N]> {
    let mut b = [0u8; N];
    getrandom::fill(&mut b).map_err(|e| std::io::Error::other(e.to_string()))?;
    Ok(b)
}

/// Write `data` to `path` atomically: a temporary file in the same directory,
/// `fsync`, rename over the target, then `fsync` the directory (AGENTS.md 4.8).
pub fn atomic_write(path: &Path, data: &[u8]) -> std::io::Result<()> {
    let dir = path
        .parent()
        .ok_or_else(|| std::io::Error::other("path has no parent directory"))?;
    std::fs::create_dir_all(dir)?;
    let name = path
        .file_name()
        .ok_or_else(|| std::io::Error::other("path has no file name"))?
        .to_string_lossy();
    let tmp = dir.join(format!(".{name}.tmp"));
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(data)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)?;
    std::fs::File::open(dir)?.sync_all()
}

/// Remove a file, treating "already gone" as success.
pub fn remove_file(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        other => other,
    }
}

/// Percent-encode everything but RFC 3986 unreserved characters.
pub fn percent_encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || matches!(b, b'-' | b'.' | b'_' | b'~') {
            out.push(char::from(b));
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// An address block (`10.0.0.0/8`, `fd00::/8`, or a single address).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Cidr {
    net: IpAddr,
    prefix: u8,
}

impl Cidr {
    /// Parse `addr/prefix` or a bare address.
    pub fn parse(s: &str) -> Option<Cidr> {
        let (addr, prefix) = match s.split_once('/') {
            Some((a, p)) => (a.trim(), Some(p.trim().parse::<u8>().ok()?)),
            None => (s.trim(), None),
        };
        let net: IpAddr = addr.parse().ok()?;
        let max = if net.is_ipv4() { 32 } else { 128 };
        let prefix = prefix.unwrap_or(max);
        (prefix <= max).then_some(Cidr { net, prefix })
    }

    /// Whether `ip` lies in the block (an IPv4-mapped IPv6 address counts as
    /// IPv4).
    pub fn contains(&self, ip: IpAddr) -> bool {
        let ip = normalize_ip(ip);
        match (self.net, ip) {
            (IpAddr::V4(n), IpAddr::V4(a)) => {
                prefix_eq(&n.octets(), &a.octets(), usize::from(self.prefix))
            }
            (IpAddr::V6(n), IpAddr::V6(a)) => {
                prefix_eq(&n.octets(), &a.octets(), usize::from(self.prefix))
            }
            _ => false,
        }
    }
}

fn prefix_eq(a: &[u8], b: &[u8], bits: usize) -> bool {
    let full = bits / 8;
    if a.get(..full) != b.get(..full) {
        return false;
    }
    let rem = bits % 8;
    if rem == 0 {
        return true;
    }
    let mask = 0xffu8 << (8 - rem);
    match (a.get(full), b.get(full)) {
        (Some(x), Some(y)) => x & mask == y & mask,
        _ => false,
    }
}

/// Map an IPv4-mapped IPv6 address back to IPv4.
pub fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => v6
            .to_ipv4_mapped()
            .map(IpAddr::V4)
            .unwrap_or(IpAddr::V6(v6)),
        v4 => v4,
    }
}

/// Run blocking work (file I/O) off the async runtime.
pub async fn blocking<T, F>(f: F) -> std::io::Result<T>
where
    F: FnOnce() -> std::io::Result<T> + Send + 'static,
    T: Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| std::io::Error::other(e.to_string()))?
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn hash_round_trip() {
        let h = [0xabu8; 20];
        assert_eq!(parse_hash(&hex(&h)), Some(h));
        assert_eq!(parse_hash(&hex(&h).to_uppercase()), Some(h));
        assert_eq!(parse_hash("abc"), None);
        assert_eq!(parse_hash(&"g".repeat(40)), None);
    }

    #[test]
    fn cidr() {
        let c = Cidr::parse("10.1.0.0/16").unwrap();
        assert!(c.contains("10.1.2.3".parse().unwrap()));
        assert!(!c.contains("10.2.0.1".parse().unwrap()));
        assert!(c.contains("::ffff:10.1.9.9".parse().unwrap()));
        let c = Cidr::parse("fd00::/8").unwrap();
        assert!(c.contains("fd12::1".parse().unwrap()));
        assert!(!c.contains("fe80::1".parse().unwrap()));
        assert!(
            Cidr::parse("1.2.3.4")
                .unwrap()
                .contains("1.2.3.4".parse().unwrap())
        );
        assert!(Cidr::parse("1.2.3.4/33").is_none());
        let c = Cidr::parse("192.168.1.0/25").unwrap();
        assert!(c.contains("192.168.1.127".parse().unwrap()));
        assert!(!c.contains("192.168.1.128".parse().unwrap()));
    }

    #[test]
    fn encoding() {
        assert_eq!(percent_encode("a b/c"), "a%20b%2Fc");
    }
}
