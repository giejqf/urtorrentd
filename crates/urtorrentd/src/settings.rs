// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

//! Daemon settings: what qBittorrent calls preferences, with our own names and
//! units (bytes, bytes per second, seconds; `null` = unlimited / unset).
//! `docs/settings.md` maps every qBittorrent preference key onto these.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

use serde::{Deserialize, Serialize};
use urtorrent::{ActiveLimits, EncryptionMode, Profile, SessionBuilder, TransportPolicy};
use utoipa::ToSchema;

use crate::util::{Cidr, parse_ip_range};

/// Declares `Settings` (every field present), `SettingsPatch` (every field
/// optional) and the merge between them from one field list, so the two
/// types and the schema never drift apart.
macro_rules! settings {
    ($(
        $(#[doc = $doc:literal])*
        $name:ident : $ty:ty = $default:expr, nullable = $nullable:tt $(, schema = $sch:ty)?;
    )*) => {
        /// The daemon's settings. Every field is always present.
        #[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
        #[serde(default)]
        pub struct Settings {
            $(
                $(#[doc = $doc])*
                #[schema(required = true $(, value_type = $sch)?)]
                pub $name: $ty,
            )*
        }

        impl Default for Settings {
            fn default() -> Settings {
                Settings { $( $name: $default, )* }
            }
        }

        /// A partial update of [`Settings`]: only the fields present change.
        #[derive(Debug, Clone, Default, Deserialize, ToSchema)]
        #[serde(deny_unknown_fields)]
        pub struct SettingsPatch {
            $(
                $(#[doc = $doc])*
                #[serde(default, deserialize_with = "crate::util::patch_field")]
                #[schema(nullable = $nullable $(, value_type = $sch)?)]
                pub $name: Option<$ty>,
            )*
        }

        impl Settings {
            /// Apply a patch.
            pub fn patched(&self, p: SettingsPatch) -> Settings {
                let mut s = self.clone();
                $( if let Some(v) = p.$name { s.$name = v; } )*
                s
            }
        }
    };
}

const MIB: u64 = 1024 * 1024;

settings! {
    /// TCP and UDP listen port for peers (0 = pick an ephemeral port at start).
    listen_port: u16 = 6881, nullable = false;
    /// Pick a new random listen port at every start.
    random_port: bool = false, nullable = false;
    /// IPv4 listen address; `null` turns IPv4 off (no socket, no IPv4 peers).
    listen_v4: Option<Ipv4Addr> = Some(Ipv4Addr::UNSPECIFIED), nullable = true, schema = Option<String>;
    /// IPv6 listen address; `null` turns IPv6 off.
    listen_v6: Option<Ipv6Addr> = Some(Ipv6Addr::UNSPECIFIED), nullable = true, schema = Option<String>;
    /// The identity peers and trackers see.
    identity: Identity = Identity::Native, nullable = false;
    /// Peer connection encryption (MSE).
    encryption: Encryption = Encryption::Enabled, nullable = false;
    /// Peer transports (TCP, uTP) and their order.
    transports: Transports = Transports::PreferTcp, nullable = false;
    /// The DHT (BEP 5). Private torrents never use it.
    dht: bool = true, nullable = false;
    /// Peer exchange (BEP 11). Private torrents never use it.
    pex: bool = true, nullable = false;
    /// Local service discovery (BEP 14). Private torrents never use it.
    lsd: bool = true, nullable = false;
    /// DHT bootstrap routers (`host:port`); `null` = the identity's defaults.
    /// Applies after a restart.
    dht_bootstrap_nodes: Option<Vec<String>> = None, nullable = true;
    /// Peer connections across all torrents.
    max_connections: u32 = 500, nullable = false;
    /// Peer connections per torrent (the default for torrents without their own cap).
    max_connections_per_torrent: u32 = 50, nullable = false;
    /// Upload slots across all torrents.
    max_uploads: u32 = 8, nullable = false;
    /// Upload slots per torrent for new torrents; `null` = only the global budget.
    max_uploads_per_torrent: Option<u32> = None, nullable = true;
    /// Addresses banned from every torrent.
    banned_ips: Vec<IpAddr> = Vec::new(), nullable = false, schema = Vec<String>;
    /// Address ranges banned from every torrent: `10.0.0.0/8`, `fd00::/8`, or
    /// `first-last` (`1.2.3.0-1.2.4.255`).
    banned_ip_ranges: Vec<String> = Vec::new(), nullable = false;
    /// Global download limit in bytes per second; `null` = unlimited.
    download_limit: Option<u64> = None, nullable = true;
    /// Global upload limit in bytes per second; `null` = unlimited.
    upload_limit: Option<u64> = None, nullable = true;
    /// Alternative download limit (bytes per second) used while `alt_speed_enabled`.
    alt_download_limit: Option<u64> = Some(10 * MIB), nullable = true;
    /// Alternative upload limit (bytes per second) used while `alt_speed_enabled`.
    alt_upload_limit: Option<u64> = Some(10 * MIB), nullable = true;
    /// Use the alternative limits.
    alt_speed_enabled: bool = false, nullable = false;
    /// A name for this daemon that clients show (`GET /app`); `null` =
    /// none.
    instance_name: Option<String> = None, nullable = true;
    /// Listen on this network interface's addresses (`GET /app/interfaces`),
    /// in the families `listen_v4` / `listen_v6` enable, and send
    /// everything from them (peers, trackers, web seeds, DHT); followed as
    /// they change. With no address (a VPN down) only loopback is used, so
    /// nothing leaves through another interface.
    /// `null` = the `listen_v4` / `listen_v6` addresses.
    listen_interface: Option<String> = None, nullable = true;
    /// Turn the alternative limits on and off by the clock; `null` = only
    /// by hand. At the window's start they go on, at its end off; a switch
    /// by hand in between holds until the next boundary.
    alt_speed_schedule: Option<AltSpeedSchedule> = None, nullable = true;
    /// Limit how many torrents are active at once (the queue).
    queueing_enabled: bool = false, nullable = false;
    /// Active downloading torrents while queueing; `null` = unlimited.
    max_active_downloads: Option<u32> = Some(3), nullable = true;
    /// Active seeding torrents while queueing; `null` = unlimited.
    max_active_uploads: Option<u32> = Some(3), nullable = true;
    /// Active torrents in total while queueing; `null` = unlimited.
    max_active_torrents: Option<u32> = Some(5), nullable = true;
    /// Count torrents that move no data (below 2 KiB/s for 60 s) towards the queue limits.
    count_slow_torrents: bool = false, nullable = false;
    /// Where new torrents are saved (absolute path).
    save_path: String = String::new(), nullable = false;
    /// Where incomplete torrents are downloaded before moving to their save
    /// path (absolute path); `null` = straight to the save path.
    download_path: Option<String> = None, nullable = true;
    /// Add new torrents stopped.
    add_stopped: bool = false, nullable = false;
    /// Appended to the name of every file that is not complete yet (e.g.
    /// `.!qB`), removed when the file completes; `null` = off. Changing it
    /// renames the files of every torrent.
    incomplete_file_suffix: Option<String> = None, nullable = true;
    /// Put new torrents at the front of the queue.
    add_to_top_of_queue: bool = false, nullable = false;
    /// The content layout of new torrents whose add does not say.
    content_layout: crate::model::ContentLayout = crate::model::ContentLayout::Original, nullable = false;
    /// The stop condition of new torrents whose add does not say.
    stop_condition: crate::store::StopCondition = crate::store::StopCondition::None, nullable = false;
    /// A manually managed torrent added with a category and no save path
    /// of its own goes to the category's save path.
    category_paths_in_manual_mode: bool = false, nullable = false;
    /// File names skipped when a torrent is added (wildcards `*` and `?`,
    /// case ignored): a file whose name, or a folder on its path, matches
    /// gets priority 0.
    excluded_file_names: Vec<String> = Vec::new(), nullable = false;
    /// Adding a torrent that is there already merges the new trackers and
    /// web seeds into it (never for private torrents, AGENTS.md rule 2).
    merge_trackers: bool = false, nullable = false;
    /// Recheck a torrent when its download finishes (after the move to its
    /// save path, if any).
    recheck_on_completion: bool = false, nullable = false;
    /// Write the `.torrent` of every torrent added into this directory
    /// (absolute); `null` = no.
    export_dir: Option<String> = None, nullable = true;
    /// Write the `.torrent` of every finished torrent into this directory
    /// (absolute); `null` = no.
    export_dir_finished: Option<String> = None, nullable = true;
    /// A list of trackers (one URL per line) fetched at the start and every
    /// 24 hours, added to new public torrents like `add_trackers`; `null` =
    /// none. What was fetched is in `GET /app`.
    add_trackers_url: Option<String> = None, nullable = true;
    /// Folders whose `.torrent` and `.magnet` files are added (at most 32).
    watch_folders: Vec<WatchFolder> = Vec::new(), nullable = false;
    /// Refresh the RSS feeds by themselves (a refresh asked for runs
    /// either way).
    rss_enabled: bool = false, nullable = false;
    /// Seconds between refreshes of a feed without its own interval (at
    /// least 60).
    rss_refresh_interval: u64 = 1800, nullable = false;
    /// Seconds between two requests to the same host (at most 3600).
    rss_fetch_delay: u64 = 2, nullable = false;
    /// Articles kept per feed, the newest (1 to 5000).
    rss_max_articles: u32 = 50, nullable = false;
    /// Run the RSS download rules on new articles.
    rss_auto_download: bool = false, nullable = false;
    /// A rule's smart filter takes a REPACK or PROPER of an episode it
    /// took once more.
    rss_download_repacks: bool = true, nullable = false;
    /// Allocate content files at full size when they are created.
    preallocate: bool = false, nullable = false;
    /// New torrents use automatic management (save path from their category).
    auto_management: bool = false, nullable = false;
    /// Trackers added to every new public torrent (never to private ones).
    add_trackers: Vec<String> = Vec::new(), nullable = false;
    /// Share ratio at which the share limit action runs; `null` = no limit.
    max_ratio: Option<f64> = None, nullable = true;
    /// Seeding time (seconds) at which the share limit action runs; `null` = no limit.
    max_seeding_time: Option<u64> = None, nullable = true;
    /// Seconds of seeding without traffic after which the share limit action
    /// runs; `null` = no limit.
    max_inactive_seeding_time: Option<u64> = None, nullable = true;
    /// What happens when a share limit is reached.
    share_limit_action: ShareLimitAction = ShareLimitAction::Stop, nullable = false;
    /// SHA-1 hashing threads. Applies after a restart.
    hash_threads: u32 = 2, nullable = false;
    /// Content files kept open at once. Applies after a restart.
    max_open_files: u32 = 512, nullable = false;
    /// Torrents checked at once. Applies after a restart.
    max_checking: u32 = 1, nullable = false;
    /// Prefer finishing recently started 4 MiB extents. Applies after a restart.
    piece_extent_affinity: bool = true, nullable = false;
    /// Tracker requests in flight at once. Applies after a restart.
    max_concurrent_announces: u32 = 32, nullable = false;
    /// Run disk I/O on its own io_uring thread. Applies after a restart.
    disk_thread: bool = true, nullable = false;
    /// Zero-copy sends for piece payloads. Applies after a restart.
    zero_copy_send: bool = false, nullable = false;
    /// Idle seconds after which an API login session expires.
    api_session_timeout: u64 = 3600, nullable = false;
    /// Failed logins from one address before it is banned.
    api_max_auth_failures: u32 = 5, nullable = false;
    /// Seconds an address stays banned after too many failed logins.
    api_ban_duration: u64 = 3600, nullable = false;
    /// A MaxMind DB file (`.mmdb`, absolute path) with countries:
    /// GeoLite2-Country, DB-IP IP-to-Country Lite or IPinfo Lite; `null` =
    /// none. Peers show their country and `/stats/geo` has traffic by
    /// country. Re-read when the file changes; never downloaded.
    geoip_database: Option<String> = None, nullable = true;
    /// A MaxMind DB file with autonomous systems (GeoLite2-ASN, DB-IP
    /// IP-to-ASN Lite); `null` = none (IPinfo Lite has them in
    /// `geoip_database`).
    geoip_asn_database: Option<String> = None, nullable = true;
    /// Record statistics (`/stats`): traffic per torrent and for the session,
    /// each torrent's days, the timeline. Off: nothing new is recorded, what
    /// was recorded stays.
    stats_enabled: bool = true, nullable = false;
    /// Seconds per-minute statistics are kept; `null` = forever.
    stats_minute_retention: Option<u64> = Some(172_800), nullable = true;
    /// Seconds per-hour statistics are kept; `null` = forever.
    stats_hour_retention: Option<u64> = Some(7_776_000), nullable = true;
    /// Seconds days, the timeline and recording periods are kept; `null` =
    /// forever.
    stats_day_retention: Option<u64> = None, nullable = true;
    /// Scrape every torrent's trackers this often (seconds, at least 1800)
    /// for the swarm's completed downloads in `/stats/torrents/{hash}/days`;
    /// `null` = never (the default: announces already report the swarm's
    /// seeds and leechers).
    stats_scrape_interval: Option<u64> = None, nullable = true;
    /// Loopback clients need no authentication.
    api_bypass_local_auth: bool = false, nullable = false;
    /// Address blocks (`10.0.0.0/8`, `fd00::/8`) whose clients need no authentication.
    api_auth_whitelist: Vec<String> = Vec::new(), nullable = false;
    /// Reverse proxies (addresses or blocks, `10.0.0.0/8`) trusted to tell
    /// the client's address (`X-Forwarded-For`) and host
    /// (`X-Forwarded-Host`); empty = none.
    api_trusted_proxies: Vec<String> = Vec::new(), nullable = false;
    /// Host names accepted in the `Host` header (`*` = any, `*.example.com` =
    /// subdomains). IP addresses are always accepted.
    api_allowed_hosts: Vec<String> = vec!["localhost".to_string()], nullable = false;
    /// Reject state-changing requests from browsers on other origins.
    api_csrf_protection: bool = true, nullable = false;
}

/// Fields that only take effect when the engine is rebuilt at the next start.
pub const RESTART_FIELDS: &[&str] = &[
    "dht_bootstrap_nodes",
    "hash_threads",
    "max_open_files",
    "max_checking",
    "piece_extent_affinity",
    "max_concurrent_announces",
    "disk_thread",
    "zero_copy_send",
];

/// A day of the week.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Weekday {
    /// Monday.
    Mon,
    /// Tuesday.
    Tue,
    /// Wednesday.
    Wed,
    /// Thursday.
    Thu,
    /// Friday.
    Fri,
    /// Saturday.
    Sat,
    /// Sunday.
    Sun,
}

/// When the alternative speed limits are on by themselves: from `from` to
/// `to` (local time) on the given days. A window that ends before it
/// starts runs past midnight and belongs to the day it starts on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct AltSpeedSchedule {
    /// Start, `HH:MM` (24-hour).
    pub from: String,
    /// End, `HH:MM`; earlier than `from` = the next day.
    pub to: String,
    /// The days a window starts on; empty (the default) = every day.
    #[serde(default)]
    pub days: Vec<Weekday>,
    /// IANA time zone (`Europe/Berlin`); `null` (the default) = the
    /// system's.
    #[serde(default)]
    pub time_zone: Option<String>,
}

/// `HH:MM` as minutes after midnight.
fn minutes(s: &str) -> Option<u32> {
    let (h, m) = s.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let (h, m): (u32, u32) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

impl Weekday {
    fn of(d: jiff::civil::Weekday) -> Weekday {
        use jiff::civil::Weekday as W;
        match d {
            W::Monday => Weekday::Mon,
            W::Tuesday => Weekday::Tue,
            W::Wednesday => Weekday::Wed,
            W::Thursday => Weekday::Thu,
            W::Friday => Weekday::Fri,
            W::Saturday => Weekday::Sat,
            W::Sunday => Weekday::Sun,
        }
    }
}

impl AltSpeedSchedule {
    fn zone(&self) -> Result<jiff::tz::TimeZone, String> {
        match &self.time_zone {
            Some(name) => jiff::tz::TimeZone::get(name)
                .map_err(|e| format!("alt_speed_schedule.time_zone {name:?}: {e}")),
            None => Ok(jiff::tz::TimeZone::system()),
        }
    }

    fn bounds(&self) -> Result<(u32, u32), String> {
        let from = minutes(&self.from)
            .ok_or_else(|| format!("alt_speed_schedule.from {:?} is not HH:MM", self.from))?;
        let to = minutes(&self.to)
            .ok_or_else(|| format!("alt_speed_schedule.to {:?} is not HH:MM", self.to))?;
        if from == to {
            return Err("alt_speed_schedule: from and to are the same time".into());
        }
        Ok((from, to))
    }

    /// Whether the window is open at `t`.
    pub fn contains(&self, t: jiff::Timestamp) -> Result<bool, String> {
        let (from, to) = self.bounds()?;
        let local = t.to_zoned(self.zone()?);
        let now =
            u32::from(local.hour().unsigned_abs()) * 60 + u32::from(local.minute().unsigned_abs());
        let day = local.weekday();
        let on =
            |d: jiff::civil::Weekday| self.days.is_empty() || self.days.contains(&Weekday::of(d));
        Ok(if from < to {
            on(day) && (from..to).contains(&now)
        } else {
            // Past midnight: the evening of a listed day, or the morning
            // after one.
            (now >= from && on(day)) || (now < to && on(day.previous()))
        })
    }
}

/// What happens to a watched file once it is added.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum AfterAdd {
    /// Renamed to `<name>.added` (kept, and not picked up again).
    #[default]
    Rename,
    /// Deleted.
    Delete,
}

/// A folder whose `.torrent` and `.magnet` files (a magnet link inside) are
/// added. A file is taken once it has not changed for 3 seconds; one that
/// cannot be added is renamed to `<name>.rejected` and the reason logged.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct WatchFolder {
    /// The folder (absolute).
    pub path: String,
    /// Look in subfolders too (up to 8 levels; symbolic links to folders
    /// are not followed).
    #[serde(default)]
    pub recursive: bool,
    /// How its torrents are added (as in `POST /torrents`).
    #[serde(default)]
    pub options: crate::model::AddOptions,
    /// What happens to a file once added.
    #[serde(default)]
    pub after_add: AfterAdd,
}

