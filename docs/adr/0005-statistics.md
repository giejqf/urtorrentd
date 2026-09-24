# ADR 0005: Statistics in their own database

Status: accepted (2026-09-23, maintainer decisions from the analytics plan).
Amends ADR 0004: `urtorrentd.db` still holds all state; recorded history
lives next to it in `stats.db`.

## Context

The maintainer wants history: what each torrent seeded over time, its
traffic by time of day and by where peers are, and more analyses of that
kind. The library gives snapshots (`statuses()` with all-time counters,
`stats()`, `peers(id)`) and events; nothing in it keeps history, and it
should not (a frontend concern, `../urtorrent/docs/config.md`).

qBittorrent keeps no history either (its statistics window shows all-time
totals only), so there is no checklist entry to follow: the design is ours.

## Decision

- **A second SQLite file, `<data dir>/stats.db`.** History is large, written
  every minute and disposable. Apart from the state it cannot slow down or
  bloat the database that must survive, backups of the state stay small,
  and deleting `stats.db` loses history only. `synchronous = NORMAL` (WAL):
  a power cut may lose the last flush, never corrupt the file. If it cannot
  be opened (corrupt, newer schema), the daemon starts without statistics
  and says so in the log; `/stats` answers `503 unavailable`.
- **Counter differences only** (AGENTS.md rule 1). Every tick (2 s) adds the
  differences of the library's counters to in-memory buckets: never a rate
  times a time, never interpolated. A torrent restored with its resume data
  starts from a baseline; one whose counters began at zero in this run
  (added now, or restored without resume data) counts from zero. A counter
  that goes back (a re-add) restarts its baseline. Maxima (peers, seeds,
  connections) are sampled at those ticks.
- **What is kept:**
  - per torrent, minute and hour buckets of bytes down and up with the most
    peers and seeds seen, written only when bytes moved;
  - per torrent, one row per UTC day it ran or moved data: bytes, seconds
    running and seeding, the all-time counters and ratio at the day's last
    observation, the most swarm seeders and leechers the trackers reported.
    This is the seeding history, and it covers idle seeds too;
  - session-wide minute, hour and day buckets (bytes, peers, connections,
    DHT nodes, torrents);
  - a timeline per torrent: added, metadata, finished, moved, error,
    removed, and state changes (checking states excluded: a check at every
    start would flood it);
  - recording periods (daemon start to stop, or recording switched on and
    off), so a client can tell "nothing moved" from "nothing was recorded".
    An abrupt stop leaves the period ended at its last write.
- **Writes**: additive upserts, one transaction a minute and before every
  query (so the API is current to the last tick). Days in which only
  running time accumulated are written every 15 minutes: a seedbox has
  thousands of idle seeds. All steps are written in parallel, not rolled up,
  so each is complete within its retention.
- **Retention** (settings, seconds, `null` = forever): minutes 48 h, hours
  90 days, days, timeline and periods forever. Applied hourly. A removed
  torrent keeps its history, with its name and removal time, until that
  expires or `DELETE /stats/torrents/{hash}` purges it.
- **API** under `/stats` (typed like the rest, ADR 0003): series take
  `from`, `to` (bucket starts, inclusive) and `step`; without `step` the
  finest step kept for the whole range is used, capped at 10 000 buckets.
  Charts, and heatmaps binned in the viewer's time zone, are client work:
  the daemon has no time-zone database and no UI (non-goal).
- **Geolocation (0.6.0)**: `.mmdb` files the user provides (GeoLite2 or
  DB-IP Lite country and ASN databases, or IPinfo Lite with both), read into
  memory and re-read when the file changes; the daemon never downloads one.
  Fields are read by path as whatever type the file stores (the layouts
  differ); countries and ASNs only, never cities. Peers in the API carry
  their place.
- **Traffic by place (0.6.0)**: per-connection counters are differenced like
  a torrent's. Every 10 s, before the torrents' snapshot (so peer traffic
  never runs ahead of the traffic it is part of), the tick samples the peers
  of the torrents that moved data; `Event::PeerDisconnected` brings a
  connection's final counters. A connection is known by its address and
  start time (observation time minus `connected_for`), so a sample taken
  before a close but handled after it, or one of an earlier connection from
  the same address, is not counted twice; connections older than the
  recording period are baselines. Bytes are grouped per torrent, per hour
  and per day, by country and by ASN (`peer_traffic`, keys `""` = not
  located), with the distinct addresses per torrent and bucket (within a
  run). Peer addresses stay in memory and are never written. What cannot be
  tied to a peer (web seeds, a close missed in `Lagged`, the seconds since
  the last sample) is reported as `unattributed` = the torrents' traffic
  minus the peer traffic over the same range, so the rows add up.
- **Breakdowns (0.7.0)**: the per-peer accounting is also keyed by the
  client (the name without its version: `qBittorrent/4.6.2` and
  `qBittorrent 4.6.2` are one row; peers send anything here, so the name is
  bounded and printable), the discovery source, transport, encryption, IP
  version and direction. The torrents table records each torrent's
  category, tags and the host of the tracker it last worked with; traffic
  by group is by that membership, so a torrent's history moves with it.
  Only tracker hosts are stored, never URLs (passkeys). Announces answered
  and failed are counted per host from `TrackerReply` / `TrackerError`.
  Opt-in scrapes (`stats_scrape_interval`) add the swarm's completed
  downloads to the days (`ScrapeReply`).

## Consequences

- One more file in the data directory, and at most one small write
  transaction a minute (plus the idle-day batch every 15 minutes).
- After `kill -9`, statistics lose at most the last minute (15 for idle
  days' time); the torrent counters roll back to their last resume save (at
  most a minute old since 0.5.0), so a day's `uploaded` can exceed what the
  all-time counter gained by that much. Both are observations; neither is
  edited to match the other.
- A tick that sees no torrent change writes session buckets only.
- Sampling peers is one `peers(id)` call per torrent that moved data, every
  10 s: background work bounded by the active torrents, not a list
  endpoint (AGENTS.md 4.4). A call for many torrents at once is the
  upstream request if it ever shows in a profile (`docs/gaps.md`).
- The database's licence is the user's to honour: DB-IP Lite (CC BY 4.0)
  asks for credit where the data is shown, GeoLite2 has its own EULA.
  `GET /app` reports the `database_type` so a client can show it.
