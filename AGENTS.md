# AGENTS.md

Guide for coding agents working on this repository. Read it fully before touching code.
Working name: **`urtorrentd`**.

Before any design work, also read these files in the sibling library repo `../urtorrent`:

| File | Why |
|---|---|
| `AGENTS.md` | The library's charter. Its rules 1-3 bind this repo too (section 1). |
| `docs/config.md` | **The line between the library and a frontend.** This daemon is that frontend. |
| `docs/resume.md` | How a torrent survives a restart. The daemon's persistence builds on it. |
| `crates/session/src/api.rs` | The whole public API in one file: `Session`, `AddTorrent`, snapshots, events. |
| `crates/session/tests/daemon.rs` | What 0.8.0 added for a daemon, used the way a daemon would use it. |
| `docs/quirks.md` Q13, Q26, Q27 | Magnet metadata handling, the queue (qBittorrent-style pause/resume/force), live settings. |

## 1. What this project is

A BitTorrent **daemon** for Linux, written in Rust and built on the `urtorrent` library
(`../urtorrent`). It is controlled through an **HTTP API served with `axum`**. The API works
the way qBittorrent's WebAPI does: authenticated sessions, torrents addressed by info-hash,
bulk actions, and incremental sync for polling clients. It offers **every feature
qBittorrent's WebAPI offers that `urtorrent` supports**.

**qBittorrent is a feature checklist, not a compatibility target.** Its WebAPI (section 2)
is how we make sure no feature is missed. Endpoint names, parameters, response shapes,
status codes, error texts and version strings are **ours to design** (section 4.3). We do
not emulate qBittorrent's responses, report its versions, or aim to work with qBittorrent
frontends or clients.

The urtorrent roadmap planned this ("then the daemon itself (a separate crate/repo)",
`../urtorrent/AGENTS.md` section 8). Library 0.8.0 ("daemon readiness") and 0.9.0 (live
settings) added what a daemon needs.

### Non-goals

- **Engine work in the daemon.** The daemon does no peer wire, tracker traffic, piece
  picking or torrent file I/O. Anything that needs engine state or timing belongs in the
  library (`docs/config.md`, "the rule").
- **Features urtorrent excludes** (`../urtorrent/AGENTS.md` section 1): torrent creation,
  search, proxies, UPnP / NAT-PMP, I2P, SSL torrents, share mode, super-seeding,
  IP-filter file formats, BEP 52 (v2 / hybrid). They are listed as unsupported in the
  checklist, with the reason.
- **Compatibility with qBittorrent clients**: its WebUI, VueTorrent, the *arr apps,
  `qbittorrent-api`. Do not bend our API design to fit them.
- **UI logic in the daemon.** The daemon serves the web UI's built files (`frontend/`,
  section 8), but nothing in the API exists for the UI alone: it is a client of
  `openapi.json` like any other, with its own guide in `frontend/AGENTS.md`.
- **Other operating systems.** urtorrent is Linux-only on io_uring, and so is this daemon.

### Non-negotiable rules

1. **Accounting is always truthful** (library rule 1). Every counter, ratio, progress and
   time the API reports comes from library snapshots, or from the daemon's own
   observations of them. No endpoint, setting or test helper can fake one. Policies such
   as share limits may pause or remove a torrent. They never edit a number. There is no
   "skip hash check" (`docs/config.md` says why).
2. **Private torrents are sacred** (library rule 2). The library already keeps DHT, PEX
   and LSD off private torrents. The daemon must never add trackers, web seeds or peers
   to a private torrent on its own, for example from an "add these trackers to new
   torrents" setting or a duplicate-add tracker merge. An explicit per-torrent API call
   from the user is the user's choice.
3. **No feature is silently missed.** Every qBittorrent WebAPI endpoint, parameter and
   preference key in the reference (section 2) appears in the coverage docs (`docs/api.md`,
   `docs/settings.md`). Each one is either mapped to our API or marked unsupported with
   its reason: library non-goal, library gap, or out of scope for the daemon. A feature
   that is unsupported is absent from our API. It is never a flag that is accepted and
   ignored, and never a field that reports a fake value.
4. **Tests never touch the public internet** (library rule 3). The library's DHT bootstrap
   defaults are public, so tests pass an empty list or lab routers. URL-add tests use a
   local HTTP server. Any qBittorrent instance used in tests or for reference runs in an
   isolated network namespace.
5. **Respect the library boundary.** Use only the public API of the `urtorrent` facade
   crate, never its internal crates. The engine owns torrent content. The daemon never
   reads, writes, moves or deletes content files itself: it calls `move_storage`,
   `remove_torrent_with_files` or `rename_file` instead. It never parses or edits the
   engine's resume files either. When the library lacks something, record it in
   `docs/gaps.md` and raise it upstream. Do not hack around it.
6. **Do not weaken, skip or delete a failing test to get green.** Fix the code or escalate.
7. **Never copy qBittorrent code.** qBittorrent is GPL. Reading its source and running it
   to learn what a feature does is fine. Our implementation and API are our own.

## 2. The feature reference

The checklist comes from the qBittorrent build urtorrent already pins as its oracle
(`../urtorrent/testkit/oracle.lock`): `qbittorrent-nox` 5.2.3 with libtorrent 2.0.14,
cached at `~/.cache/urtorrent/oracle/`. Nothing in our API depends on that version.
When urtorrent moves its pin, re-check the reference for new features.

- **Endpoints.** The WebAPI has about 110 actions in 10 scopes: `auth`, `app`, `log`,
  `sync`, `transfer`, `torrents`, `rss`, `search`, `torrentcreator` and `clientdata`.
  Section 3 lists them.
- **Settings.** `app/preferences` has 223 keys. `docs/settings.md` maps every one.
- **Parameters.** Endpoints such as `torrents/add` have many parameters, and each one is
  a feature (section 4.7).
