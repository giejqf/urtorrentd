// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! The daemon's own network conveniences: the cookie jar for its HTTP
//! requests (qBittorrent's `app/cookies`), the tracker list fetched from
//! `add_trackers_url`, and following `listen_interface` as its addresses
//! change.

use std::net::{Ipv4Addr, Ipv6Addr};
use std::sync::{Arc, MutexGuard};
use std::time::{Duration, Instant};

use super::Daemon;
use crate::error::{ApiError, ApiResult};
use crate::model::{Cookie, FetchedTrackers};
use crate::settings::valid_tracker_url;
use crate::store;
use crate::util::{blocking, now};

/// Cookies kept at most.
const MAX_COOKIES: usize = 1000;
/// The tracker list is fetched this often (and an hour after a failure).
const TRACKERS_EVERY: Duration = Duration::from_secs(24 * 3600);
const TRACKERS_RETRY: Duration = Duration::from_secs(3600);
/// Largest tracker list read.
const MAX_TRACKER_LIST: usize = 1024 * 1024;
/// Trackers taken from a list at most.
const MAX_TRACKERS: usize = 1000;

/// A fetched tracker list.
#[derive(Debug, Clone)]
struct TrackerList {
    url: String,
    trackers: Vec<String>,
    fetched: Option<u64>,
    error: Option<String>,
    tried: Instant,
    fetching: bool,
}

/// What this module keeps.
#[derive(Debug, Default)]
pub(crate) struct NetState {
    cookies: Vec<Cookie>,
    trackers: Option<TrackerList>,
    /// The listen addresses in force.
    listening: Option<(Option<Ipv4Addr>, Option<Ipv6Addr>)>,
}

impl NetState {
    /// With the stored cookies and the addresses the engine started with.
    pub(crate) fn new(
        cookies: Vec<Cookie>,
        listening: (Option<Ipv4Addr>, Option<Ipv6Addr>),
    ) -> Self {
        NetState {
            cookies,
            trackers: None,
            listening: Some(listening),
        }
    }
}

fn check_cookie(c: &Cookie) -> ApiResult<()> {
    let bad = |what: &str| {
        Err(ApiError::bad_request(format!(
            "cookie {:?}: {what}",
            c.name
        )))
    };
    let token = |s: &str| {
        !s.chars()
            .any(|ch| ch.is_control() || ch.is_whitespace() || ";,=".contains(ch))
    };
    if c.name.is_empty() || c.name.len() > 256 || !token(&c.name) {
        return bad("a name is 1 to 256 characters without spaces, `;`, `,` or `=`");
    }
    if c.value.len() > 4096 || c.value.chars().any(|ch| ch.is_control() || ch == ';') {
        return bad("a value is at most 4096 characters without `;`");
    }
    let domain = c.domain.trim_start_matches('.');
    if domain.is_empty() || domain.len() > 253 || domain.contains(['/', ' ', ':']) {
        return bad("the domain is a host name");
    }
    if !c.path.starts_with('/') {
        return bad("the path starts with /");
    }
    Ok(())
}

/// Whether a cookie goes with a request for `host` and `path` at `now`.
fn cookie_for(c: &Cookie, host: &str, path: &str, now: u64) -> bool {
    let domain = c.domain.trim_start_matches('.').to_ascii_lowercase();
    let host = host.to_ascii_lowercase();
    (host == domain || host.ends_with(&format!(".{domain}")))
        && path.starts_with(&c.path)
        && c.expires.is_none_or(|e| e > now)
}

/// A tracker list: one URL per line; blank lines and `#` comments skipped.
fn parse_trackers(body: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for line in body.lines().map(str::trim) {
        if line.is_empty() || line.starts_with('#') || !valid_tracker_url(line) {
            continue;
        }
        if !out.iter().any(|t| t == line) {
            out.push(line.to_string());
        }
        if out.len() >= MAX_TRACKERS {
            break;
        }
    }
    out
}

