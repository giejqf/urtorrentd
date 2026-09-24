// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Per-peer attribution (ADR 0005): whose traffic it was, grouped by the
//! peer's country and autonomous system (0.6.0), and by its client, how it
//! was found, transport, encryption, IP version and who connected (0.7.0).
//! Each connection's counters are
//! differenced like a torrent's: the tick samples the peers of torrents that
//! moved data (every [`PEER_SAMPLE_EVERY`] seconds), and `PeerDisconnected`
//! brings a connection's final counters. Peer addresses stay in memory only.
//!
//! A connection is known by its address and start time (observation time
//! minus `connected_for`): a sample taken before a connection closed but
//! handled after its close event, or one of an earlier connection from the
//! same address, is recognised and not counted twice.

use std::collections::HashSet;
use std::net::{IpAddr, SocketAddr};

use urtorrent::{InfoHash, PeerInfo};

use super::{Acc, Stats};
use crate::geo::Location;
use crate::model::StatsStep;
use crate::util::normalize_ip;

/// Peers of active torrents are sampled this often, seconds.
pub(crate) const PEER_SAMPLE_EVERY: u64 = 10;
/// A closed or vanished connection is remembered this long, seconds (a late
/// sample or close event is matched against it).
const GRACE: u64 = 120;
/// Start times this close (seconds) are the same connection.
const SAME: u64 = 2;

/// One connection's counters at an observation, with what it is grouped by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PeerSample {
    /// Remote address.
    pub addr: SocketAddr,
    /// Payload bytes received on this connection.
    pub downloaded: u64,
    /// Payload bytes sent on this connection.
    pub uploaded: u64,
    /// Seconds connected.
    pub connected_for: u64,
    /// The client's name without its version (`qBittorrent`), if known.
    pub client: Option<String>,
    /// How the peer was found (`tracker`, `dht`, `pex`, `lsd`, `incoming`,
    /// `manual`, `resume`).
    pub source: &'static str,
    /// `tcp` or `utp`.
    pub transport: &'static str,
    /// RC4-encrypted (MSE).
    pub encrypted: bool,
    /// The peer connected to us.
    pub incoming: bool,
}

impl PeerSample {
    /// From the library's snapshot.
    pub(crate) fn of(p: &PeerInfo) -> PeerSample {
        use urtorrent::{PeerSource as S, PeerTransport as T};
        PeerSample {
            addr: p.addr,
            downloaded: p.downloaded,
            uploaded: p.uploaded,
            connected_for: p.connected_for.as_secs(),
            client: client_family(p.client.as_deref(), p.peer_id.as_ref()),
            source: match p.source {
                S::Tracker => "tracker",
                S::Dht => "dht",
                S::Pex => "pex",
                S::Lsd => "lsd",
                S::Incoming => "incoming",
                S::Manual => "manual",
                S::Resume => "resume",
            },
            transport: match p.transport {
                T::Tcp => "tcp",
                T::Utp => "utp",
                _ => "other",
            },
            encrypted: p.encrypted,
            incoming: p.incoming,
        }
    }
}

/// Azureus-style peer id prefixes (`-qB4620-`) of common clients, for peers
/// that send no client name.
const CLIENT_CODES: &[(&[u8; 2], &str)] = &[
    (b"qB", "qBittorrent"),
    (b"TR", "Transmission"),
    (b"UT", "\u{b5}Torrent"),
    (b"LT", "libtorrent"),
    (b"lt", "rTorrent"),
    (b"DE", "Deluge"),
    (b"BI", "BiglyBT"),
    (b"AZ", "Vuze"),
    (b"UR", "urtorrent"),
    (b"BT", "BitTorrent"),
];

/// A client's name without its version: `qBittorrent/4.6.2` and
/// `qBittorrent 4.6.2` are `qBittorrent`. Peers send anything here: the
/// result is bounded and printable.
pub(crate) fn client_family(client: Option<&str>, peer_id: Option<&[u8; 20]>) -> Option<String> {
    if let Some(c) = client {
        let mut end = c.len();
        for (i, ch) in c.char_indices() {
            if ch == '/' || ch == ' ' {
                let rest = c[i + ch.len_utf8()..].trim_start_matches('v');
                if rest.starts_with(|r: char| r.is_ascii_digit()) {
                    end = i;
                    break;
                }
            }
        }
        let name: String = c[..end]
            .chars()
            .filter(|ch| !ch.is_control())
            .take(40)
            .collect();
        let name = name.trim();
        if !name.is_empty() {
            return Some(name.to_string());
        }
    }
    let id = peer_id?;
    if id[0] == b'-' && id[7] == b'-' {
        return CLIENT_CODES
            .iter()
            .find(|(code, _)| id[1..3] == code[..])
            .map(|(_, name)| (*name).to_string());
    }
    None
}

