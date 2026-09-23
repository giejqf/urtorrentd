# What the daemon needs from urtorrent

Things the daemon wants from the library (the `urtorrent` facade, 0.13.1)
that it does not offer or does not do right, with what the daemon does in
the meantime (AGENTS.md rule 5: record, raise upstream, do not hack around).

## Open

### Smaller wishes

| Wish | Workaround here | Affects |
|---|---|---|
| Tracker URLs in `statuses()` rows (the list has `working_tracker` and `trackers_count` but not the URLs) | a per-torrent cache of the URLs, refreshed from `trackers(id)` only when the list is edited or the metadata arrives | the trackers in list rows' `magnet_uri` |

## Resolved upstream

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

## Still unsupported (by choice, not blocked)

| Item | Why |
|---|---|
| Suffix for incomplete files (`incomplete_files_ext`) | not in the library; ask when wanted |
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