impl Daemon {
    fn net(&self) -> MutexGuard<'_, NetState> {
        self.net.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The cookie jar.
    pub(crate) fn cookies(&self) -> Vec<Cookie> {
        self.net().cookies.clone()
    }

    /// Replace the cookie jar.
    pub(crate) async fn set_cookies(&self, cookies: Vec<Cookie>) -> ApiResult<()> {
        if cookies.len() > MAX_COOKIES {
            return Err(ApiError::bad_request(format!(
                "{MAX_COOKIES} cookies at most"
            )));
        }
        for c in &cookies {
            check_cookie(c)?;
        }
        let _ops = self.ops.lock().await;
        let (s, list) = (self.store.clone(), cookies.clone());
        blocking(move || s.save(store::COOKIES, &list)).await?;
        self.net().cookies = cookies;
        Ok(())
    }

    /// The `Cookie` header for a request to `url`, from the jar.
    pub(crate) fn cookie_header(&self, url: &str) -> Option<String> {
        let u = reqwest::Url::parse(url).ok()?;
        let host = u.host_str()?;
        let t = now();
        let pairs: Vec<String> = self
            .net()
            .cookies
            .iter()
            .filter(|c| cookie_for(c, host, u.path(), t))
            .map(|c| format!("{}={}", c.name, c.value))
            .collect();
        (!pairs.is_empty()).then(|| pairs.join("; "))
    }

    /// The trackers fetched from `add_trackers_url` (none while it is off).
    pub(crate) fn fetched_trackers(&self) -> Vec<String> {
        let url = self.settings().add_trackers_url;
        match (&self.net().trackers, url) {
            (Some(l), Some(u)) if l.url == u => l.trackers.clone(),
            _ => Vec::new(),
        }
    }

    /// What `GET /app` shows of the fetched list.
    pub(crate) fn fetched_trackers_info(&self) -> Option<FetchedTrackers> {
        let url = self.settings().add_trackers_url?;
        let net = self.net();
        let l = net.trackers.as_ref().filter(|l| l.url == url);
        Some(FetchedTrackers {
            url,
            trackers: l.map(|l| l.trackers.clone()).unwrap_or_default(),
            fetched: l.and_then(|l| l.fetched),
            error: l.and_then(|l| l.error.clone()),
            fetching: l.is_some_and(|l| l.fetching),
        })
    }

    /// Fetch the tracker list when it is due (the tick).
    pub(crate) fn tracker_list_tick(self: &Arc<Self>) {
        self.fetch_tracker_list_if_due(false);
    }

    /// Fetch the tracker list now, unless a fetch is under way
    /// (`POST /app/fetched-trackers/refresh`).
    pub(crate) fn refresh_tracker_list(self: &Arc<Self>) -> ApiResult<()> {
        if self.settings().add_trackers_url.is_none() {
            return Err(ApiError::conflict("add_trackers_url is not set"));
        }
        self.fetch_tracker_list_if_due(true);
        Ok(())
    }

    fn fetch_tracker_list_if_due(self: &Arc<Self>, now_please: bool) {
        let Some(url) = self.settings().add_trackers_url else {
            return;
        };
        {
            let mut net = self.net();
            let due = match &net.trackers {
                Some(l) if l.url == url => {
                    let every = if l.error.is_some() {
                        TRACKERS_RETRY
                    } else {
                        TRACKERS_EVERY
                    };
                    !l.fetching && (now_please || l.tried.elapsed() >= every)
                }
                _ => true,
            };
            if !due {
                return;
            }
            let keep = net.trackers.take().filter(|l| l.url == url);
            net.trackers = Some(TrackerList {
                url: url.clone(),
                trackers: keep
                    .as_ref()
                    .map(|l| l.trackers.clone())
                    .unwrap_or_default(),
                fetched: keep.and_then(|l| l.fetched),
                error: None,
                tried: Instant::now(),
                fetching: true,
            });
        }
        let d = self.clone();
        tokio::spawn(async move {
            let r = d.fetch_tracker_list(&url).await;
            let mut net = d.net();
            if let Some(l) = net.trackers.as_mut().filter(|l| l.url == url) {
                l.fetching = false;
                match r {
                    Ok(list) => {
                        l.trackers = list;
                        l.fetched = Some(now());
                        l.error = None;
                    }
                    Err(e) => l.error = Some(e),
                }
            }
        });
    }

