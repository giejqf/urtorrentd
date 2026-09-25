# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `--initial-settings <file>` (`URTORRENTD_INITIAL_SETTINGS`): the settings
  of a new data directory's first start, as a JSON object of setting fields
  over the defaults, so a daemon can start offline from its first second
  (no DHT bootstrap). Ignored once settings are stored; unknown fields are
  errors.
- The daemon serves the web UI at `/` next to the API
  ([ADR 0008](docs/adr/0008-web-ui.md)): built in with the `web-ui` cargo
  feature, from a directory with `--web-ui <dir>` (`URTORRENTD_WEB_UI`),
  or not at all (`--no-web-ui`, and builds without the feature). Paths
  without a file of their own get `index.html`; the pages carry a strict
  Content-Security-Policy and refuse framing; hashed assets are cached for
  good. Unknown `/api/...` paths stay JSON 404s.
- `api_cors_origins`: browser origins allowed to call the API (CORS with
  credentials; preflights answered, errors readable, the CSRF check
  passed). Empty by default: nothing changes until an origin is listed.
- Behind a trusted proxy that says `X-Forwarded-Proto: https`, the session
  cookie is `Secure`.
- Web UI (`frontend/`, SolidJS): first-run setup and sign-in, with session
  expiry and bans explained; the torrents screen as designed: a virtualized
  list grouped by state, sidebar filters by status, category, tag and
  tracker with counts, the daemon's search, keyboard selection and bulk
  actions, a detail panel (properties, category and tag editing, pieces and
  availability, transfer, trackers), adding by link or `.torrent` file,
  and deleting with or without files. Live through the event stream. A
  seed nobody downloads from shows as Idle; only a download that gets no
  data shows as Stalled.
- Web UI: the add dialog as designed. Sources are magnet links, info-hashes
  and URLs, `.torrent` files, or a folder to watch. The daemon previews
  each source before it is added (files, size, pieces, swarm, trackers)
  and each file can be skipped or prioritised. Every option is there: save
  path with a browser of the daemon's folders, category, tags, content
  layout, stop condition, automatic management, speed and ratio limits.
  Duplicates and failures are shown with the daemon's reason, and previews
  that are not used are dropped.
- Web UI: Settings, starting with Speed as designed: global and
  alternative limits in kB/s next to the rates now, the switch to the
  alternative limits, the schedule (window, time zone, days) with a chart
  of the week and when it switches next, and the connection budget. Changes
  are a draft, saved together (Ctrl/⌘ S) or discarded, and leaving asks
  first. A banner offers to restart the daemon when engine settings wait
  for one.
  Screens for statistics, RSS, the log and the other settings sections say
  they are still to come.
