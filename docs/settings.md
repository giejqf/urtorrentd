# Settings

`GET /api/v1/settings` returns every setting; `PATCH /api/v1/settings` changes
the fields it names (`null` where a field allows it: unlimited, off, default).
The schema documents each field (`Settings`, `SettingsPatch` in
[`openapi.json`](../openapi.json)). Most apply at once; the engine-tuning ones
(`dht_bootstrap_nodes`, `hash_threads`, `max_open_files`, `max_checking`,
`piece_extent_affinity`, `max_concurrent_announces`, `disk_thread`,
`zero_copy_send`) apply at the next start and are listed in
`GET /api/v1/app` → `restart_required` until then.

Units are uniform: limits in **bytes per second** (qBittorrent's preferences
use KiB/s), times in seconds, `null` for unlimited.

The daemon's own start-up options are not settings: the data directory
(`--data-dir`, `URTORRENTD_DATA_DIR`) and the API address (`--api-listen`,
`URTORRENTD_API_LISTEN`, default `127.0.0.1:8080`).

## Staging downloads and moving them by category

Two settings and a category give qBittorrent's "keep incomplete torrents in"
plus automatic torrent management:

```json
PATCH /api/v1/settings
{"download_path": "/srv/incomplete", "auto_management": true, "incomplete_file_suffix": ".!qB"}

POST /api/v1/categories
{"name": "movies", "save_path": "/srv/library/movies", "download_path": null}
```

A torrent added with `"category": "movies"` downloads into `/srv/incomplete`
(its files named `….!qB` until each one is complete) and moves to
`/srv/library/movies` when the download finishes. A category's own
`download_path` (absolute, or relative to the global one) overrides the
global one; a category without a `save_path` uses `<save_path>/<name>`.
Changing a torrent's category, or turning automatic management on, moves
complete content to the category's directory; incomplete content moves when
it completes. `auto_management` is the default for new torrents; each add
can say otherwise (`options.auto_management`), and
`POST /torrents/auto-management` changes it per torrent.

## Statistics