/// The identity peers and trackers see (a urtorrent profile).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
pub enum Identity {
    /// urtorrent's own peer id prefix and user agent.
    #[serde(rename = "native")]
    Native,
    /// qBittorrent 5.2.3 on libtorrent 2.0.14, for trackers with client whitelists.
    #[serde(rename = "qbt_5_2_3_lt2_0_14")]
    Qbittorrent,
}

impl Identity {
    /// The library profile.
    pub fn profile(self) -> Profile {
        match self {
            Identity::Native => Profile::native(),
            Identity::Qbittorrent => Profile::qbt_5_2_3_lt2_0_14(),
        }
    }
}

/// Peer connection encryption.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Encryption {
    /// Plaintext only.
    Disabled,
    /// Both; plaintext first when connecting out.
    Enabled,
    /// Encrypted only.
    Forced,
}

impl Encryption {
    /// The library mode.
    pub fn mode(self) -> EncryptionMode {
        match self {
            Encryption::Disabled => EncryptionMode::Disabled,
            Encryption::Enabled => EncryptionMode::Enabled,
            Encryption::Forced => EncryptionMode::Forced,
        }
    }
}

/// Peer transports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum Transports {
    /// TCP only.
    TcpOnly,
    /// TCP first, uTP for peers TCP cannot reach.
    PreferTcp,
    /// uTP first, TCP as the fallback.
    PreferUtp,
    /// uTP only.
    UtpOnly,
}