- **How to look something up.** Read qBittorrent's source (rule 7). To see what a feature
  actually does, run the pinned build in a fresh network namespace with only loopback
  (`sudo unshare -n`, `ip link set lo up`, then `sudo -u $USER qbittorrent-nox
  --profile=<tmpdir>`), with DHT / LSD / PEX / UPnP off in `qBittorrent.conf`. Its
  temporary WebUI password is printed on stdout. urtorrent's `testkit` also launches it
  in its netns lab.

Features the reference has that are easy to miss: API keys (`Authorization: Bearer`,
rotate / delete) next to cookie sessions, a temporary password printed at startup when
none is set, login bans after repeated failures, rid-based incremental sync for torrents
*and* for one torrent's peers, per-source peer counts (DHT / PEX / LSD) shown next to
trackers, tracker endpoint detail, piece hashes and per-piece availability, `.torrent`
export, the log of banned peers, and a metadata preview before adding (`parseMetadata`,
`fetchMetadata`).

## 3. Coverage: the reference against the library

Legend: **L** a `Session` call does it. **D** daemon-owned: `docs/config.md` puts it on the
frontend side, and it is built on snapshots and public operations. **P** partial, with the
gap named. **U** unsupported, with the reason. The names are qBittorrent's (the checklist);
our endpoints are named in `docs/api.md`, which keeps the full, current table.

