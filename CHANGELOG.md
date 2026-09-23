# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