impl Transports {
    /// The library policy.
    pub fn policy(self) -> TransportPolicy {
        match self {
            Transports::TcpOnly => TransportPolicy::TcpOnly,
            Transports::PreferTcp => TransportPolicy::PreferTcp,
            Transports::PreferUtp => TransportPolicy::PreferUtp,
            Transports::UtpOnly => TransportPolicy::UtpOnly,
        }
    }
}

/// What happens when a torrent reaches a share limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum ShareLimitAction {
    /// Stop the torrent.
    Stop,
    /// Remove the torrent, keep its files.
    Remove,
    /// Remove the torrent and its files.
    RemoveWithFiles,
}

fn usize_of(n: u32) -> usize {
    usize::try_from(n).unwrap_or(usize::MAX)
}

impl Settings {
    /// Check values the types cannot express.
    pub fn validate(&self) -> Result<(), String> {
        if self.listen_v4.is_none() && self.listen_v6.is_none() {
            return Err("listen_v4 and listen_v6 cannot both be off".into());
        }
        if !std::path::Path::new(&self.save_path).is_absolute() {
            return Err("save_path must be an absolute path".into());
        }
        if let Some(p) = &self.download_path
            && !std::path::Path::new(p).is_absolute()
        {
            return Err("download_path must be an absolute path".into());
        }
        for (name, p) in [
            ("export_dir", &self.export_dir),
            ("export_dir_finished", &self.export_dir_finished),
        ] {
            if let Some(p) = p
                && !std::path::Path::new(p).is_absolute()
            {
                return Err(format!("{name} must be an absolute path"));
            }
        }
        if let Some(u) = &self.add_trackers_url
            && !(u.starts_with("http://") || u.starts_with("https://"))
        {
            return Err("add_trackers_url must be an http or https URL".into());
        }
        if let Some(n) = &self.instance_name
            && (n.chars().count() > 64 || n.chars().any(char::is_control))
        {
            return Err("instance_name is at most 64 characters".into());
        }
        if let Some(i) = &self.listen_interface
            && (i.is_empty() || i.len() > 64 || i.contains(['/', '\0']))
        {
            return Err("listen_interface is not an interface name".into());
        }
        if self.excluded_file_names.len() > 256 {
            return Err("excluded_file_names: 256 at most".into());
        }
        for p in &self.excluded_file_names {
            crate::util::wildcard(p).map_err(|e| format!("excluded_file_names: {e}"))?;
        }
        for r in &self.api_trusted_proxies {
            if Cidr::parse(r).is_none() {
                return Err(format!(
                    "api_trusted_proxies: {r:?} is not an address or block"
                ));
            }
        }
        if let Some(s) = &self.alt_speed_schedule {
            s.bounds()?;
            s.zone()?;
        }
        if self.rss_refresh_interval < 60 {
            return Err("rss_refresh_interval must be at least 60 seconds".into());
        }
        if self.rss_fetch_delay > 3600 {
            return Err("rss_fetch_delay must be at most 3600 seconds".into());
        }
        if !(1..=5000).contains(&self.rss_max_articles) {
            return Err("rss_max_articles must be 1 to 5000".into());
        }
        if self.watch_folders.len() > 32 {
            return Err("watch_folders: 32 at most".into());
        }
        for (i, w) in self.watch_folders.iter().enumerate() {
            if !std::path::Path::new(&w.path).is_absolute() {
                return Err(format!("watch_folders[{i}].path must be an absolute path"));
            }
            if self.watch_folders[..i].iter().any(|o| o.path == w.path) {
                return Err(format!("watch_folders[{i}]: {} is listed twice", w.path));
            }
            crate::daemon::check_add_options(&w.options)
                .map_err(|e| format!("watch_folders[{i}].options: {}", e.message))?;
        }
        if self.stats_scrape_interval.is_some_and(|s| s < 1800) {
            return Err("stats_scrape_interval must be at least 1800 seconds".into());
        }
        for (name, p) in [
            ("geoip_database", &self.geoip_database),
            ("geoip_asn_database", &self.geoip_asn_database),
        ] {
            if let Some(p) = p
                && !std::path::Path::new(p).is_absolute()
            {
                return Err(format!("{name} must be an absolute path"));
            }
        }
        if let Some(sfx) = &self.incomplete_file_suffix
            && (sfx.is_empty() || sfx.len() > 32 || sfx.contains(['/', '\\', '\0']))
        {
            return Err("incomplete_file_suffix must be 1 to 32 characters without slashes".into());
        }
        if self.max_ratio.is_some_and(|r| !r.is_finite() || r < 0.0) {
            return Err("max_ratio must be a non-negative number".into());
        }
        for t in &self.add_trackers {
            if !valid_tracker_url(t) {
                return Err(format!(
                    "add_trackers: {t:?} is not an http, https or udp URL"
                ));
            }
        }
        for r in &self.banned_ip_ranges {
            if parse_ip_range(r).is_none() {
                return Err(format!(
                    "banned_ip_ranges: {r:?} is not a range (`10.0.0.0/8` or `first-last`)"
                ));
            }
        }
        for c in &self.api_auth_whitelist {
            if Cidr::parse(c).is_none() {
                return Err(format!("api_auth_whitelist: {c:?} is not an address block"));
            }
        }
        for (name, v) in [
            ("max_connections", self.max_connections),
            (
                "max_connections_per_torrent",
                self.max_connections_per_torrent,
            ),
            ("hash_threads", self.hash_threads),
            ("max_open_files", self.max_open_files),
            ("max_checking", self.max_checking),
            ("max_concurrent_announces", self.max_concurrent_announces),
        ] {
            if v == 0 {
                return Err(format!("{name} must be at least 1"));
            }
        }
        if self.api_session_timeout == 0 {
            return Err("api_session_timeout must be at least 1".into());
        }
        Ok(())
    }