/// What peer traffic is grouped by.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) enum Dim {
    Country,
    Asn,
    Client,
    Source,
    Transport,
    Encryption,
    IpVersion,
    Direction,
}

impl Dim {
    /// As stored.
    pub(crate) fn tag(self) -> &'static str {
        match self {
            Dim::Country => "country",
            Dim::Asn => "asn",
            Dim::Client => "client",
            Dim::Source => "source",
            Dim::Transport => "transport",
            Dim::Encryption => "encryption",
            Dim::IpVersion => "ip_version",
            Dim::Direction => "direction",
        }
    }
}

/// A connection as last observed.
#[derive(Debug, Clone, Copy)]
pub(super) struct Conn {
    start: u64,
    downloaded: u64,
    uploaded: u64,
    closed_at: Option<u64>,
    missing_since: Option<u64>,
}

/// Peer traffic of one torrent in one bucket, by dimension and key.
pub(super) type PeerKey = (InfoHash, StatsStep, u64, Dim, String);

impl Acc {
    /// Count what a connection moved since it was last observed; `closed`:
    /// these are its final counters.
    fn account(
        &mut self,
        t: u64,
        hash: InfoHash,
        p: &PeerSample,
        closed: bool,
        locate: &dyn Fn(IpAddr) -> Location,
    ) {
        let start = t.saturating_sub(p.connected_for);
        let since = self.since;
        let conns = self.conns.entry(hash).or_default();
        let (base, start) = match conns.get(&p.addr) {
            Some(c) if start.abs_diff(c.start) <= SAME => {
                if c.closed_at.is_some() {
                    // Sampled before it closed, handled after.
                    return;
                }
                ((c.downloaded, c.uploaded), c.start)
            }
            // A sample of an earlier connection from this address.
            Some(c) if start < c.start => return,
            // Connected before recording started: a baseline only.
            _ if start + SAME < since => ((p.downloaded, p.uploaded), start),
            _ => ((0, 0), start),
        };
        let down = p.downloaded.saturating_sub(base.0);
        let up = p.uploaded.saturating_sub(base.1);
        conns.insert(
            p.addr,
            Conn {
                start,
                downloaded: p.downloaded.max(base.0),
                uploaded: p.uploaded.max(base.1),
                closed_at: closed.then_some(t),
                missing_since: None,
            },
        );
        if down > 0 || up > 0 {
            let ip = normalize_ip(p.addr.ip());
            self.attribute(t, hash, p, ip, down, up, &locate(ip));
        }
    }

    #[allow(clippy::too_many_arguments)]
    fn attribute(
        &mut self,
        t: u64,
        hash: InfoHash,
        p: &PeerSample,
        ip: IpAddr,
        down: u64,
        up: u64,
        loc: &Location,
    ) {
        if let (Some(asn), Some(org)) = (loc.asn, &loc.as_org)
            && self.asn_names.get(&asn) != Some(org)
        {
            self.asn_names.insert(asn, org.clone());
            self.asn_pending.push((asn, org.clone()));
        }
        let keys = [
            (Dim::Country, loc.country.clone().unwrap_or_default()),
            (Dim::Asn, loc.asn.map(|n| n.to_string()).unwrap_or_default()),
            (Dim::Client, p.client.clone().unwrap_or_default()),
            (Dim::Source, p.source.to_string()),
            (Dim::Transport, p.transport.to_string()),
            (
                Dim::Encryption,
                if p.encrypted { "rc4" } else { "plaintext" }.to_string(),
            ),
            (
                Dim::IpVersion,
                if ip.is_ipv4() { "ipv4" } else { "ipv6" }.to_string(),
            ),
            (
                Dim::Direction,
                if p.incoming { "incoming" } else { "outgoing" }.to_string(),
            ),
        ];
        for step in [StatsStep::Hour, StatsStep::Day] {
            let bucket = step.start(t);
            let first = self
                .counted
                .entry((hash, step, bucket))
                .or_default()
                .insert(ip);
            for (dim, key) in &keys {
                let e = self
                    .peer_traffic
                    .entry((hash, step, bucket, *dim, key.clone()))
                    .or_default();
                e.downloaded = e.downloaded.saturating_add(down);
                e.uploaded = e.uploaded.saturating_add(up);
                if first {
                    e.peers = e.peers.saturating_add(1);
                }
            }
        }
    }

