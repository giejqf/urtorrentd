// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Network interfaces: the list (`GET /app/interfaces`), and the listen
//! addresses of the settings, with `listen_interface` resolved (the library
//! takes addresses, `../urtorrent/docs/config.md`).

use std::collections::BTreeMap;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use crate::model::NetworkInterface;
use crate::settings::Settings;

/// Every interface with its addresses, by name.
pub fn list() -> std::io::Result<Vec<NetworkInterface>> {
    let mut by_name: BTreeMap<String, NetworkInterface> = BTreeMap::new();
    for i in if_addrs::get_if_addrs()? {
        let e = by_name
            .entry(i.name.clone())
            .or_insert_with(|| NetworkInterface {
                name: i.name.clone(),
                addresses: Vec::new(),
                up: false,
            });
        e.up |= i.is_oper_up();
        e.addresses.push(i.ip().to_string());
    }
    Ok(by_name.into_values().collect())
}

/// An interface's usable addresses: the first IPv4 and the first IPv6 that
/// are not link-local.
fn addresses_of(name: &str) -> (Option<Ipv4Addr>, Option<Ipv6Addr>) {
    let mut v4 = None;
    let mut v6 = None;
    for i in if_addrs::get_if_addrs().unwrap_or_default() {
        if i.name != name || i.is_link_local() {
            continue;
        }
        match i.ip() {
            IpAddr::V4(a) => {
                v4.get_or_insert(a);
            }
            IpAddr::V6(a) => {
                v6.get_or_insert(a);
            }
        }
    }
    (v4, v6)
}

/// The addresses to listen on: `listen_v4` / `listen_v6`, or with
/// `listen_interface` that interface's in the families they enable. An
/// interface with none of them gives loopback only: nothing leaves through
/// another interface while it is down.
pub fn listen_addresses(s: &Settings) -> (Option<Ipv4Addr>, Option<Ipv6Addr>) {
    let Some(name) = &s.listen_interface else {
        return (s.listen_v4, s.listen_v6);
    };
    let (v4, v6) = addresses_of(name);
    let v4 = v4.filter(|_| s.listen_v4.is_some());
    let v6 = v6.filter(|_| s.listen_v6.is_some());
    if v4.is_none() && v6.is_none() {
        (Some(Ipv4Addr::LOCALHOST), None)
    } else {
        (v4, v6)
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn loopback_is_listed_and_unknown_interfaces_fall_back_to_it() {
        let all = list().unwrap();
        let lo = all.iter().find(|i| i.name == "lo").unwrap();
        assert!(lo.addresses.contains(&"127.0.0.1".to_string()), "{lo:?}");
        let mut s = Settings {
            listen_interface: Some("lo".into()),
            ..Settings::default()
        };
        assert_eq!(listen_addresses(&s).0, Some(Ipv4Addr::LOCALHOST));
        s.listen_v4 = None;
        s.listen_interface = Some("no-such-interface0".into());
        assert_eq!(listen_addresses(&s), (Some(Ipv4Addr::LOCALHOST), None));
        s.listen_interface = None;
        s.listen_v6 = Some(Ipv6Addr::LOCALHOST);
        assert_eq!(listen_addresses(&s), (None, Some(Ipv6Addr::LOCALHOST)));
    }
}
