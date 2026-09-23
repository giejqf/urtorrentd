# ADR 0002: Persistence

Status: superseded by [ADR 0004](0004-sqlite.md) (2026-09-23) for the storage layout and resume data; the ordering and crash-safety rules below still hold.

## Context

The daemon must restart from its data directory after a clean stop or a
`kill -9`, never claiming data it does not have (urtorrent's rule 1). The
library offers two ways to keep resume data: engine-managed files
(`AddTorrent::resume_dir`) or caller-held blobs (`Session::resume_data` /
`AddTorrent::resume_data`, polled through `needs_resume_save`).

## Decision

- **Engine-managed resume files** in `<data>/resume/`. The engine writes them
  atomically while torrents change, on `save_resume_data` and at shutdown,
  and only after the content is `fsync`ed. The daemon never reads them.
- **Daemon records** in `<data>/torrents/<hash>.json` next to the metainfo
  `<hash>.torrent` (written when added, or when a magnet's metadata arrives;
  until then the record holds the magnet link). Records carry what resume
  data does not: save and download path, stopped, category, tags, name and
  comment overrides, automatic management, share limits, source URL, queue
  position, activity times, a pending stop condition.
- **Global state** in `settings.json`, `auth.json` (hashes only),
  `categories.json`, `tags.json`, `totals.json`, `dht.state`.
- **Every write is atomic**: temporary file, `fsync`, rename, directory
  `fsync`. Record writes are serialized so the newest always lands last.
- **Order.** Add: record and metainfo first, then the engine add (a crash in
  between re-adds the torrent on restart). Remove: engine first, then the
  daemon's files, including the resume file a plain removal leaves behind. A
  fresh add of an info-hash deletes any stale resume file first.
- **Restart**: settings → engine (with the DHT state) → every record re-added
  in its saved queue order, stopped ones paused → background tasks → API.
  **Shutdown**: queue positions into the records → records and totals → DHT
  state → engine shutdown (trackers hear `stopped`, resume data flushed).

## Consequences

The data directory is self-contained and can be backed up while stopped.
Queue order saved at shutdown survives a restart; after a `kill -9` the order
is the last one saved (records are flushed every minute).