History for `/stats` ([api.md](api.md#statistics-adr-0005)) is recorded in
`<data dir>/stats.db` while `stats_enabled` is on (the default). Turning it
off ends the recording period and keeps what was recorded. How long each
kind of bucket is kept, in seconds (`null` = forever):

| Setting | Default | Kept |
|---|---|---|
| `stats_minute_retention` | `172800` (48 h) | per-minute traffic, torrent and session |
| `stats_hour_retention` | `7776000` (90 days) | per-hour traffic |
| `stats_day_retention` | `null` | days (seeding history), the timeline, recording periods |

`stats_scrape_interval` (seconds, at least 1800; default `null` = off)
scrapes every torrent's trackers that often, a few per tick, for the swarm's
completed downloads in the days (`swarm_completed_max`). Scrapes are ordinary
tracker requests; some private trackers disable them, and the failures are
harmless.

Without a `step`, a query uses the finest step kept for its whole range, so
shortening a retention changes which step long ranges get.

## Alternative limits by the clock

```json
PATCH /api/v1/settings
{"alt_speed_schedule": {"from": "08:00", "to": "23:30", "days": ["mon", "tue", "wed", "thu", "fri"], "time_zone": "Europe/Berlin"}}
```

Inside the window `alt_download_limit` / `alt_upload_limit` are in force.
The scheduler switches them at the window's start and end (and at the first
look after a start or a schedule change); a switch by hand
(`PUT /transfer/alt-speed`) holds until the next boundary, as in
qBittorrent. A window that ends before it starts (`22:00` to `06:00`) runs
past midnight and belongs to the day it starts on. Times are local to
`time_zone` (an IANA name; `null` = the system's zone) and follow daylight
saving.

## Watch folders

```json
PATCH /api/v1/settings
{"watch_folders": [
  {"path": "/srv/watch/movies", "options": {"category": "movies"}},
  {"path": "/srv/watch/any", "recursive": true, "after_add": "delete", "options": {"stopped": true}}
]}
```

`.torrent` files, and `.magnet` files holding a magnet link, are added with
the folder's `options` (those of `POST /torrents`). A file is taken once it
has not changed for 3 seconds, so one still being written is left alone.
Once added it is renamed to `<name>.added` (or deleted with
`"after_add": "delete"`); a file that cannot be added is renamed to
`<name>.rejected` and the reason is in the log. A torrent already in the
session counts as added. Folders are looked at every 2 seconds; with
`recursive`, subfolders up to 8 levels deep (hidden entries and symbolic
links to folders are skipped).

## RSS

- `rss_enabled` (`false`): refresh the feeds by themselves.
- `rss_refresh_interval` (`1800`): seconds between refreshes of a feed
  without its own `refresh_interval` (at least 60).
- `rss_fetch_delay` (`2`): seconds between two requests to one host.
- `rss_max_articles` (`50`): articles kept per feed.
- `rss_auto_download` (`false`): run the download rules
  ([api.md](api.md#rss)).
- `rss_download_repacks` (`true`): a smart filter takes a REPACK or PROPER
  of an episode once more.

## Network interface

`listen_interface` (a name from `GET /app/interfaces`, like `wg0`) listens
on that interface's addresses in the families `listen_v4` / `listen_v6`
enable, and everything the engine sends leaves from them: peer
connections, UDP and HTTP(S) tracker announces, web-seed downloads and the
DHT (urtorrent 0.13.4). The daemon follows the addresses as they change
(every 10 seconds); while the interface has none (a VPN down) it listens on
loopback only, so nothing reaches the internet through another route:
announces and web seeds fail until the address is back. A specific
`listen_v4` / `listen_v6` address binds the same way.

## Geolocation

Peers are placed by MaxMind DB (`.mmdb`) files you provide; the daemon never
downloads one. Point `geoip_database` at a country database and, if it has
no autonomous systems, `geoip_asn_database` at an ASN one:

| Source | `geoip_database` | `geoip_asn_database` | Licence |
|---|---|---|---|
| [DB-IP Lite](https://db-ip.com/db/lite.php) (monthly, no account) | `dbip-country-lite-YYYY-MM.mmdb` | `dbip-asn-lite-YYYY-MM.mmdb` | CC BY 4.0: credit DB-IP where the data is shown |
| [MaxMind GeoLite2](https://dev.maxmind.com/geoip/geolite2-free-geolocation-data) (free account) | `GeoLite2-Country.mmdb` | `GeoLite2-ASN.mmdb` | GeoLite2 EULA |
| [IPinfo Lite](https://ipinfo.io/lite) (free account) | `ipinfo_lite.mmdb` | `null` (it has both) | CC BY-SA 4.0 |

A city database works too (only the country is read) but takes more memory.
Paths are absolute and checked when set (`400` if the file cannot be read).
The file is re-read when it changes, so a monthly update is a replace
(write a new file and rename it over the old one); a file that cannot be
read keeps the database loaded before. `GET /app` → `geoip` shows each
file's `database_type`, build time and last error.

## Coverage of qBittorrent 5.2.3's preferences

Every key of the reference (`docs/reference/qbittorrent-5.2.3-preferences.txt`)
has a row; `tests/coverage.rs` fails otherwise. **setting**: a field here.
**fixed**: the library's behaviour, not configurable. **planned**: a daemon
feature not built yet. **n/a**: a UI or platform concern with no meaning for
an API daemon. **unsupported**: with the reason.

| qBittorrent key | Status | Here / why not |
|---|---|---|
| `add_stopped_enabled` | setting | `add_stopped` |
| `add_to_top_of_queue` | setting | `add_to_top_of_queue` |
| `add_trackers` | setting | `add_trackers` (never added to private torrents) |
| `add_trackers_enabled` | setting | `add_trackers` non-empty |
| `add_trackers_from_url_enabled` | setting | `add_trackers_url` not `null` |
| `add_trackers_url` | setting | `add_trackers_url` (fetched at the start and every 24 hours; for new public torrents only) |
| `add_trackers_url_list` | done | `GET /app` → `fetched_trackers` (what was fetched, when, the last error) |
| `alt_dl_limit` | setting | `alt_download_limit` |
| `alt_up_limit` | setting | `alt_upload_limit` |
| `alternative_webui_enabled` | n/a | no web UI is served |
| `alternative_webui_path` | n/a | as above |
| `announce_ip` | unsupported | not offered by the library (urtorrent quirks Q22) |
| `announce_port` | unsupported | not offered by the library |
| `announce_to_all_tiers` | fixed | all tiers, first working tracker per tier (urtorrent Q9) |
| `announce_to_all_trackers` | fixed | as above |
| `anonymous_mode` | unsupported | identity belongs to the profile: `identity` |
| `app_instance_name` | setting | `instance_name` (shown in `GET /app`) |
| `async_io_threads` | fixed | io_uring: one disk ring (`disk_thread`) |
| `auto_delete_mode` | n/a | `.torrent` files arrive through the API; there is nothing to delete |
| `auto_tmm_enabled` | setting | `auto_management` |
| `autorun_enabled` | done | webhooks: a webhook with the `finished` event ([ADR 0006](adr/0006-webhooks.md): no program is ever run) |
| `autorun_on_torrent_added_enabled` | done | webhooks: a webhook with the `added` event |
| `autorun_on_torrent_added_program` | done | webhooks: the webhook's URL; the payload carries the torrent's row (qBittorrent's `%N`, `%F`, `%L`, ... placeholders) |
| `autorun_program` | done | webhooks: as above |
| `banned_IPs` | setting | `banned_ips` (also `POST /transfer/bans`); ranges in `banned_ip_ranges` |
| `bdecode_depth_limit` | fixed | library bounds (bencode nesting 32) |
| `bdecode_token_limit` | fixed | library bounds |
| `bittorrent_protocol` | setting | `transports` |
| `block_peers_on_privileged_ports` | unsupported | not offered by the library |
| `bypass_auth_subnet_whitelist` | setting | `api_auth_whitelist` |
| `bypass_auth_subnet_whitelist_enabled` | setting | `api_auth_whitelist` non-empty |
| `bypass_local_auth` | setting | `api_bypass_local_auth` |
| `category_changed_tmm_enabled` | fixed | managed torrents always follow their category |
| `checking_memory_use` | fixed | the page cache is the only cache |
| `confirm_torrent_deletion` | n/a | a client UI concern |
| `confirm_torrent_recheck` | n/a | a client UI concern |
| `connection_speed` | fixed | library constant (10 dials at once) |
| `current_interface_address` | setting | `listen_v4`, `listen_v6` |
| `current_interface_name` | setting | `listen_interface` |
| `current_network_interface` | setting | `listen_interface` (by name, `GET /app/interfaces`; followed as its addresses change, loopback only while it has none) |
| `delete_torrent_content_files` | n/a | clients pass `delete_files` |
| `dht` | setting | `dht` |
| `dht_bootstrap_nodes` | setting | `dht_bootstrap_nodes` (after a restart) |
| `disk_cache` | fixed | no user-space cache; the page cache |
| `disk_cache_ttl` | fixed | as above |
| `disk_io_read_mode` | fixed | io_uring |
| `disk_io_type` | fixed | io_uring |
| `disk_io_write_mode` | fixed | io_uring |
| `disk_queue_size` | fixed | library |
| `dl_limit` | setting | `download_limit` |
| `dont_count_slow_torrents` | setting | `count_slow_torrents` (inverted) |
| `dyndns_domain` | unsupported | dynamic DNS is out of scope |
| `dyndns_enabled` | unsupported | as above |
| `dyndns_password` | unsupported | as above |
| `dyndns_service` | unsupported | as above |
| `dyndns_username` | unsupported | as above |
| `embedded_tracker_port` | unsupported | no tracker in the library |
| `embedded_tracker_port_forwarding` | unsupported | as above |
| `enable_coalesce_read_write` | fixed | library |
| `enable_embedded_tracker` | unsupported | no tracker in the library |
| `enable_multi_connections_from_same_ip` | fixed | off (urtorrent Q25) |
| `enable_piece_extent_affinity` | setting | `piece_extent_affinity` (after a restart) |
| `enable_upload_suggestions` | fixed | library |
| `encryption` | setting | `encryption` |
| `excluded_file_names` | setting | `excluded_file_names` (wildcards, case ignored; a file or a folder on its path) |
| `excluded_file_names_enabled` | setting | `excluded_file_names` not empty |
| `export_dir` | setting | `export_dir` |
| `export_dir_fin` | setting | `export_dir_finished` |
| `file_log_age` | unsupported | logs go to stderr (journald) and `GET /log` |
| `file_log_age_type` | unsupported | as above |
| `file_log_backup_enabled` | unsupported | as above |
| `file_log_delete_old` | unsupported | as above |
| `file_log_enabled` | unsupported | as above |
| `file_log_max_size` | unsupported | as above |
| `file_log_path` | unsupported | as above |
| `file_pool_size` | setting | `max_open_files` (after a restart) |
| `hashing_threads` | setting | `hash_threads` (after a restart) |
| `hostname_cache_ttl` | fixed | library DNS |
| `i2p_address` | unsupported | I2P is a library non-goal |
| `i2p_enabled` | unsupported | as above |
| `i2p_inbound_length` | unsupported | as above |
| `i2p_inbound_quantity` | unsupported | as above |
| `i2p_mixed_mode` | unsupported | as above |
| `i2p_outbound_length` | unsupported | as above |
| `i2p_outbound_quantity` | unsupported | as above |
| `i2p_port` | unsupported | as above |
| `idn_support_enabled` | n/a | a display concern |
| `ignore_ssl_errors` | unsupported | the library always validates certificates |
| `incomplete_files_ext` | setting | `incomplete_file_suffix` (`".!qB"` for qBittorrent's; any suffix) |
| `ip_filter_enabled` | unsupported | IP filter files are a library non-goal; addresses and ranges: `banned_ips`, `banned_ip_ranges` |
| `ip_filter_path` | unsupported | as above |
| `ip_filter_trackers` | unsupported | as above |
| `limit_lan_peers` | fixed | library |
| `limit_tcp_overhead` | fixed | library |
| `limit_utp_rate` | fixed | library |
| `listen_port` | setting | `listen_port` |
| `locale` | n/a | a client UI concern |
| `lsd` | setting | `lsd` |
| `mail_notification_auth_enabled` | unsupported | no e-mail (maintainer decision 2026-09-24): webhooks notify |
| `mail_notification_email` | unsupported | no e-mail (maintainer decision 2026-09-24): webhooks notify |
| `mail_notification_enabled` | unsupported | no e-mail (maintainer decision 2026-09-24): webhooks notify |
| `mail_notification_password` | unsupported | no e-mail (maintainer decision 2026-09-24): webhooks notify |
| `mail_notification_sender` | unsupported | no e-mail (maintainer decision 2026-09-24): webhooks notify |
| `mail_notification_smtp` | unsupported | no e-mail (maintainer decision 2026-09-24): webhooks notify |
| `mail_notification_ssl_enabled` | unsupported | no e-mail (maintainer decision 2026-09-24): webhooks notify |
| `mail_notification_username` | unsupported | no e-mail (maintainer decision 2026-09-24): webhooks notify |
| `mark_of_the_web` | n/a | a Windows / macOS concern |
| `max_active_checking_torrents` | setting | `max_checking` (after a restart) |
| `max_active_downloads` | setting | `max_active_downloads` |
| `max_active_torrents` | setting | `max_active_torrents` |
| `max_active_uploads` | setting | `max_active_uploads` |
| `max_concurrent_http_announces` | setting | `max_concurrent_announces` (after a restart) |
| `max_connec` | setting | `max_connections` |
| `max_connec_per_torrent` | setting | `max_connections_per_torrent` |
| `max_inactive_seeding_time` | setting | `max_inactive_seeding_time` |
| `max_inactive_seeding_time_enabled` | setting | `max_inactive_seeding_time` non-null |
| `max_ratio` | setting | `max_ratio` |
| `max_ratio_act` | setting | `share_limit_action` |
| `max_ratio_enabled` | setting | `max_ratio` non-null |
| `max_seeding_time` | setting | `max_seeding_time` |
| `max_seeding_time_enabled` | setting | `max_seeding_time` non-null |
| `max_uploads` | setting | `max_uploads` |
| `max_uploads_per_torrent` | setting | `max_uploads_per_torrent` |
| `memory_working_set_limit` | n/a | a Windows concern |
| `merge_trackers` | setting | `merge_trackers` (never for private torrents, nor before a magnet's metadata) |
| `outgoing_ports_max` | unsupported | not offered by the library |
| `outgoing_ports_min` | unsupported | as above |
| `peer_tos` | unsupported | not offered by the library |
| `peer_turnover` | fixed | library |
| `peer_turnover_cutoff` | fixed | library |
| `peer_turnover_interval` | fixed | library |
| `performance_warning` | n/a | a libtorrent alert |
| `pex` | setting | `pex` |
| `preallocate_all` | setting | `preallocate` |
| `proxy_auth_enabled` | unsupported | proxies are a library non-goal |
| `proxy_bittorrent` | unsupported | as above |
| `proxy_hostname_lookup` | unsupported | as above |
| `proxy_ip` | unsupported | as above |
| `proxy_misc` | unsupported | as above |
| `proxy_password` | unsupported | as above |
| `proxy_peer_connections` | unsupported | as above |
| `proxy_port` | unsupported | as above |
| `proxy_rss` | unsupported | as above |
| `proxy_type` | unsupported | as above |
| `proxy_username` | unsupported | as above |
| `python_executable_path` | unsupported | search is out of scope |
| `queueing_enabled` | setting | `queueing_enabled` |
| `random_port` | setting | `random_port` |
| `reannounce_when_address_changed` | fixed | library |
| `recheck_completed_torrents` | setting | `recheck_on_completion` (after the move to the save path) |
| `refresh_interval` | n/a | clients choose their polling interval |
| `request_queue_size` | fixed | library |
| `resolve_peer_countries` | setting | `geoip_database` (a database file you provide; countries on peers and in `/stats/geo`), `geoip_asn_database` |
| `resolve_peer_host_names` | unsupported | no reverse DNS for peers |
| `resume_data_storage_type` | fixed | SQLite: resume data lives in the daemon's database (ADR 0004) |
| `rss_auto_downloading_enabled` | setting | `rss_auto_download` |
| `rss_download_repack_proper_episodes` | setting | `rss_download_repacks` |
| `rss_fetch_delay` | setting | `rss_fetch_delay` (seconds) |
| `rss_max_articles_per_feed` | setting | `rss_max_articles` |
| `rss_processing_enabled` | setting | `rss_enabled` |
| `rss_refresh_interval` | setting | `rss_refresh_interval` (seconds; qBittorrent's are minutes); per feed: `refresh_interval` |
| `rss_smart_episode_filters` | fixed | built-in episode patterns: `S01E02`, `S01E02-E03`, `1x02`, dates `2026-09-24` / `2026.09.24` |
| `save_path` | setting | `save_path` |
| `save_path_changed_tmm_enabled` | fixed | managed torrents follow the default save path |
| `save_resume_data_interval` | fixed | the engine saves while torrents change and at shutdown |
| `save_statistics_interval` | fixed | every minute and at shutdown |
| `scan_dirs` | setting | `watch_folders` (each with its own add options; see [Watch folders](#watch-folders)) |
| `schedule_from_hour` | setting | `alt_speed_schedule.from` (`HH:MM`) |
| `schedule_from_min` | setting | `alt_speed_schedule.from` |
| `schedule_to_hour` | setting | `alt_speed_schedule.to` |
| `schedule_to_min` | setting | `alt_speed_schedule.to` |
| `scheduler_days` | setting | `alt_speed_schedule.days` (any set of weekdays; empty = every day) |
| `scheduler_enabled` | setting | `alt_speed_schedule` not `null` |
| `send_buffer_low_watermark` | fixed | io_uring data path |
| `send_buffer_watermark` | fixed | as above |
| `send_buffer_watermark_factor` | fixed | as above |
| `slow_torrent_dl_rate_threshold` | fixed | 2 KiB/s (library) |
| `slow_torrent_inactive_timer` | fixed | 60 s (library) |
| `slow_torrent_ul_rate_threshold` | fixed | 2 KiB/s (library) |
| `socket_backlog_size` | fixed | library |
| `socket_receive_buffer_size` | fixed | library |
| `socket_send_buffer_size` | fixed | library |
| `ssl_enabled` | unsupported | SSL torrents are a library non-goal |
| `ssl_listen_port` | unsupported | as above |
| `ssrf_mitigation` | unsupported | not offered by the library |
| `status_bar_external_ip` | n/a | a UI concern; external addresses are in `GET /transfer` |
| `stop_tracker_timeout` | fixed | library |
| `temp_path` | setting | `download_path` |
| `temp_path_enabled` | setting | `download_path` non-null |
| `torrent_changed_tmm_enabled` | fixed | managed torrents move when their category changes |
| `torrent_content_layout` | setting | `content_layout` (default of `options.content_layout`) |
| `torrent_content_remove_option` | unsupported | removed content is deleted, not moved to a trash |
| `torrent_file_size_limit` | fixed | 64 MiB for URL downloads |
| `torrent_stop_condition` | setting | `stop_condition` (default of `options.stop_condition`) |
| `up_limit` | setting | `upload_limit` |
| `upload_choking_algorithm` | fixed | one algorithm (library) |
| `upload_slots_behavior` | fixed | as above |
| `upnp` | unsupported | port mapping is on the library roadmap |
| `upnp_lease_duration` | unsupported | as above |
| `use_category_paths_in_manual_mode` | setting | `category_paths_in_manual_mode` |
| `use_https` | unsupported | no TLS in the daemon (maintainer decision 2026-09-24): terminate TLS in a reverse proxy, which can also mark the session cookie `Secure` |
| `use_unwanted_folder` | unsupported | skipped files' shared pieces go to the library's parts file |
| `utp_tcp_mixed_mode` | fixed | the `transports` policy decides |
| `validate_https_tracker_certificate` | fixed | always validated |
| `web_ui_address` | setting | `--api-listen` |
| `web_ui_api_key` | setting | `POST` / `DELETE /auth/api-key` |
| `web_ui_ban_duration` | setting | `api_ban_duration` |
| `web_ui_clickjacking_protection_enabled` | n/a | no HTML is served |
| `web_ui_csrf_protection_enabled` | setting | `api_csrf_protection` |
| `web_ui_custom_http_headers` | unsupported | no web UI is served |
| `web_ui_domain_list` | setting | `api_allowed_hosts` |
| `web_ui_host_header_validation_enabled` | setting | `api_allowed_hosts` (`["*"]` turns it off) |
| `web_ui_https_cert_path` | unsupported | no TLS in the daemon (maintainer decision 2026-09-24): terminate TLS in a reverse proxy, which can also mark the session cookie `Secure` |
| `web_ui_https_key_path` | unsupported | no TLS in the daemon (maintainer decision 2026-09-24): terminate TLS in a reverse proxy, which can also mark the session cookie `Secure` |
| `web_ui_max_auth_fail_count` | setting | `api_max_auth_failures` |
| `web_ui_port` | setting | `--api-listen` |
| `web_ui_reverse_proxies_list` | setting | `api_trusted_proxies` (addresses or blocks) |
| `web_ui_reverse_proxy_enabled` | setting | `api_trusted_proxies` not empty (`X-Forwarded-For`, `X-Forwarded-Host`) |
| `web_ui_secure_cookie_enabled` | unsupported | no TLS in the daemon (maintainer decision 2026-09-24): terminate TLS in a reverse proxy, which can also mark the session cookie `Secure` |
| `web_ui_session_timeout` | setting | `api_session_timeout` |
| `web_ui_upnp` | unsupported | no port mapping |
| `web_ui_use_custom_http_headers_enabled` | unsupported | no web UI is served |
| `web_ui_username` | setting | `PUT /auth/credentials` |