- `cargo xtask web` (the UI's checks and end-to-end tests) and
  `cargo xtask dist` (a release binary with the UI built in).

- List rows (`GET /torrents`, the event stream) carry `tracker_hosts`: the
  host of every configured tracker, working or not (never the URLs, which
  can carry passkeys). `GET /torrents?tracker=<host>` filters by it (`""`:
  torrents without trackers).
- `GET /torrents/hashes`: the info-hashes of the list, with the same
  filters, search, sorting and paging as `GET /torrents`, for clients that
  keep the rows from the event stream.

- Categories carry share limits (`share_limits`, as a torrent's): a
  torrent's `global` limits defer to its category's where the category
  sets them, then to the settings. Stored in a new column (schema version
  3); existing categories keep all-`global` limits, so nothing changes
  until one is set.
- Previews keep the swarm the trackers reported (`swarm_seeds`,
  `swarm_leechers`) once the metadata is here, and count connected seeds
  (`seeds`) while fetching.

- `POST /app/restart`: a graceful shutdown, then the same binary starts
  again in the same process with the same arguments, so settings that
  apply after a restart take effect without a shell on the machine.
- `GET /app` has the daemon's system time zone (`time_zone`), the one the
  alternative-limits schedule uses when it names none.
- `POST /app/fetched-trackers/refresh` fetches the `add_trackers_url` list
  at once instead of at its daily turn; `fetched_trackers.fetching` in
  `GET /app` says a fetch is under way.

### Changed

- The session cookie has no `Max-Age`: it lasts for the browser session,
  and the daemon ends login sessions after `api_session_timeout` idle
  seconds. Before, the browser dropped it that long after sign-in even
  while the user was active.
- An event stream opened with a login session keeps the session alive while
  open, and ends when the session ends (sign-out, new credentials, expiry).
  Before, a signed-out page kept receiving updates on a stream it had open.

### Security

- A request carrying forwarding headers (`X-Forwarded-For`, `X-Real-IP`,
  `Forwarded`) from an address that is not in `api_trusted_proxies` is no
  longer exempt from authentication by `api_bypass_local_auth` or
  `api_auth_whitelist`: its real client is unknown. Before, a reverse proxy
  on loopback that was not listed as trusted exempted every client it
  relayed while `api_bypass_local_auth` was on. The daemon logs a warning
  the first time.

## [0.13.0] - 2026-09-24

First-run setup ([ADR 0007](docs/adr/0007-first-run-setup.md)).

### Added

- `POST /auth/setup` (public): while no password is set, the first client
  chooses the user name and password and is logged in at once; afterwards
  `409 conflict`. One caller wins however requests interleave; a
  cross-origin request is refused. The temporary password printed at start
  still works until then, and ends with its sessions at setup.
- `GET /auth/status` (public): `setup_required`, so a client UI can show a
  setup form or a login form.

### Changed

- User names are 1 to 128 characters and passwords 8 to 1024, for
  `PUT /auth/credentials` as for setup.

## [0.12.0] - 2026-09-24

Search over the managed torrents.

### Added

- `GET /torrents?search=`: words that must all match the name, category,
  a tag, any tracker's host, or (6+ hex digits) the start of the info-hash;
  `*` and `?` wildcards, case ignored. Combines with the other filters.
- `GET /torrents/files?search=`: file names across every torrent (or one,
  `hash`), paged, with each file's torrent, index, size, progress and
  priority. The daemon keeps the file paths in memory, so a search does not
  ask the engine for every torrent's files.

### Changed

- Requires urtorrent 0.13.4: HTTP(S) tracker announces and web-seed
  downloads now leave from the listen address (and fail while it is gone),
  and peer connections follow a live `listen_v4` / `listen_v6` /
  `listen_interface` change. `listen_interface` on a VPN interface keeps
  all of the daemon's torrent traffic on it; `docs/gaps.md` has no open
  item.

### Fixed

- A folder rename or incomplete-file suffix pass that failed part way now
  drops the cached content path, so later reads see the renames that did
  happen.

## [0.11.0] - 2026-09-24

The checklist's remaining "planned" rows: every qBittorrent WebAPI endpoint
and preference is now mapped or unsupported with its reason.

### Added

- Settings `content_layout` and `stop_condition`: defaults for adds that
  do not say (`options.content_layout` / `options.stop_condition` are now
  optional).
- `category_paths_in_manual_mode`: a manually managed torrent added with a
  category and no save path goes to the category's.
- `excluded_file_names`: files (or folders on their path) matching a
  wildcard get priority 0 when added; a magnet is held until its metadata
  so nothing is created first.
- `merge_trackers`: adding a torrent again merges its trackers and web
  seeds into the one there (never private ones; the 409 says how many).
- `export_dir`, `export_dir_finished`: the `.torrent` of every torrent
  added / finished is written there.
- `recheck_on_completion`: a finished torrent is rechecked (after its move
  to the save path).
- `POST /torrents/download-path`: move incomplete torrents to a download
  path, or back to the save path.
- The cookie jar (`GET` / `PUT /app/cookies`), sent with `.torrent`
  downloads, RSS feeds and the tracker list.
- `add_trackers_url`: a tracker list fetched at the start and every 24
  hours, added to new public torrents; `GET /app` → `fetched_trackers`.
- `api_trusted_proxies`: behind these reverse proxies the client's address
  (`X-Forwarded-For`, read from the right) and host (`X-Forwarded-Host`)
  are the forwarded ones, for bans, the local bypass, the whitelist and the
  host and origin checks.
- `listen_interface` and `GET /app/interfaces`: listen on and dial peers
  from an interface's addresses, followed as they change, loopback only
  while it has none; `GET /app` → `listen_addresses`. HTTP trackers and web
  seeds are not bound yet (`docs/gaps.md`).
- `instance_name`, shown in `GET /app`.

## [0.10.0] - 2026-09-24

### Added

- **RSS** (qBittorrent's `rss/*`): feeds in folders (`/rss/feeds`,
  `/rss/folders`), refreshed at their interval (`rss_enabled`,
  `rss_refresh_interval`, per-feed `refresh_interval`) with a delay
  between requests to one host and conditional requests; RSS 2.0 and
  Atom with enclosures and torznab / newznab attributes; articles with
  read marks (`/rss/articles`, `/rss/feeds/{id}/read`). Download rules
  (`/rss/rules`): wildcards or regular expressions, episode filters, a
  smart filter taking each episode once (repacks once more), ignore days,
  add options per rule, and a dry run (`/rss/rules/{name}/matches`).
  Errors are logged without the feed URL (passkeys).
- **Client data store** (qBittorrent's `clientdata/*`): `/client-data`
  keeps JSON values by key for client UIs.
- `urtorrentd.db` schema version 2 (migrated on open).

### Removed from the plan

- E-mail notifications (webhooks notify) and HTTPS in the daemon (a
  reverse proxy terminates TLS): their preferences are unsupported, with
  the reason.

## [0.9.0] - 2026-09-24

### Added

- **Alternative-limits scheduler** (`alt_speed_schedule`: `from` / `to` as
  `HH:MM`, weekdays, IANA time zone): the alternative limits go on and off
  at the window's boundaries, in local time with daylight saving; a switch
  by hand holds until the next boundary. qBittorrent's `scheduler_*` and
  `schedule_*` preferences are covered.
- **Watch folders** (`watch_folders`): `.torrent` and `.magnet` files are
  added with each folder's add options once they have settled, then
  renamed to `.added` (or deleted) or, when they cannot be added,
  `.rejected` with the reason logged; optionally recursive. qBittorrent's
  `scan_dirs` is covered.

### Changed

- Tested with urtorrent 0.13.3 (a partial seed says `upload_only`, as
  libtorrent's does); 0.13.2 remains the oldest supported.

## [0.8.0] - 2026-09-24

### Added

- **Metadata preview** (qBittorrent's `fetchMetadata` / `saveMetadata`):
  `POST /previews` fetches a magnet's (or URL's) metadata without adding
  the torrent; `GET /previews/{hash}` shows it fetching, then ready with the
  files; `GET /previews/{hash}/torrent-file` returns the `.torrent`;
  `DELETE` drops it. Adding the same info-hash uses the fetched metadata.
  Previews are in no list or statistic, are not kept across restarts, and
  go away after 15 minutes unread.
- **Webhooks** (ADR 0006; qBittorrent's run-on-add and run-on-completion,
  without running programs): `/webhooks` calls URLs on `added`,
  `metadata`, `finished`, `moved`, `error` and `removed` with a typed
  `WebhookPayload` (the torrent's list row included), signed with
  HMAC-SHA256 when a secret is set, retried on no answer, 429 and 5xx,
  redirects not followed; `POST /webhooks/{id}/test`; the last deliveries
  are shown. The `autorun_*` preferences are covered.

## [0.7.0] - 2026-09-23

### Added

- **Peer breakdowns**: `GET /stats/peers?dim=` `client` (name without its
  version), `source` (tracker, DHT, PEX, LSD, incoming, ...), `transport`,
  `encryption`, `ip_version`, `direction`; per torrent or overall, with
  `unattributed` so the rows add up, optionally as a series.
- **Groups**: `GET /stats/groups?group=category|tag`: traffic by the
  category and tags each torrent has.
- **Trackers**: `GET /stats/trackers`: per tracker host, the traffic of the
  torrents working with it and its announces answered and failed. Hosts
  only, never URLs (passkeys).
- **Idle seeds**: `GET /stats/idle-seeds?days=`: complete torrents by what
  they uploaded in the window relative to their size, least first.
- **Scrapes** (opt-in, `stats_scrape_interval`): the swarm's completed
  downloads in each day (`swarm_completed_max`).
- `stats.db` schema version 3 (migrated on open).

## [0.6.0] - 2026-09-23

### Added

- **Geolocation**: settings `geoip_database` and `geoip_asn_database` take
  MaxMind DB files you provide (DB-IP Lite, GeoLite2, IPinfo Lite; never
  downloaded, re-read when replaced). Peers (`GET /torrents/{hash}/peers`)
  carry `country`, `asn` and `as_org`; `GET /app` shows the databases in
  use. qBittorrent's `resolve_peer_countries` is covered.
- **Traffic by place**: `GET /stats/geo` has peer traffic by country or
  autonomous system, per torrent or overall, per hour or day, optionally as
  a series. Rows plus `unattributed` (web seeds, missed closes, the seconds
  since the last sample) add up to the torrents' traffic. Per-connection
  counters are differenced like a torrent's: peers of active torrents are
  sampled every 10 s and closed connections bring their final counters.
  Peer addresses are never written to disk.
- `stats.db` schema version 2 (migrated on open).

## [0.5.0] - 2026-09-23

### Added

- **Statistics** (ADR 0005), recorded in `<data dir>/stats.db`: per-torrent
  traffic by minute and hour, a row per torrent per day it ran or moved data
  (its seeding history: bytes, running and seeding time, all-time counters,
  ratio, swarm size), session traffic, a timeline (added, metadata,
  finished, moved, error, removed, state changes) and the periods in which
  anything was recorded. All from differences of the library's counters.
  Endpoints: `GET /stats`, `/stats/transfer`,
  `/stats/torrents/{hash}/traffic`, `/stats/torrents/{hash}/days`,
  `/stats/top`, `/stats/timeline`, `DELETE /stats/torrents/{hash}`. Removed
  torrents keep their history.
- Settings `stats_enabled`, `stats_minute_retention` (48 h),
  `stats_hour_retention` (90 days), `stats_day_retention` (forever).
- Error code `unavailable` (503): a `stats.db` that cannot be opened turns
  statistics off for the run instead of stopping the daemon.

### Changed

- urtorrent 0.13.2. It marks resume data for every change the data records
  (trackers, per-torrent settings, the queue flag, queue moves), so shutdown
  saves only the torrents that changed instead of all of them.

### Fixed

- A seed's transfer counters were saved only at a clean shutdown: the
  library does not mark resume data for counters, so after `kill -9` a
  seed's upload fell back to its last save (possibly days old). The daemon
  now saves a torrent whose counters moved, at most once a minute.

## [0.4.0] - 2026-09-23

### Added

- **Live updates as server-sent events**: `GET /api/v1/events` pushes the
  same diffs as `GET /sync` (`SyncResponse` data, the revision as the event
  id): everything at once, then only what changed, at most once a second
  and only when something did. `EventSource` resumes with `Last-Event-ID`;
  an unknown id gets everything; a slow client gets the latest changes, not
  a backlog; idle streams send a comment every 15 s. The TypeScript check
  types a client's `EventSource` handler from the generated schema.

### Fixed

- A shutdown (API, SIGTERM, SIGINT) ends open event streams first, so the
  HTTP server's graceful shutdown does not wait on them; covered by a test
  that stops the real binary with a stream open.

## [0.3.0] - 2026-09-23

### Added

- **A suffix for incomplete files**: the `incomplete_file_suffix` setting
  (`".!qB"` gives qBittorrent's behaviour; off by default). Files that are
  not complete carry it and lose it as each one completes; a check takes it
  off the files it finds complete and puts it back on any a recheck finds
  incomplete; changing the setting renames the files of every torrent. Done
  with the library's `rename_file` and `FileCompleted` (no library change);
  a `.torrent` is held at once while the suffix is on, so no file is created
  under its final name first.
- `docs/settings.md` shows how to stage downloads in a download path and have
  them move to their category's directory on completion (automatic
  management), now covered end to end by a test together with the suffix.

## [0.2.0] - 2026-09-23

Persistence moves to SQLite, and the daemon follows urtorrent 0.13.1, which
closed the gap list the daemon had filed (`docs/gaps.md`). Breaking: the
data directory's format (0.1 directories are imported on the first start),
and new enum values in the API (`TorrentState::held` / `unknown`,
`TrackerStatus::updating`).

### Changed

- **All state lives in one SQLite database**, `urtorrentd.db` (ADR 0004):
  settings, credentials, categories, tags, totals, the DHT state, and per
  torrent the record, the `.torrent` and the library's resume data. One
  transaction per change set (a bulk action over thousands of torrents is one
  commit) instead of two `fsync`s per file; the per-minute rewrite of every
  record is gone. The daemon now holds the resume data itself: saved when the
  library says it changed (at most once a minute), after checks and
  completions, and for every torrent at shutdown.
- A 0.1 data directory is imported in one transaction on the first start; the
  old files move to `imported-0.1/`.
- Built on urtorrent 0.13.1. List rows take the working tracker, swarm
  counts, availability (distributed copies), `sequential` and the activity
  times from `statuses()`; the caches and mirrored fields that stood in for
  them are gone, and the activity times now survive restarts.
- **Errored torrents recover**: `start` looks for missing files again or
  retries after a disk error, `recheck` clears the error and rechecks; only
  unusable metadata is refused (`409 busy`). The torrent's `error_kind`
  (`content_missing`, `io`, `metadata`) is in the API.
- **Magnets are held** when a stop condition or a content layout needs it:
  nothing is downloaded before the stop, and the layout is applied before any
  file exists. A `.torrent` whose layout renames files is held at once.

### Added

- First and last piece of each file first: `options.first_last_piece_priority`
  and `POST /torrents/first-last-piece-priority` (urtorrent 0.13 piece
  priorities); piece priorities in `GET /torrents/{hash}/pieces`.
- Banned address ranges: the `banned_ip_ranges` setting (`10.0.0.0/8`,
  `fd00::/8`, `first-last`).
- Tracker rows per listen socket (`endpoints`) and an `updating` status.
- Peers the engine bans for corrupt data appear in the peer log.

## [0.1.0] - 2026-09-23

The first release: a daemon on urtorrent 0.11.4 with a typed HTTP API that
covers the features of qBittorrent 5.2.3's WebAPI the library supports
(`docs/api.md`, `docs/settings.md`). The alternative-limits scheduler, RSS,
watch folders and the other "planned" rows follow; `docs/gaps.md` lists what
they need from the library.

### Added

- The daemon on urtorrent 0.11.4: one engine session, a registry of torrents
  by info-hash, and a data directory that survives restarts and `kill -9`
  (engine-managed resume files, daemon records, atomic writes; ADR 0002).
- The HTTP API under `/api/v1` on axum (ADR 0001): login sessions and API
  keys, login bans, CSRF and `Host` checks; settings with live apply and
  restart-only fields; adding torrents from `.torrent` files, magnet links,
  info-hashes and URLs (with the identity's user agent); the torrent list
  with filters, sorting and paging; bulk start / stop / force start /
  recheck / reannounce / delete / queue moves / limits / share limits /
  location / category / tags / automatic management / peers; per-torrent
  detail, files (priorities, renames), trackers, web seeds, peers, pieces,
  piece hashes and `.torrent` export; categories and tags; transfer state,
  alternative speed limits and bans; incremental sync; main and peer logs.
- Daemon policies: automatic management (save path from the category),
  download path with a move on completion, stop conditions, content layout,
  automatic trackers for public torrents only, share limits (stop, remove,
  remove with files).
- A typed OpenAPI 3.1 schema generated from the code (utoipa), committed as
  `openapi.json` and served at `/api/v1/openapi.json`; tests validate every
  response against it, and `cargo xtask sdk` type-checks a TypeScript client
  generated from it (ADR 0003).
- The feature checklist: qBittorrent 5.2.3's WebAPI actions and preference
  keys (`docs/reference`), each mapped or marked unsupported in
  `docs/api.md` / `docs/settings.md`, enforced by `tests/coverage.rs`.
- Stop conditions on `.torrent` files are race-free: the torrent is added
  stopped and still runs its initial check. On magnets they react to the
  engine's events (racy until the library can hold a magnet after its
  metadata; docs/gaps.md).
- `start`, `force-start` and `recheck` refuse a torrent in the `error` state
  (`409 conflict`) instead of reporting a success that did nothing: the
  library cannot clear an error yet (docs/gaps.md).