    /// Forget closed and vanished connections after [`GRACE`], and the
    /// address sets of buckets that are over.
    pub(super) fn tidy_peers(&mut self, now: u64) {
        let old = |at: Option<u64>| at.is_some_and(|at| at + GRACE < now);
        self.conns.retain(|_, conns| {
            conns.retain(|_, c| !old(c.closed_at) && !old(c.missing_since));
            !conns.is_empty()
        });
        self.counted
            .retain(|(_, step, bucket), _| *bucket >= step.start(now));
    }
}

impl Stats {
    /// Torrents whose counters moved since their peers were last sampled
    /// (and forget them until they move again).
    pub(crate) fn take_active(&self) -> Vec<InfoHash> {
        let mut a = self.acc();
        if a.period.is_none() {
            a.active.clear();
            return Vec::new();
        }
        a.active.drain().collect()
    }

    /// A sample of a torrent's connections.
    pub(crate) fn observe_peers(
        &self,
        t: u64,
        hash: InfoHash,
        peers: &[PeerSample],
        locate: &dyn Fn(IpAddr) -> Location,
    ) {
        let mut a = self.acc();
        // Not recording, or removed while the sample was taken.
        if a.period.is_none() || !a.seen.contains_key(&hash) {
            return;
        }
        for p in peers {
            a.account(t, hash, p, false, locate);
        }
        if let Some(conns) = a.conns.get_mut(&hash) {
            let present: HashSet<SocketAddr> = peers.iter().map(|p| p.addr).collect();
            for (addr, c) in conns.iter_mut() {
                if c.closed_at.is_none() && !present.contains(addr) {
                    c.missing_since.get_or_insert(t);
                }
            }
        }
    }

