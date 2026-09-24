// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Small helpers shared by the daemon and the API.

use std::net::IpAddr;
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

impl Cidr {
    /// The first and last address of the block.
    pub fn range(&self) -> (IpAddr, IpAddr) {
        match self.net {
            IpAddr::V4(n) => {
                let bits = u32::from(n);
                let mask = u32::MAX
                    .checked_shl(32 - u32::from(self.prefix))
                    .unwrap_or(0);
                (
                    IpAddr::V4((bits & mask).into()),
                    IpAddr::V4((bits | !mask).into()),
                )
            }
            IpAddr::V6(n) => {
                let bits = u128::from(n);
                let mask = u128::MAX
                    .checked_shl(128 - u32::from(self.prefix))
                    .unwrap_or(0);
                (
                    IpAddr::V6((bits & mask).into()),
                    IpAddr::V6((bits | !mask).into()),
                )
            }
        }
    }
}

/// Parse an address range: a block (`10.0.0.0/8`, a bare address) or
/// `first-last` in one family with `first <= last`.
pub fn parse_ip_range(s: &str) -> Option<(IpAddr, IpAddr)> {
    if let Some((a, b)) = s.split_once('-') {
        let a: IpAddr = a.trim().parse().ok()?;
        let b: IpAddr = b.trim().parse().ok()?;
        return (a.is_ipv4() == b.is_ipv4() && a <= b).then_some((a, b));
    }
    Cidr::parse(s).map(|c| c.range())
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

/// A wildcard pattern (`*` any text, `?` any character, case ignored) as a
/// regular expression matching a whole name.
pub fn wildcard(pattern: &str) -> Result<regex::Regex, String> {
    if pattern.is_empty() || pattern.len() > 256 {
        return Err(format!("{pattern:?}: a pattern is 1 to 256 bytes"));
    }
    let mut re = String::from("^");
    for c in pattern.chars() {
        match c {
            '*' => re.push_str(".*"),
            '?' => re.push('.'),
            c => re.push_str(&regex::escape(&c.to_string())),
        }
    }
    re.push('$');
    regex::RegexBuilder::new(&re)
        .case_insensitive(true)
        .size_limit(1 << 20)
        .build()
        .map_err(|e| format!("{pattern:?}: {e}"))
}

/// A present patch field (even `null`) is `Some`, an absent one `None`
/// (with `#[serde(default)]` on the field).
pub fn patch_field<'de, D: serde::Deserializer<'de>, T: serde::Deserialize<'de>>(
    d: D,
) -> Result<Option<T>, D::Error> {
    T::deserialize(d).map(Some)
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
    fn ranges() {
        let r = |s: &str| parse_ip_range(s).map(|(a, b)| (a.to_string(), b.to_string()));
        assert_eq!(
            r("10.1.0.0/16"),
            Some(("10.1.0.0".into(), "10.1.255.255".into()))
        );
        assert_eq!(
            r("10.1.2.3/16"),
            Some(("10.1.0.0".into(), "10.1.255.255".into()))
        );
        assert_eq!(
            r("0.0.0.0/0"),
            Some(("0.0.0.0".into(), "255.255.255.255".into()))
        );
        assert_eq!(r("1.2.3.4"), Some(("1.2.3.4".into(), "1.2.3.4".into())));
        assert_eq!(
            r("fd00::/8"),
            Some((
                "fd00::".into(),
                "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff".into()
            ))
        );
        assert_eq!(
            r("1.2.3.0-1.2.4.255"),
            Some(("1.2.3.0".into(), "1.2.4.255".into()))
        );
        assert_eq!(r("1.2.4.0-1.2.3.0"), None);
        assert_eq!(r("1.2.3.4-fd00::1"), None);
        assert_eq!(r("nope"), None);
    }

    #[test]
    fn encoding() {
        assert_eq!(percent_encode("a b/c"), "a%20b%2Fc");
    }
}