    /// The global limits in force (library convention: 0 = unlimited):
    /// `(upload, download)`.
    pub fn effective_rate_limits(&self) -> (u64, u64) {
        let (up, down) = if self.alt_speed_enabled {
            (self.alt_upload_limit, self.alt_download_limit)
        } else {
            (self.upload_limit, self.download_limit)
        };
        (up.unwrap_or(0), down.unwrap_or(0))
    }

    /// The queue limits for the library.
    pub fn active_limits(&self) -> ActiveLimits {
        if !self.queueing_enabled {
            return ActiveLimits::UNLIMITED;
        }
        ActiveLimits {
            downloads: self.max_active_downloads.map(usize_of),
            seeds: self.max_active_uploads.map(usize_of),
            total: self.max_active_torrents.map(usize_of),
            count_slow: self.count_slow_torrents,
        }
    }

    /// A session builder configured from these settings.
    pub fn builder(&self, dht_state: Option<Vec<u8>>) -> SessionBuilder {
        let (up, down) = self.effective_rate_limits();
        let (v4, v6) = crate::interfaces::listen_addresses(self);
        let mut b = urtorrent::Session::builder()
            .listen_port(self.listen_port)
            .listen_v4(v4)
            .listen_v6(v6)
            .profile(self.identity.profile())
            .encryption(self.encryption.mode())
            .transports(self.transports.policy())
            .dht(self.dht)
            .pex(self.pex)
            .lsd(self.lsd)
            .max_connections(usize_of(self.max_connections))
            .max_peers_per_torrent(usize_of(self.max_connections_per_torrent))
            .unchoke_slots(usize_of(self.max_uploads))
            .upload_limit(up)
            .download_limit(down)
            .active_limits(self.active_limits())
            .hash_threads(usize_of(self.hash_threads))
            .max_open_files(usize_of(self.max_open_files))
            .max_checking(usize_of(self.max_checking))
            .piece_extent_affinity(self.piece_extent_affinity)
            .max_concurrent_announces(usize_of(self.max_concurrent_announces))
            .disk_thread(self.disk_thread)
            .zero_copy_send(self.zero_copy_send);
        if let Some(nodes) = &self.dht_bootstrap_nodes {
            b = b.dht_bootstrap_nodes(nodes.clone());
        }
        if let Some(state) = dht_state {
            b = b.dht_state(state);
        }
        b
    }