| Scope | Endpoints | Status |
|---|---|---|
| `auth` | `login`, `logout` | D |
| `app` | `version`, `webapiVersion`, `buildInfo`, `processInfo` | D (our own version and build info) |
| `app` | `defaultSavePath`, `getDirectoryContent`, `networkInterfaceList`, `networkInterfaceAddressList`, `cookies`, `setCookies`, `rotateAPIKey`, `deleteAPIKey` | D |
| `app` | `shutdown` | L `shutdown` (after persisting, 4.8) |
| `app` | `preferences`, `setPreferences` | P: key by key in `docs/settings.md` (4.9) |
| `app` | `sendTestEmail` | U: no e-mail (maintainer decision 2026-09-24); webhooks notify (`POST /webhooks/{id}/test`) |
| `log` | `main`, `peers` | D (the daemon's own ring buffers) |
| `sync` | `maindata` | D over L snapshots (4.6) |
| `sync` | `torrentPeers` | L `peers`, plus country and ASN from a user-supplied GeoIP database (D) |
| `transfer` | `info` | L `stats` (connectability derived from incoming connections) |
| `transfer` | `downloadLimit`, `uploadLimit`, `setDownloadLimit`, `setUploadLimit` | L `set_rate_limits` |
| `transfer` | `speedLimitsMode`, `setSpeedLimitsMode`, `toggleSpeedLimitsMode` | D (alternative limits, scheduler → `set_rate_limits`) |
| `transfer` | `banPeers` | L `ban_ip` (per IP) |
| `torrents` | `count`, `info`, `properties`, `files`, `trackers`, `webseeds`, `pieceStates`, `pieceHashes`, `pieceAvailability`, `export` | L `statuses` / `status` / `files` / `trackers` / `pieces` / `torrent_file`, plus metainfo parsing of the `.torrent` |
| `torrents` | `add` | L `add_torrent`, plus D for URL fetch, category, tags, stop condition, content layout, add-to-top, share limits, automatic management, download path and rename (4.7) |
| `torrents` | `start`, `stop`, `setForceStart`, `delete`, `recheck`, `reannounce` | L `resume` / `pause` / `force_resume` + `set_auto_managed` / `remove_torrent(_with_files)` / `force_recheck` / `force_reannounce` |
| `torrents` | `topPrio`, `bottomPrio`, `increasePrio`, `decreasePrio` | L `move_in_queue` |
| `torrents` | `filePrio`, `renameFile`, `toggleSequentialDownload`, `setLocation`, `setSavePath` | L `set_file_priorities` / `rename_file` / `set_sequential` / `move_storage` |
| `torrents` | `renameFolder` | P: one `rename_file` per file, not atomic |
| `torrents` | `setDownloadPath` | D (download to one path, `move_storage` on `TorrentFinished`) |
| `torrents` | `uploadLimit`, `downloadLimit`, `setUploadLimit`, `setDownloadLimit` | L `set_torrent_rate_limits` |
| `torrents` | `setShareLimits` | D (ratio / seeding time / inactive time policy) |
| `torrents` | `addTrackers`, `editTracker`, `removeTrackers`, `addWebSeeds`, `editWebSeed`, `removeWebSeeds`, `addPeers` | L `add_tracker` / `remove_tracker` / `add_web_seed` / `remove_web_seed` / `add_peer` (edit = remove + add at the same tier) |
| `torrents` | `categories`, `createCategory`, `editCategory`, `removeCategories`, `setCategory`, `tags`, `createTags`, `deleteTags`, `addTags`, `removeTags`, `setTags`, `rename`, `setComment`, `setAutoManagement` | D. **`setAutoManagement` is qBittorrent's Automatic Torrent Management (save path from category), not urtorrent's `auto_managed` (the queue).** |
| `torrents` | `parseMetadata` | L (metainfo parsing only, nothing added) |
| `torrents` | `fetchMetadata`, `saveMetadata` | D: a preview (`/previews`) held with `hold_after_metadata` outside the registry; its `.torrent` is kept and used by the add |
| `torrents` | `toggleFirstLastPiecePrio` | L `set_piece_priorities` (urtorrent 0.13), the pieces chosen by the daemon |
| `torrents` | `setSuperSeeding`, `SSLParameters`, `setSSLParameters` | U: library non-goals |
| `rss` | all | D: `/rss` (feeds in folders, articles, download rules; 4.14) |
| `search` | all | U: non-goal |
| `torrentcreator` | all | U: library non-goal (open question in section 8) |
| `clientdata` | `load`, `store` | D: `/client-data` |

## 4. Architecture

### 4.1 Layout (split crates only when a boundary earns it)

```
Cargo.toml              workspace: crates/urtorrentd, xtask
rust-toolchain.toml     the same pin as ../urtorrent (1.98.1, edition 2024)
openapi.json            the generated API schema, committed (4.3, ADR 0003)
crates/urtorrentd/src/
  main.rs               CLI (run, passwd, openapi), tokio runtime, signals, shutdown order
  daemon/               the core: owns the urtorrent Session and the registry
    mod.rs              start / restore / shutdown, State and Entry, records, bulk selection
    add.rs              sources (base64, magnet, info-hash, URL) and the add pipeline
    ops.rs              per-torrent operations (lifecycle, limits, moves, files, trackers, ...)
    organize.rs         categories, tags, automatic management
    view.rs             list rows, detail, transfer info, caches
    preview.rs          metadata previews (fetchMetadata / saveMetadata)
    watched.rs          watch folders (scan_dirs)
    net.rs              cookie jar, tracker list from a URL, following listen_interface
    filesearch.rs       the file-path index behind the file search
    events.rs           the single event pump (4.4)
    tick.rs             activity tracking, share limits, periodic flushes
  rss/                  RSS: feeds, articles, rules (mod.rs), SQL (db.rs), documents (parse.rs),
                        rule matching (rules.rs)
  api/                  axum handlers, one module per feature group; guard.rs = auth
  model.rs              every request / response type (ToSchema)
  settings.rs           Settings / SettingsPatch from one field list, live apply
  store.rs              the SQLite database: schema, migrations, 0.1.0 import (ADR 0004)
  stats/                history (ADR 0005): the sampler (mod.rs), per-peer attribution (peers.rs),
                        stats.db (db.rs), /stats (query.rs)
  geo.rs                GeoIP: user-supplied .mmdb files, country and ASN lookups
  webhooks.rs           webhooks: signed HTTP deliveries of torrent events (ADR 0006)
  interfaces.rs         network interfaces; listen addresses with listen_interface resolved
  auth.rs log.rs sync.rs error.rs util.rs
crates/urtorrentd/tests/  API tests on real engines, restart / kill -9, statistics, schema, coverage
sdk/typescript/         generates TypeScript types from openapi.json and type-checks a client
frontend/               the web UI (SolidJS, Vite), a client of the API; its own AGENTS.md
xtask/                  check, openapi, sdk
docs/api.md             our API: every endpoint, plus the checklist mapping (section 3)
docs/settings.md        every qBittorrent preference key: our setting / fixed / unsupported
docs/gaps.md            what the daemon needs from urtorrent and does not have yet
docs/reference/         the checklist: qBittorrent 5.2.3's actions, parameters, preference keys
docs/adr/               design decisions
```

Depend on the facade only: `urtorrent = { path = "../urtorrent/crates/urtorrent", version =
"0.13.4" }` during development (the version is the oldest library release the daemon is
tested against; raise it when the daemon starts using something newer). CI checks both repos out side by side. Switch to a pinned git revision or a
crates.io version once one is published. The library is `0.x`, so a minor bump is
breaking: pin the minor. The facade re-exports what the daemon needs, including
`urtorrent::Torrent::parse` and `urtorrent::MagnetLink::parse` for info-hashes before an
add, and `Profile` for identity.

### 4.2 Runtime model

- `#[tokio::main]` with the multi-threaded runtime runs axum, persistence, URL downloads
  and timers. The engine runs on its own io_uring threads (`urt-net`, `urt-disk`, hash
  pool). `Session` is `Clone + Send + Sync`. Every call is a channel message the engine
  answers (library 5.6).
- Library rule 4 (no epoll reactors, tokio `sync` only) polices the **library's**
  dependency graph. The daemon's graph contains tokio's runtime and mio through axum, and
  that is expected. The boundary still holds: tokio never owns a peer socket or a torrent
  file, and nothing tokio owns is handed to the engine.
- `Session::builder().build()` fails hard without io_uring (`Error::Unavailable`). Exit
  with that message. There is no fallback. Deployment docs must cover kernel 6.1+,
  `kernel.io_uring_disabled` and container seccomp profiles (library 7.2).
- SIGTERM and SIGINT take the same path as the shutdown endpoint (4.8).

### 4.3 API conventions ([ADR 0001](docs/adr/0001-api-conventions.md)) and the typed schema ([ADR 0003](docs/adr/0003-typed-schema.md))

- **The schema is generated, never written by hand.** Handlers carry `#[utoipa::path]`
  annotations and are registered only through `utoipa_axum::routes!`, so the router and
  the OpenAPI document come from one list. Request and response types live in `model.rs`
  (and `settings.rs`, `store.rs`) and derive `ToSchema`. Frontends generate their SDK
  from `openapi.json`; anything that breaks that breaks the product.
- Adding or changing an endpoint: annotate it, register it in `api::routes()`, give it a
  unique handler name (it becomes the SDK method name), call it from a test (every
  response in the tests is validated against the schema), update `docs/api.md`, run
  `cargo xtask openapi`, and commit `openapi.json` with the change.
- Schema rules: request types put `#[serde(default)]` on fields, never on the container
  (openapi-typescript would make the fields required); always-present `Option` fields in
  responses carry `#[schema(required = true)]`; enums only referenced from query
  parameters are listed in `ApiDoc`'s `components`.
- Everything lives under a versioned base path (`/api/v1/...`), grouped by feature like the
  reference's scopes, so the checklist maps cleanly.
- JSON request and response bodies. A `.torrent` travels base64 inside JSON; the export
  endpoint returns `application/x-bittorrent`.
- **One unit per kind of value across the whole API:** bytes, bytes per second, seconds,
  unix timestamps (UTC). Unknown or unlimited is `null`, never a magic number (qBittorrent
  uses `-1`, `0` and `8640000` inconsistently; do not copy that).
- Torrents are addressed by lowercase hex v1 info-hash. Bulk actions take a list of hashes,
  or an explicit "all". Unknown hashes in a bulk request are reported back, not dropped
  silently.
- Errors use proper HTTP status codes and one JSON shape with a stable machine-readable
  code and a human message. Map library errors deliberately: `NoSuchTorrent` → 404,
  `InvalidArgument` → 400, `Busy` / `Duplicate` → 409, `Shutdown` → 503.
- `docs/api.md` documents every endpoint with an example, and changes in the same PR as
  the endpoint.

### 4.4 Addressing, snapshots, caches and the event pump

- `TorrentId` is per process: it never appears in the API or on disk. The registry maps
  hash → (`TorrentId`, daemon record). Parse before adding (`Torrent::parse` /
  `MagnetLink::parse`) so the hash is known before `add_torrent`.
- `statuses()` is the list snapshot, and since urtorrent 0.12 it carries what a list row
  needs: working tracker, tracker count, swarm counts, distributed copies, `sequential`,
  activity times, error kind. Never answer a list endpoint with one `status(id)` or
  `trackers(id)` per torrent: urtorrent handles 10 000 torrents in a session, and the
  daemon must not be the bottleneck.
- Three caches remain, all changed only by edits: tracker URLs (for list rows' magnet
  links and the tracker-host search), the content path, and every torrent's file paths
  (the file search, `filesearch.rs`; dropped on renames, layouts, the suffix and
  metadata arriving). Wanting a field in `statuses()` is a `docs/gaps.md` entry,
  not an N+1 loop.
- **One** task consumes `Session::events()`. It updates caches, feeds the main and peer
  logs (`PeerBanned`), stores magnets' metadata, saves resume data after checks and
  completions, runs event-driven policies (held magnets, download-path moves) and on
  `Event::Lagged` drops the caches. Other code subscribes to the daemon, not to the
  engine.

### 4.5 Long operations

`force_recheck`, `move_storage`, `set_file_priorities` and `scrape` resolve only when the
work is done. A request that starts one of these returns as soon as the operation is
accepted. The operation runs as a tracked background task. Its progress shows in the
torrent's state (`checking`, `moving`) and its failure goes to the main log.

### 4.6 Incremental sync

Polling clients need what `sync/maindata` and `sync/torrentPeers` give qBittorrent's: a
full snapshot first, then only what changed since a revision the client holds. That
includes removals (torrents, categories, tags) and the session's transfer state.

- One shared snapshot is built at most every 500 ms however many clients poll; the
  fingerprints of the last 16 are kept (`sync.rs`). A client passes the `rev` it holds and
  gets what changed since; an unknown or expired revision gets a full snapshot. No
  per-client state.
- Changed torrents and categories are sent whole (typed objects, not field-level
  patches), so SDK types stay exact.
- The same diffs are pushed as server-sent events (`GET /events`, `sync.rs`
  `event_stream`): at once, then at most every second when something changed; the event
  id is the revision, so `EventSource` resumes with `Last-Event-ID`. Nothing is queued
  per client (each event is computed when the connection can take it). Streams end on
  a shutdown request, so the HTTP server's graceful shutdown never waits on them; the
  signal handler requests one too. Polling stays for scripts.

### 4.7 Feature notes (what the reference offers, sourced from the library)

- **States.** The library's `TorrentState` (fetching metadata, queued for checking,
  checking, downloading, seeding, queued, paused, held, error) plus flags the daemon
  derives: *stalled* (running with no payload flowing), *forced* (running, not
  auto-managed), *moving*. The reference filters its list by these (downloading,
  seeding, completed, stopped, running, active, inactive, stalled, checking, moving,
  errored), and so must ours. Errors carry a kind (`content_missing`, `io`,
  `metadata`); `start` and `recheck` recover the first two (urtorrent 0.12).
