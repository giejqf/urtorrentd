# ADR 0004: One SQLite database for all persistent state

Status: accepted (2026-09-23, maintainer decision). Supersedes ADR 0002's
file layout and its engine-managed resume files; its ordering and crash-safety
rules still hold. Amended by ADR 0005: recorded history (statistics) lives in
a second file, `stats.db`.

## Context

0.1.0 kept every piece of state in its own file: JSON for settings,
credentials, categories, tags and totals, one record and one `.torrent` per
torrent, and the engine's resume files (ADR 0002). That cost two `fsync`s
per file written: every record was rewritten every minute (for activity
times and queue order), a bulk action wrote one file per torrent, and no
change spanning several torrents was atomic. A library of 10 000 torrents is
some 30 000 files.

urtorrent 0.12 keeps the activity times (and, since 0.7, the queue position)
in its resume data and offers the resume data as bytes the caller stores
(`Session::resume_data`, `TorrentStatus::needs_resume_save`,
`AddTorrent::resume_data`), with the same guarantee as its own files: the
content is synced before the data is returned.

## Decision

- **One database**, `<data dir>/urtorrentd.db`, SQLite through rusqlite with
  SQLite compiled in (`bundled`). WAL journal, `synchronous = FULL`.
- **Schema** (version in `PRAGMA user_version`, migrated on open):
  - `state (key, value)`: settings, credentials (hashes only), totals as
    JSON; the DHT state as the library's bytes.
  - `categories (name, save_path, download_path)`, `tags (name)`.
  - `torrents (hash, record, metainfo, resume, added)`: the daemon's record
    as JSON (serde defaults make new fields cheap), the `.torrent`, the
    library's resume data (opaque; never parsed here), insertion order.
- **Resume data is caller-held.** The daemon saves a torrent's resume data
  when the library says it changed, at most once a minute (the engine's own
  cadence in file mode), at once after a check and when a download finishes,
  and for every torrent at shutdown (a queue move changes other torrents'
  positions without marking them). On restart it is passed back with
  `AddTorrent::resume_data`.
- **One transaction per change set.** Records are marked dirty in memory and
  written together: a bulk action over thousands of torrents is one commit;
  the tick writes whatever an event or policy changed within 2 s.
- **Order** (unchanged from ADR 0002): a torrent's row is inserted before the
  engine add and deleted after the engine removal; updates never re-create a
  deleted row.
- **Importing 0.1.0.** A data directory without a database but with 0.1.0's
  files is imported in one transaction on first open (records, `.torrent`
  files, resume files as opaque bytes, settings, credentials, categories,
  tags, totals, DHT state); the old files move to `imported-0.1/`.

## Consequences

- Backups are one file (`sqlite3 urtorrentd.db ".backup copy.db"` works while
  the daemon runs); `sqlite3` inspects it.
- SQLite is C code compiled into the binary (no system library needed); the
  TLS stack stays pure Rust.
- After `kill -9` the last minute of resume data may be missing: the
  library then starts from the older data, which never claims more than is on
  disk (it may download a piece again), exactly as with its own files.
- Planned features with structured state (RSS feeds and rules, watch
  folders, client data) get tables in the same database.
