# What the daemon needs from urtorrent

Things the daemon wants from the library (the `urtorrent` facade, 0.14.0)
that it does not offer or does not do right, with what the daemon does in
the meantime (AGENTS.md rule 5: record, raise upstream, do not hack around).

## Open

Nothing open.

## Resolved upstream

- 0.14.0: `Event::TrackerReply` carries the `interval` the tracker asked
  for, its `min_interval` and the announce's `response_time`: each host in
  `GET /torrents/trackers` has the median interval and response time of
  its trackers' latest replies, and the web UI's Stats › Trackers shows
  slow hosts and the intervals asked for.
  `Session::force_reannounce_tracker` announces to one tracker alone:
  `POST /torrents/{hash}/trackers/reannounce` (the Trackers tab's
  Reannounce on each tracker) and `POST /torrents/trackers/reannounce` by
  host (Stats › Trackers). `TorrentStatus::pieces_checked` says how far a
  check has got: list rows carry it, and the UI shows the percentage while
  a torrent is checking.
- 0.13.5: `TorrentStatus::slow`, the queue's slow torrent (60 s below
  2 KiB/s both ways, holding no slot unless `count_slow`): list rows carry
  it as `slow`, and the web UI's queue picture uses it instead of reading
  the rates. `Session::set_queue_position` puts a torrent at a place in one
  call and re-plans once: `PUT /torrents/{hash}/queue-position`, and the
  UI's queue list is reordered by dragging (maintainer decision,
  2026-09-25) instead of ↑ / ↓ buttons.
- 0.13.4: HTTP(S) tracker announces and web-seed downloads leave from the
  listen address of their family and fail when it is gone (no fallback to
  the default route), and peer dials follow `set_listen`: `listen_interface`
  on a VPN interface now keeps everything on it. `tests/binding.rs` checks
  the source address of announces and web-seed requests, before and after a
  live `listen_v4` change.
- 0.13.2: `needs_resume_save` is set by every change the resume data records
  (trackers, per-torrent settings, the queue flag, queue moves on every
  torrent they shift). The daemon's shutdown saves only the torrents that
  changed instead of all of them. Transfer counters and activity times still
  do not set the flag (by design, documented on the field), so the daemon
  also saves a torrent whose counters moved, at most once a minute
  (`ResumeSave::Due`): a seed's upload survives `kill -9` too.
- 0.13.1: after a hold, `add_peer` waited out the 60 s reconnect backoff for
  the peer the metadata came from (it dials at once now, as after a pause);
  `tests/torrents.rs` (`magnets_are_held_for_stop_conditions_and_layouts`)
  expects the download within 30 s again.
- 0.12.0: errored torrents recover (`resume`, `force_resume`,
  `force_recheck`) and carry an `ErrorKind`; the daemon's `409` refusal is
  gone and `error_kind` is in the API.
- 0.12.0: holding a torrent once its metadata is known
  (`hold_after_metadata`, `TorrentState::Held`, `release`): magnet stop
  conditions and content layout without races.
- 0.12.0: list-view status fields (`working_tracker`, `trackers_count`,
  `swarm_seeders` / `swarm_leechers`, distributed copies, `sequential`,
  `last_seen_complete`, `last_download` / `last_upload`), `PeerBanned`,
  `urtorrent::VERSION`; `remove_torrent` deletes its resume file. The
  daemon's tracker-summary and availability caches and its mirrored
  `sequential` flag and activity times are gone.
- 0.13.0: piece priorities (first and last piece first is supported now),
  banned address ranges (`banned_ip_ranges` setting), per-endpoint tracker
  rows and `updating` (in `GET /torrents/{hash}/trackers`), `FileCompleted`.
- 0.11.4: `rustls-pemfile` replaced (RUSTSEC-2025-0134).

## Considered, not needed

- **Peers of many torrents in one call**, for the statistics by place and
  the peers across torrents (`GET /transfer/peers`). The daemon calls
  `peers(id)` every 10 s for each torrent moving data (idle torrents cost
  nothing) and serves the list from that sample, so a request costs no
  engine call. Background work bounded by the active torrents, not a list
  endpoint; ask if it shows in a profile, or if the list should also hold
  the connections of idle torrents.

- **Tracker URLs in `statuses()` rows**, for the trackers in list rows'
  `magnet_uri`. The daemon caches each torrent's URLs, filled once from
  `trackers(id)` on the first list after a start and refreshed only when the
  list is edited or a magnet's metadata arrives. Carrying the URLs in every
  `statuses()` row would copy every torrent's tracker list on every snapshot
  (the tick every 2 s, sync up to twice a second, every list request): more
  work than the one-time fill it saves. If the fill after a start ever
  matters, a call returning the trackers of many torrents at once is the
  better request.

## Still unsupported (by choice, not blocked)

| Item | Why |
|---|---|
| SSRF guard for tracker and web seed URLs (`ssrf_mitigation`) | not in the library; ask when wanted |
| IP filter files | file formats are a non-goal; ranges are supported (`banned_ip_ranges`) |

## Behaviour worth knowing (not gaps)

- A magnet held when its metadata arrives stops the way qBittorrent's "stop
  condition: metadata received" does: trackers hear `stopped`, peers are
  dropped (urtorrent docs/quirks.md Q29). The daemon holds a magnet only when
  it has to: a stop condition or a content layout.
- `Session::resume` hands a torrent back to the queue (`auto_managed =
  true`); a held torrent that was added forced is started with
  `force_resume` instead.