    /// The restart-only fields whose value differs from `running`.
    pub fn pending_restart(&self, running: &Settings) -> Vec<String> {
        let a = serde_json::to_value(self).unwrap_or_default();
        let b = serde_json::to_value(running).unwrap_or_default();
        RESTART_FIELDS
            .iter()
            .filter(|f| a.get(**f) != b.get(**f))
            .map(|f| (*f).to_string())
            .collect()
    }
}

/// Apply the live-changeable differences between `old` and `new` to a
/// running session. The listen sockets change first: if binding fails,
/// nothing else is touched and the error is returned.
pub async fn apply_live(
    session: &urtorrent::Session,
    old: &Settings,
    new: &Settings,
) -> Result<(), urtorrent::Error> {
    if old.listen_port != new.listen_port
        || old.listen_v4 != new.listen_v4
        || old.listen_v6 != new.listen_v6
        || old.listen_interface != new.listen_interface
    {
        let (v4, v6) = crate::interfaces::listen_addresses(new);
        session.set_listen(new.listen_port, v4, v6).await?;
    }
    if old.identity != new.identity {
        session.set_profile(new.identity.profile()).await?;
    }
    if old.dht != new.dht {
        session.set_dht(new.dht).await?;
    }
    if old.pex != new.pex {
        session.set_pex(new.pex).await?;
    }
    if old.lsd != new.lsd {
        session.set_lsd(new.lsd).await?;
    }
    if old.encryption != new.encryption {
        session.set_encryption(new.encryption.mode()).await?;
    }
    if old.transports != new.transports {
        session.set_transports(new.transports.policy()).await?;
    }
    if old.max_connections != new.max_connections {
        session
            .set_max_connections(usize_of(new.max_connections))
            .await?;
    }
    if old.max_connections_per_torrent != new.max_connections_per_torrent {
        session
            .set_max_peers_per_torrent(usize_of(new.max_connections_per_torrent))
            .await?;
    }
    if old.max_uploads != new.max_uploads {
        session.set_unchoke_slots(usize_of(new.max_uploads)).await?;
    }
    if old.effective_rate_limits() != new.effective_rate_limits() {
        let (up, down) = new.effective_rate_limits();
        session.set_rate_limits(up, down).await?;
    }
    if old.active_limits() != new.active_limits() {
        session.set_active_limits(new.active_limits()).await?;
    }
    if old.banned_ip_ranges != new.banned_ip_ranges {
        for r in old
            .banned_ip_ranges
            .iter()
            .filter(|r| !new.banned_ip_ranges.contains(r))
        {
            if let Some((a, b)) = parse_ip_range(r) {
                session.unban_ip_range(a, b).await?;
            }
        }
        for r in new
            .banned_ip_ranges
            .iter()
            .filter(|r| !old.banned_ip_ranges.contains(r))
        {
            if let Some((a, b)) = parse_ip_range(r) {
                session.ban_ip_range(a, b).await?;
            }
        }
    }
    if old.banned_ips != new.banned_ips {
        for ip in new
            .banned_ips
            .iter()
            .filter(|ip| !old.banned_ips.contains(ip))
        {
            session.ban_ip(*ip).await?;
        }
        for ip in old
            .banned_ips
            .iter()
            .filter(|ip| !new.banned_ips.contains(ip))
        {
            session.unban_ip(*ip).await?;
        }
    }
    Ok(())
}