    /// A connection closed with these final counters.
    pub(crate) fn peer_closed(
        &self,
        t: u64,
        hash: InfoHash,
        p: &PeerSample,
        locate: &dyn Fn(IpAddr) -> Location,
    ) {
        let mut a = self.acc();
        if a.period.is_some() {
            a.account(t, hash, p, true, locate);
        }
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use std::collections::HashMap;

    use super::*;
    use crate::stats::Stats;

    const H: InfoHash = [7; 20];

    fn loc(ip: IpAddr) -> Location {
        Location {
            country: Some(
                if ip.to_string().ends_with(".1") {
                    "NZ"
                } else {
                    "AU"
                }
                .into(),
            ),
            asn: Some(64_500),
            as_org: Some("Test Net".into()),
        }
    }

    fn sample(addr: &str, down: u64, up: u64, connected_for: u64) -> PeerSample {
        PeerSample {
            addr: addr.parse().unwrap(),
            downloaded: down,
            uploaded: up,
            connected_for,
            client: Some("qBittorrent".into()),
            source: "dht",
            transport: "tcp",
            encrypted: false,
            incoming: false,
        }
    }

    #[test]
    fn client_names_lose_their_versions() {
        let f = |c: &str| client_family(Some(c), None);
        assert_eq!(f("qBittorrent/4.6.2").as_deref(), Some("qBittorrent"));
        assert_eq!(f("Transmission 4.0.5").as_deref(), Some("Transmission"));
        assert_eq!(f("\u{b5}Torrent 3.5.5").as_deref(), Some("\u{b5}Torrent"));
        assert_eq!(
            f("Deluge/2.1.1 libtorrent/2.0.9").as_deref(),
            Some("Deluge")
        );
        assert_eq!(f("BitTorrent v7.10").as_deref(), Some("BitTorrent"));
        assert_eq!(f("Tixati").as_deref(), Some("Tixati"));
        assert_eq!(f("Some Client 2").as_deref(), Some("Some Client"));
        assert_eq!(f(&"x".repeat(100)).map(|s| s.len()), Some(40));
        assert_eq!(f("bad\u{7}name 1").as_deref(), Some("badname"));
        let id = |p: &[u8; 8]| {
            let mut a = [b'0'; 20];
            a[..8].copy_from_slice(p);
            a
        };
        assert_eq!(
            client_family(None, Some(&id(b"-qB4620-"))).as_deref(),
            Some("qBittorrent")
        );
        assert_eq!(
            client_family(Some(" "), Some(&id(b"-TR4050-"))).as_deref(),
            Some("Transmission")
        );
        assert_eq!(client_family(None, Some(&id(b"-ZZ0000-"))), None);
        assert_eq!(client_family(None, Some(&[b'M'; 20])), None);
    }

    fn country_totals(s: &Stats) -> HashMap<String, (u64, u64, u32)> {
        let a = s.acc();
        let mut out = HashMap::new();
        for ((_, step, _, dim, key), x) in &a.peer_traffic {
            if *step == StatsStep::Hour && *dim == Dim::Country {
                let e = out.entry(key.clone()).or_insert((0, 0, 0));
                e.0 += x.downloaded;
                e.1 += x.uploaded;
                e.2 += x.peers;
            }
        }
        out
    }

    #[test]
    fn connections_are_counted_once() {
        let dir = tempfile::tempdir().unwrap();
        let s = Stats::open(dir.path(), true, 1_000).unwrap();
        s.acc().seen.insert(H, Default::default());
        // Sampled twice, then closed: 100 up in all.
        s.observe_peers(1_010, H, &[sample("10.0.0.1:6881", 0, 40, 5)], &loc);
        s.observe_peers(1_020, H, &[sample("10.0.0.1:6881", 0, 70, 15)], &loc);
        s.peer_closed(1_025, H, &sample("10.0.0.1:6881", 0, 100, 20), &loc);
        // A sample taken before the close, handled after it: ignored.
        s.observe_peers(1_026, H, &[sample("10.0.0.1:6881", 0, 90, 21)], &loc);
        // A new connection from the same address counts from zero.
        s.observe_peers(1_060, H, &[sample("10.0.0.1:6881", 5, 10, 3)], &loc);
        // A connection that was never sampled closes: all of it counts.
        s.peer_closed(1_070, H, &sample("10.0.0.2:6881", 0, 30, 8), &loc);
        let t = country_totals(&s);
        assert_eq!(t["NZ"], (5, 110, 1), "one address, counted once per bucket");
        assert_eq!(t["AU"], (0, 30, 1));
        assert_eq!(s.acc().asn_pending, vec![(64_500, "Test Net".to_string())]);
    }

    #[test]
    fn connections_older_than_the_recording_are_baselines() {
        let dir = tempfile::tempdir().unwrap();
        let s = Stats::open(dir.path(), true, 1_000).unwrap();
        s.acc().seen.insert(H, Default::default());
        // Up for 100 s when first seen at 1 010: it predates the period.
        s.observe_peers(1_010, H, &[sample("10.0.0.1:6881", 0, 500, 100)], &loc);
        s.observe_peers(1_020, H, &[sample("10.0.0.1:6881", 0, 520, 110)], &loc);
        assert_eq!(country_totals(&s)["NZ"], (0, 20, 1));
        // A torrent that is not observed (removed) is not sampled.
        let other: InfoHash = [8; 20];
        s.observe_peers(1_030, other, &[sample("10.0.0.3:6881", 0, 9, 1)], &loc);
        assert!(!country_totals(&s).contains_key("AU"));
    }

    #[test]
    fn vanished_connections_are_forgotten_after_a_grace_period() {
        let dir = tempfile::tempdir().unwrap();
        let s = Stats::open(dir.path(), true, 1_000).unwrap();
        s.acc().seen.insert(H, Default::default());
        s.observe_peers(1_010, H, &[sample("10.0.0.1:6881", 0, 40, 5)], &loc);
        s.observe_peers(1_020, H, &[], &loc);
        s.acc().tidy_peers(1_100);
        assert_eq!(s.acc().conns[&H].len(), 1);
        s.acc().tidy_peers(1_200);
        assert!(s.acc().conns.is_empty());
    }
}