- **Queue semantics are already qBittorrent's** (library Q26). Stop = `pause` (leaves the
  queue). Start = `resume` (rejoins it). Force start = `force_resume`, undone with
  `set_auto_managed(true)`. The queue position comes from `queue_position`.
- **Listing data.** Size, completed, left and progress use the wanted totals
  (`total_wanted`, `total_wanted_done`, `wanted_progress`), not the full torrent. Wasted
  bytes = `corrupt + redundant`. Leechers = `peers - seeds`. Also provide the connection
  cap, per-session counters (the daemon subtracts a baseline taken at add or at daemon
  start), ratio, ETA, popularity, magnet URI, content path, and per-file piece ranges
  (computed from the metainfo). Peer counts per discovery source come from
  `PeerInfo::source` (`Dht`, `Pex`, `Lsd`).
- **File and piece priorities.** The library takes `0` (skip) and `1..=7` per file, and
  per piece since 0.13. File indexes follow the library's content-file order, and
  padding files (BEP 47) are never listed. First-and-last-piece-first is the daemon's:
  it raises those pieces with `set_piece_priorities` and re-applies after every file
  priority change (which decides every piece again).
- **Holding.** When the daemon has work to do before any file exists, the torrent is
  added with `hold_after_metadata`: a `.torrent` whose content layout renames files
  (held at once), a magnet with a stop condition or a layout (held when the metadata
  arrives; it stops like qBittorrent's "metadata received" condition). `finish_hold`
  renames, applies piece priorities, then `release`s (checked, stays stopped) or
  starts it. A `.torrent` with a stop condition is simply added paused: its initial
  check still runs.
- **Incomplete-file suffix** (`incomplete_file_suffix`, qBittorrent's `.!qB`): files
  that are not complete carry it. The daemon renames through `rename_file` (never the
  files itself): before a held torrent is released (a `.torrent` is held at once while
  the suffix is on), after every check, when a magnet's metadata arrives, on
  `FileCompleted`, and for every torrent when the setting changes (`suffix.rs`).
- **Staging and category directories**: incomplete content lives in the download path
  (global or the category's) and moves to the save path on `TorrentFinished`; with
  automatic management the save path is the category's (`docs/settings.md`).
- **Add parameters with no library switch.** Add to top of queue: `move_in_queue(Top)`.
  Rename, category, tags and share limits: the daemon record. Skip-checking is
  unsupported (rule 1). Record each in `docs/api.md`.
- **Adding from a URL.** The daemon fetches `http(s)` URLs itself with a cookie jar, over
  rustls (no OpenSSL, as in the library). The `User-Agent` is the `user_agent` field of
  the active identity `Profile`, never a hardcoded string. Private trackers see these
  requests.

### 4.8 Persistence and restart ([ADR 0004](docs/adr/0004-sqlite.md))

Everything persistent is in one SQLite database (recorded history is apart, in
`stats.db`, 4.11), `<data dir>/urtorrentd.db` (WAL,
`synchronous = FULL`, schema version in `user_version`, `store.rs`):

1. **The metainfo** (`torrents.metainfo`), stored when a `.torrent` is added or when a
   magnet's metadata arrives (`torrent_file` is `None` before); until then the record
   holds the magnet link.
2. **Resume data** (`torrents.resume`), the library's bytes, never parsed here. The
   daemon fetches `resume_data(id)` when `needs_resume_save` is set or the transfer
   counters moved (the library does not mark those), at most once a minute per torrent,
   at once after a check and when a download finishes, and at shutdown for every torrent
   that changed since its last save (activity times included); it passes the bytes back with `AddTorrent::resume_data`. The
   library syncs the content before returning them, so they never claim data that is
   not on disk. The resume data holds the have-set, counters, activity times, queue
   position, trackers, priorities and per-torrent settings.
3. **The daemon's own record** (`torrents.record`, JSON): save and download path,
   stopped, category, tags, name and comment overrides, automatic management,
   first-and-last-piece flag, share limits, source URL, a pending stop condition or
   layout. Settings, credentials (hashes), totals and the DHT state are in `state`;
   categories and tags have their own tables.

- **One transaction per change set**: records are marked dirty and written together
  (a bulk action is one commit; the tick flushes within 2 s whatever events and
  policies changed).
- **Order**: a row is inserted before the engine add and deleted after the engine
  removal; updates never re-create a deleted row. After `kill -9` a restart brings every
  torrent back, at worst with a minute-old resume state.
- **Formats**: the schema migrates on open; a 0.1.0 data directory (JSON files) is
  imported once and its files moved to `imported-0.1/`. Every release reads every format
  it ever wrote.
- Startup order: open the database → build the `Session` (listen, identity profile,
  limits, queue limits, bans, `dht_state`) → re-add every torrent in insertion order
  with its resume data (queue positions come back from it) → start the API. Shutdown
  order: stop taking API requests → resume data for every torrent → records → totals →
  `dht_state()` → `session.shutdown().await`.

### 4.9 Settings

- `docs/settings.md` maps **every** key of the reference's `app/preferences`. Each key is
  one of: our setting (which `SessionBuilder` / `set_*` call, or which daemon policy),
  fixed (a library constant, shown read-only), or unsupported (with the reason). Our
  settings API has its own names and units (4.3). `Session::settings()` is the source of
  truth for library-side values.
- Most library knobs change live (`set_listen`, `set_dht`, `set_profile`, limits, queue,
  encryption, transports, PEX, LSD). The engine tuning row (`hash_threads`, `recv_ring`,
  `zero_copy_send`, `disk_thread`, `max_open_files`, `max_checking`,
  `piece_extent_affinity`, `max_concurrent_announces`) is fixed per session. Persist it,
  apply it at the next start, and say so in the API ("applies after restart").
- Interface names are resolved by the daemon and passed as addresses (`listen_v4` /
  `listen_v6`). Port randomisation is picked by the daemon too (`docs/config.md`).
- Settings the reference lacks are ours too, for example the identity profile (`native` /
  `qbt_5_2_3_lt2_0_14`), DHT bootstrap nodes and engine tuning.

### 4.10 Authentication and security

The API controls the filesystem: save paths, directory listing, delete with files,
webhooks to any URL. Treat it as a security boundary. The daemon never runs a program
(ADR 0006: run-on-completion is a webhook).

- Auth is on by default. Offer both of the reference's schemes: cookie sessions after
  login, and API keys (`Authorization: Bearer`, rotate / delete). Passwords and keys are
  stored as hashes (argon2 for passwords, SHA-256 for API keys), never in plain text. With no password set,
  the first caller of `POST /auth/setup` chooses the credentials (`GET /auth/status` says
  whether setup is open; one caller wins, the claim is atomic; cross-origin refused;
  ADR 0007), and a temporary password is printed per run until then. Also provide a session timeout, bans
  after repeated login failures, an opt-in localhost bypass and an opt-in subnet
  whitelist.
- Cookie sessions can be used from browsers, so they get CSRF protection (`Origin` /
  `Referer`) and `Host` validation. Requests authenticated with an API key do not need
  them.
- Bound everything a request can make us allocate: body size, multipart parts, `.torrent`
  size, list lengths. No panics on request input (the lints in section 7 enforce
  `unwrap` / `expect` / `panic`).
- Paths from requests are untrusted even when authenticated. Content paths are sanitised
  by the library. The daemon validates its own (save and download paths, export
  directories): no NULs, and normalise before use.

### 4.11 Statistics ([ADR 0005](docs/adr/0005-statistics.md))

History the library does not keep, recorded by the daemon in `<data dir>/stats.db` (a
second SQLite file: large, written every minute, disposable; `synchronous = NORMAL`).

- **Counter differences only** (rule 1): the tick hands its `statuses()` and `stats()`
  to `Stats::observe` (under the registry lock, so a removal cannot slip in between),
  which adds the differences of the library's counters to in-memory buckets. Never a
  rate times a time, never interpolated. Restored torrents start from a baseline; torrents
  whose counters began at zero in this run count from zero. Maxima are sampled per tick.
- **Kept**: per-torrent minute and hour traffic (only when bytes moved), a row per torrent
  per UTC day it ran or moved data (the seeding history: bytes, running and seeding time,
  all-time counters, ratio, swarm size), session buckets, a timeline (added, metadata,
  finished, moved, error, removed, non-checking state changes) and recording periods.
- **Writes**: additive upserts, once a minute and before every query; idle days every 15
  minutes. Retention (settings) is applied hourly. Removed torrents keep their history.
- A `stats.db` that cannot be opened turns statistics off for the run (logged, `/stats`
  answers 503); it never stops the daemon.
- **By place** (0.6.0): user-supplied `.mmdb` files (`geo.rs`; country and ASN, never
  city; never downloaded; re-read when replaced). Every 10 s, before the snapshot, the
  tick samples the peers of torrents that moved data; `PeerDisconnected` brings final
  counters; connections are known by address and start time so nothing counts twice
  (`stats/peers.rs`). Per torrent, hour and day, by country and ASN; peer addresses stay
  in memory. `unattributed` (web seeds, missed closes, the seconds since the last
  sample) makes the rows add up to the torrents' traffic.
- **Breakdowns** (0.7.0): peer traffic also by client family, discovery source,
  transport, encryption, IP version and direction (`peer_traffic.dim`); torrents' traffic
  by category, tag and tracker host (recorded on the torrents table: membership as it is
  now; tracker hosts only, never URLs); announces per host; opt-in scrapes for completed
  downloads; the idle-seed report (upload in a window ÷ size).

### 4.12 Metadata previews and webhooks

- **Previews** (`daemon/preview.rs`, `/previews`): a magnet is added to the engine with
  `hold_after_metadata`, not auto-managed, outside the registry (no list, statistic,
  record or resume data); on `MetadataReceived` the daemon keeps `torrent_file(id)` and
  removes the engine torrent. `add_one` takes a preview of the same hash and adds its
  `.torrent`. In memory only; dropped after 15 minutes unread; 32 at most.
- **Webhooks** (`webhooks.rs`, `/webhooks`, ADR 0006): the lifecycle events that feed the
  timeline (`Daemon::lifecycle`) also go to the webhooks that want them, with the
  torrent's list row. Signed (HMAC-SHA256 over `<timestamp>.<body>`), no redirects,
  retried on no answer, 429 and 5xx. Never a program.

### 4.13 Scheduler and watch folders

- **Alternative-limits scheduler** (`alt_speed_schedule`, `AltSpeedSchedule::contains`):
  the tick compares the window with its last look and switches `alt_speed_enabled`
  through `update_settings` only at a boundary (or the first look), as qBittorrent does;
  a switch by hand holds until the next one. Local time via `jiff` (DST included).
- **Watch folders** (`watch_folders`, `daemon/watched.rs`): scanned on the tick (blocking
  I/O off the runtime); a file settled for 3 s is read, added through the add pipeline
  with the folder's options, then renamed `.added` (or deleted) or `.rejected`. These
  files are the daemon's input, not torrent content: rule 5 does not apply to them. A
  file whose rename fails is not taken again until it changes.

### 4.14 RSS and client data

- **RSS** (`src/rss/`, `/rss`): folders, feeds and articles live in `urtorrentd.db`
  (schema version 2); the newest `rss_max_articles` articles per feed are kept. The tick
  starts due refreshes (4 at once, `rss_fetch_delay` between requests to one host,
  conditional requests with ETag / Last-Modified); a refresh asked for runs with
  `rss_enabled` off too. Documents are parsed with `quick-xml` (RSS 2.0, Atom, enclosures,
  torznab / newznab attributes, `torrent:magnetURI`). Errors are logged without the URL
  (feed URLs carry passkeys).
- **Rules** (`rss/rules.rs`): qBittorrent's semantics from its documentation (wildcards or
  regular expressions, episode filters, the smart filter with repacks, ignore days), our
  own implementation (rule 7). New articles run through the rules when
  `rss_auto_download` is on, and a rule's feeds when it is saved; one rule per article;
  what a rule takes is added through the add pipeline with its `add_options`. Runs,
  saves and renames of rules are serialized (`rss_rules_lock`).
- **Client data** (`/client-data`): JSON values by key for client UIs, in `urtorrentd.db`;
  never read by the daemon; 4096 keys, 64 KiB a value.

## 5. Testing

1. **Unit.** Unit and state-flag derivation, the sync diff engine, request parsing, auth
   (sessions, bans, keys), persistence round-trips.
2. **Coverage check** (`tests/coverage.rs`). Fails if `docs/api.md` or `docs/settings.md`
   leaves any reference endpoint or preference key unmapped (rule 3). The reference lists
   are checked in (`docs/reference/`), extracted from the pinned build's source and API.
3. **In-process API tests** (`tests/api.rs`, `tests/torrents.rs`). The axum router, driven
   with `tower::ServiceExt`, runs against real `Session`s on loopback (`127.0.0.x`, DHT
   and LSD off, as `../urtorrent/crates/session/tests/daemon.rs` does). Two daemons
   transfer a real torrent, and every assertion goes through the API. **Every response
   is validated against the OpenAPI schema** (`tests/common`), and calling an
   undocumented endpoint fails the test. Previews fetch from a real peer
   (`tests/previews.rs`); webhooks are delivered to a local receiver that checks the
   signatures (`tests/webhooks.rs`); RSS reads a local feed server whose feed changes
   under it (`tests/rss.rs`); the scheduler and watch folders run on a real daemon
   (`tests/automation.rs`); search covers renames and removals (`tests/search.rs`);
   announces and web-seed requests leave from the listen address, before and after a
   live change (`tests/binding.rs`).
4. **Schema** (`tests/openapi.rs`, `cargo xtask sdk`). The committed `openapi.json` is
   current, every `$ref` resolves, operation ids are unique, errors are typed; a
   TypeScript client generated from it type-checks, and wrong calls do not.
5. **Lab scenarios** (`xtask it`, not built yet; urtorrent's `testkit` as a path dev-dependency for the
   netns lab, opentracker and the qBittorrent oracle as a peer). Drive `urtorrentd` over
   its API to leech from and seed to the oracle, and to stop, start, recheck, move and
   delete.
6. **Statistics** (`tests/stats.rs`, `tests/geo.rs`). A real transfer's minute, hour and
   day series add up to the library's counters; history outlives removal and restarts
   (restored counters are baselines, not new traffic); recording periods and switching
   recording off; a broken `stats.db` leaves the daemon running. GeoIP files in the
   layouts users have (written by `tests/common/mmdb.rs`, mapping loopback), peers
   located in the API, and traffic by place that adds up to the torrents' traffic.
   Breakdowns (`tests/breakdowns.rs`) against a local HTTP tracker that answers
   announces and scrapes.
7. **Restart and crash** (`tests/restart.rs`). Stop gracefully and restart in process:
   everything is back, including categories, tags, queue order, limits, magnets without
   metadata, and stopped torrents; removed torrents stay removed. The real binary is
   killed with `kill -9` and comes back with its torrents, then stops cleanly on SIGTERM
   and on `POST /app/shutdown`. No torrent may claim data it does not have (the library
   guarantees this, and the daemon must not undo it).

Every test runs offline (rule 4). Environment needs are the library's: io_uring, and for
the lab passwordless `sudo`, `opentracker` and the cached oracle (run
`cargo xtask doctor` in `../urtorrent`).

## 6. Milestones

Each milestone ends with its tests green. Status: **0.1.0 released (2026-09-23)** with D0 to
D4 done except the alternative-limits scheduler, which moved to the later list. **0.2.0**
moved persistence to SQLite and aligned with urtorrent 0.13 (error recovery, holding,
piece priorities, address ranges, list-view fields). The "planned" rows of `docs/api.md`
and `docs/settings.md` are the remaining work; `docs/gaps.md` has what is still open
upstream. **0.3.0** added the incomplete-file suffix and verified staging downloads that
move to their category's directory on completion. **0.4.0** pushes the sync diffs as
server-sent events (4.6). **0.5.0** records statistics (4.11) and aligns with urtorrent
0.13.2 (resume data saved when it changed, counters included). **0.6.0** locates peers
(GeoIP) and records traffic by country and network. **0.7.0** breaks traffic down by
peer client, source, transport, encryption, IP version and direction, and by category,
tag and tracker; it adds tracker reliability, opt-in scrapes and the idle-seed report.
**0.8.0** adds metadata previews and webhooks (run-on-completion as HTTP calls, ADR 0006).
**0.9.0** adds the alternative-limits scheduler and watch folders, tested with urtorrent
0.13.3. **0.10.0** adds RSS and the client data store. **0.11.0** does the remaining "planned"
rows: every item of the checklist is now done or unsupported with its reason. **0.12.0**
adds search: the list by name, category, tag, tracker host or info-hash prefix, and
file names across torrents; it requires urtorrent 0.13.4, which closed the last open gap
(HTTP trackers and web seeds leave from the listen address). **0.13.0** adds first-run
setup: the first client chooses the credentials (ADR 0007).

- **D0 Foundations.** Workspace, CI, `xtask check`, the reference lists
  (`docs/reference/`: endpoints and preference keys from the pinned build), the coverage
  docs and their check, and ADR 0001 on API conventions (4.3).
- **D1 Skeleton.** Config, `Session` lifecycle, signals and graceful shutdown, auth (login,
  logout, sessions, API keys, bans, CSRF / Host), app info, persistence and restart of
  torrents.
- **D2 Torrents.** Add (file, magnet, URL), listing and detail (properties, files,
  trackers, web seeds, piece states / hashes / availability, export), start, stop, force
  start, delete, recheck, reannounce, file priorities, limits, queue moves, location,
  renames, trackers, web seeds, peers, sequential.
- **D3 Sync.** Incremental sync for torrents and peers, transfer info and limits, logs,
  peer bans.
- **D4 Frontend policies.** Categories, tags, automatic torrent management, share limits,
  alternative limits, download path, stop conditions, content layout, auto-added trackers
  (never on private torrents), settings coverage. **Released as 0.1.0.**
- **Analytics** (4.11, the plan of 2026-09-23): 0.5.0 history and seeding days (done);
  0.6.0 geolocation (country and ASN on live peers and in history; done); 0.7.0 breakdowns,
  tracker reliability, idle-seed report, opt-in scrape for completed-download counts (done).
  Later: data-usage caps (needs wire-level counters upstream), Prometheus `/metrics`.
- **Web UI** (the plan of 2026-09-24): milestones W0 to W7 in `frontend/AGENTS.md`. W0
  changes the daemon too: `--initial-settings` (for offline end-to-end tests), serving the
  UI, and a CORS allowlist.
- **Not planned** (maintainer decision, 2026-09-24): e-mail notifications (webhooks
  notify) and HTTPS in the daemon (TLS belongs to a reverse proxy). What else the
  checklist marks unsupported stays so for the reasons given there.
- Anything that needs a library change lands in urtorrent first.

## 7. Working conventions

- Rust stable, edition 2024, the same `rust-toolchain.toml` pin as `../urtorrent`.
  Workspace lints as in the library: `unsafe_code = "forbid"`, `missing_docs = "deny"` on
  library code, clippy `unwrap_used` / `expect_used` / `panic` denied (tests excepted).
- Errors: one `ApiError` enum (`thiserror`) rendered as 4.3 says. `anyhow` only in `main`
  bootstrap and `xtask`.
- Logging via `tracing`, no `println!` (except the temporary-password line at startup).
  Daemon events go through `Logs::log`, which feeds `GET /log` and emits the same line
  through `tracing`.
- Dependencies: keep the tree small and justify every new one in the PR. In use: `axum`,
  `tokio`, `utoipa` + `utoipa-axum` (the schema), `serde`, `serde_json`, `thiserror`,
  `tracing`, `tracing-subscriber`, `clap`, `reqwest` on rustls (URL adds), `argon2` and
  `sha2` (credentials), `getrandom`, `base64`, `rustix` (free space, no `unsafe`),
  `rusqlite` with SQLite compiled in (persistence, ADR 0004), `futures-util` (the
  event stream; already in the tree through axum and tower), `maxminddb` (reading the
  user's GeoIP files; ISC), `hmac` (webhook signatures; RustCrypto, like `sha2`), `jiff`
  (local time and daylight saving for the alternative-limits schedule; the system's time
  zone database, with a bundled copy for containers without one), `quick-xml` (RSS and
  Atom documents), `regex` (RSS rules; already in the tree), `if-addrs` (network
  interfaces for `listen_interface`: `getifaddrs` without `unsafe` here).
  `cargo-deny` bans `openssl`, `openssl-sys` and `native-tls`, with the library's licence
  allow-list. It does **not** ban `mio` here (4.2).
- Commands (keep them working forever):
  - `cargo xtask check`: fmt, clippy `-D warnings`, all tests (unit, API on real
    engines, restart / `kill -9`, schema, coverage), docs, `cargo-deny`
  - `cargo xtask openapi`: regenerate `openapi.json`
  - `cargo xtask sdk`: generate TypeScript types from `openapi.json` and type-check
    `sdk/typescript/check.ts` (Node.js)
  - `cargo xtask it [scenario]`: lab scenarios against the oracle (not built yet, 5.4)
- Definition of done for any change: `xtask check` and `xtask sdk` green. `openapi.json`
  regenerated and committed. `docs/api.md` and `docs/settings.md` are current. A new
  library gap has a `docs/gaps.md` entry. Design-level decisions get an ADR.
- **Versioning.** SemVer, first release `0.1.0`, `CHANGELOG.md` in Keep-a-Changelog
  format, one line per user-visible change in the same PR. The API is versioned by its
  base path. A breaking change needs a new path version, or a `0.x` minor bump while
  pre-1.0. On-disk formats (daemon records, settings, categories) carry their own format
  version. Every release reads every format it ever wrote.
- **Licence: Apache-2.0** (`LICENSE`). Every source file starts with:
  ```
  // SPDX-License-Identifier: Apache-2.0
  // Copyright (c) 2026 urtorrentd contributors
  ```
  Logic ported from a permissive project keeps its notice in the file and an entry in
  `NOTICE`. Never copy from qBittorrent (GPL) or any other copyleft project (rule 7).
- **Terminology:** in urtorrent, a *profile* is a wire identity (`native`,
  `qbt_5_2_3_lt2_0_14`). In qBittorrent, `--profile` is the configuration directory. Here
  "profile" only ever means the identity; directories are the *data dir*.
- When something here is wrong or unclear, fix this file in the same PR.

## 8. Decisions and open questions

### Decided by the maintainer (2026-09-22)

- A daemon built on `urtorrent`, written in Rust, with its HTTP API on **axum**.
- The API offers every feature of qBittorrent's WebAPI that urtorrent supports.
  **qBittorrent is a feature checklist only:** no emulation of its responses or versions,
  and no compatibility with qBittorrent frontends or clients.
- **Licence: Apache-2.0.**
- **A typed API schema generated from the code**, so frontends get an SDK from a
  generator with end-to-end type safety (ADR 0003).
- **SQLite for all persistent state** (2026-09-23, ADR 0004), with resume data held by
  the daemon in the database.
- **Analytics** (2026-09-23, ADR 0005): history in a separate `stats.db`; retention
  minutes 48 h, hours 90 days, days forever; removed torrents keep their history;
  geolocation from a user-supplied `.mmdb` file, country and ASN only, peer addresses
  never stored.
- **Run-on-completion is a webhook** (2026-09-24, ADR 0006): the daemon calls URLs on
  torrent events and never runs a program.
- **No e-mail, no HTTPS in the daemon** (2026-09-24): webhooks notify; a reverse proxy
  terminates TLS.
- **First-run setup without a code** (2026-09-24, ADR 0007): while no password is stored,
  the first client of `POST /auth/setup` chooses the credentials.
- **A web UI in this repository, served by the daemon** (2026-09-24): `frontend/`, built
  with SolidJS, shadcn components (solid-ui), Tailwind, Lucide and Vite, and using nothing
  but the API. axum serves its files at `/` (embedded in release builds, or from
  `--web-ui <dir>`), and the API stays at `/api/v1`. A reverse proxy such as Caddy
  terminates TLS, and browser clients on other origins get an explicit CORS allowlist. End-to-end tests against
  real daemons are required. The plan and rules are in `frontend/AGENTS.md`; ADR 0008
  comes with the first code.

### Settled in ADRs (defaults taken while building; revisit with the maintainer if needed)

- **API style**: resource-oriented JSON under `/api/v1` (ADR 0001).
- **On-disk layout**: one data directory holding `urtorrentd.db` (ADR 0004) and
  `stats.db` (ADR 0005).

### Still open (defaults assumed; confirm with the maintainer in the PR that depends on it)

- **Identity profile.** Default: the library's default, `native`. The qbt profile is opt-in
  in the daemon config, for private trackers with client whitelists.
- **Scope beyond the library.** Torrent creation (`torrentcreator/*`): unsupported by
  default, even though the daemon could do it without the library. RSS and watch folders:
  planned after 0.1.0 (section 6).
- **Logs** go to stderr / journald and `GET /log`, not to files.
- **API listen address.** Default `127.0.0.1:8080` (loopback only); exposing it is a
  deliberate `--api-listen`.