/// Apply the settings' bans to a new session.
pub async fn apply_bans(
    session: &urtorrent::Session,
    settings: &Settings,
) -> Result<(), urtorrent::Error> {
    for ip in &settings.banned_ips {
        session.ban_ip(*ip).await?;
    }
    for r in &settings.banned_ip_ranges {
        if let Some((a, b)) = parse_ip_range(r) {
            session.ban_ip_range(a, b).await?;
        }
    }
    Ok(())
}

/// An announce URL we accept for automatic tracker lists.
pub fn valid_tracker_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    ["http://", "https://", "udp://"]
        .iter()
        .any(|p| lower.starts_with(p) && lower.len() > p.len())
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    #[test]
    fn patch_distinguishes_absent_and_null() {
        let s = Settings {
            save_path: "/srv".into(),
            download_limit: Some(5),
            ..Settings::default()
        };
        let p: SettingsPatch = serde_json::from_str(r#"{"upload_limit": 7}"#).unwrap();
        let s2 = s.patched(p);
        assert_eq!(s2.download_limit, Some(5));
        assert_eq!(s2.upload_limit, Some(7));
        let p: SettingsPatch = serde_json::from_str(r#"{"download_limit": null}"#).unwrap();
        assert_eq!(s2.patched(p).download_limit, None);
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"nope": 1}"#).is_err());
        assert!(serde_json::from_str::<SettingsPatch>(r#"{"listen_port": null}"#).is_err());
    }

    #[test]
    fn validation() {
        let mut s = Settings {
            save_path: "/srv".into(),
            ..Settings::default()
        };
        assert!(s.validate().is_ok());
        s.listen_v4 = None;
        s.listen_v6 = None;
        assert!(s.validate().is_err());
        let s = Settings {
            save_path: "relative".into(),
            ..Settings::default()
        };
        assert!(s.validate().is_err());
    }

    #[test]
    fn restart_fields_exist() {
        let v = serde_json::to_value(Settings::default()).unwrap();
        for f in RESTART_FIELDS {
            assert!(v.get(*f).is_some(), "{f}");
        }
        let running = Settings::default();
        let s = Settings {
            hash_threads: 4,
            ..Settings::default()
        };
        assert_eq!(
            s.pending_restart(&running),
            vec!["hash_threads".to_string()]
        );
    }

    fn at(s: &str) -> jiff::Timestamp {
        s.parse().unwrap()
    }

    #[test]
    fn schedules_open_and_close() {
        let night = AltSpeedSchedule {
            from: "22:00".into(),
            to: "06:00".into(),
            days: vec![Weekday::Fri],
            time_zone: Some("UTC".into()),
        };
        // 2026-07-03 is a Friday.
        assert!(night.contains(at("2026-07-03T23:00:00Z")).unwrap());
        assert!(
            night.contains(at("2026-07-04T05:59:00Z")).unwrap(),
            "Friday's night"
        );
        assert!(!night.contains(at("2026-07-04T06:00:00Z")).unwrap());
        assert!(
            !night.contains(at("2026-07-04T23:00:00Z")).unwrap(),
            "Saturday"
        );
        assert!(
            !night.contains(at("2026-07-03T05:00:00Z")).unwrap(),
            "Thursday's night"
        );
        let day = AltSpeedSchedule {
            from: "09:00".into(),
            to: "17:00".into(),
            days: Vec::new(),
            time_zone: Some("UTC".into()),
        };
        assert!(day.contains(at("2026-07-05T09:00:00Z")).unwrap());
        assert!(!day.contains(at("2026-07-05T17:00:00Z")).unwrap());
        assert!(!day.contains(at("2026-07-05T08:59:59Z")).unwrap());
        // Local time follows daylight saving: 13:30 UTC is 09:30 in New York
        // in July (UTC-4) and 08:30 in January (UTC-5).
        let ny = AltSpeedSchedule {
            from: "09:00".into(),
            to: "10:00".into(),
            days: Vec::new(),
            time_zone: Some("America/New_York".into()),
        };
        assert!(ny.contains(at("2026-07-01T13:30:00Z")).unwrap());
        assert!(!ny.contains(at("2026-01-15T13:30:00Z")).unwrap());
    }

    #[test]
    fn schedules_and_watch_folders_are_checked() {
        let check = |f: &dyn Fn(&mut Settings)| {
            let mut s = Settings {
                save_path: "/srv".into(),
                ..Settings::default()
            };
            f(&mut s);
            s.validate()
        };
        let sched = |from: &str, to: &str, tz: Option<&str>| AltSpeedSchedule {
            from: from.into(),
            to: to.into(),
            days: Vec::new(),
            time_zone: tz.map(str::to_string),
        };
        assert!(check(&|s| s.alt_speed_schedule = Some(sched("22:00", "06:30", None))).is_ok());
        for bad in [
            sched("24:00", "06:00", None),
            sched("9:00", "10:00", None),
            sched("10:00", "10:00", None),
            sched("10:00", "11:00", Some("Mars/Olympus")),
        ] {
            assert!(
                check(&|s| s.alt_speed_schedule = Some(bad.clone())).is_err(),
                "{bad:?}"
            );
        }
        let folder = |p: &str| WatchFolder {
            path: p.into(),
            recursive: false,
            options: Default::default(),
            after_add: AfterAdd::Rename,
        };
        assert!(check(&|s| s.watch_folders = vec![folder("/w/a"), folder("/w/b")]).is_ok());
        assert!(check(&|s| s.watch_folders = vec![folder("w/a")]).is_err());
        assert!(check(&|s| s.watch_folders = vec![folder("/w/a"), folder("/w/a")]).is_err());
        let mut bad = folder("/w/c");
        bad.options.file_priorities = Some(vec![9]);
        assert!(check(&|s| s.watch_folders = vec![bad.clone()]).is_err());
    }
}