    async fn fetch_tracker_list(&self, url: &str) -> Result<Vec<String>, String> {
        let mut req = self.http.get(url);
        if let Some(c) = self.cookie_header(url) {
            req = req.header(reqwest::header::COOKIE, c);
        }
        let mut resp = req.send().await.map_err(|e| e.without_url().to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        let mut body = Vec::new();
        while let Some(chunk) = resp
            .chunk()
            .await
            .map_err(|e| e.without_url().to_string())?
        {
            if body.len() + chunk.len() > MAX_TRACKER_LIST {
                return Err("larger than 1 MiB".into());
            }
            body.extend_from_slice(&chunk);
        }
        Ok(parse_trackers(&String::from_utf8_lossy(&body)))
    }

    /// The listen addresses in force.
    pub(crate) fn listening(&self) -> (Option<Ipv4Addr>, Option<Ipv6Addr>) {
        self.net().listening.unwrap_or_default()
    }

    /// After a settings change applied new listen addresses.
    pub(crate) fn set_listening(&self, addrs: (Option<Ipv4Addr>, Option<Ipv6Addr>)) {
        self.net().listening = Some(addrs);
    }

    /// Follow `listen_interface` as its addresses change (the tick).
    pub(crate) async fn interface_tick(&self) {
        let s = self.settings();
        let Some(name) = &s.listen_interface else {
            return;
        };
        let want = crate::interfaces::listen_addresses(&s);
        if Some(want) == self.net().listening {
            return;
        }
        match self.session.set_listen(s.listen_port, want.0, want.1).await {
            Ok(_) => {
                self.set_listening(want);
                let shown: Vec<String> =
                    [want.0.map(|a| a.to_string()), want.1.map(|a| a.to_string())]
                        .into_iter()
                        .flatten()
                        .collect();
                if want == (Some(Ipv4Addr::LOCALHOST), None) {
                    self.logs.warn(format!(
                        "interface {name} has no address: listening on loopback only"
                    ));
                } else {
                    self.logs.info(format!(
                        "interface {name}: listening on {}",
                        shown.join(", ")
                    ));
                }
            }
            Err(e) => self.logs.warn(format!("interface {name}: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cookie(domain: &str, path: &str, expires: Option<u64>) -> Cookie {
        Cookie {
            name: "uid".into(),
            value: "1".into(),
            domain: domain.into(),
            path: path.into(),
            expires,
        }
    }

    #[test]
    fn cookies_go_to_their_domain_and_path() {
        let c = cookie(".tracker.example", "/rss", None);
        assert!(cookie_for(&c, "tracker.example", "/rss/feed", 0));
        assert!(cookie_for(&c, "www.Tracker.example", "/rss", 0));
        assert!(!cookie_for(&c, "eviltracker.example", "/rss", 0));
        assert!(!cookie_for(&c, "tracker.example", "/dl", 0));
        assert!(!cookie_for(
            &cookie("tracker.example", "/", Some(10)),
            "tracker.example",
            "/",
            10
        ));
        assert!(check_cookie(&cookie("tracker.example", "/", None)).is_ok());
        assert!(check_cookie(&cookie("", "/", None)).is_err());
        assert!(check_cookie(&cookie("a/b", "/", None)).is_err());
        assert!(check_cookie(&cookie("x", "rss", None)).is_err());
    }

    #[test]
    fn tracker_lists() {
        let l = parse_trackers(
            "# best trackers\nudp://a.example:1337/announce\n\nhttp://b.example/announce\nnot a url\nudp://a.example:1337/announce\n",
        );
        assert_eq!(
            l,
            ["udp://a.example:1337/announce", "http://b.example/announce"]
        );
    }
}
