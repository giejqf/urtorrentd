# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
