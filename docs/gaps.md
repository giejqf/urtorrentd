# What the daemon needs from urtorrent

Things the daemon wants from the library (the `urtorrent` facade, 0.13.1)
that it does not offer or does not do right, with what the daemon does in
the meantime (AGENTS.md rule 5: record, raise upstream, do not hack around).

## Open

### `needs_resume_save` misses changes the resume data records (0.13.1)

A caller that stores the resume data itself (`Session::resume_data`, what
the daemon does since 0.2.0, ADR 0004) learns what changed only through
`TorrentStatus::needs_resume_save`. These operations change what the resume
data holds but leave the flag unset (probed against 0.13.1; `add_web_seed`,
which sets it, as the reference):

| Operation | Recorded in the resume data as |
|---|---|
| `add_tracker`, `remove_tracker` | the tracker list (format 6) |
| `set_sequential`, `set_torrent_rate_limits`, `set_max_peers`, `set_max_uploads` | per-torrent settings (format 5) |
| `pause`, `resume`, `force_resume`, `set_auto_managed` | `auto_managed` (format 4) |
| `move_in_queue` | `queue_position` of the moved torrent **and of every torrent it shifts** (format 4) |

In the engine's own file mode the gap hides behind the save every torrent
gets when it stops. With caller-held data, a `kill -9` loses these changes,
and for a torrent where nothing else ever marks the data (an idle seed) they
never reach the database at all until a clean shutdown.

Wanted: set `needs_resume_save` for each of them (for a queue move, on every
torrent whose position changed), as libtorrent's `need_save_resume_data`
does.

Workaround here: at shutdown the daemon saves the resume data of every
torrent, not only the marked ones (`ResumeSave::All`). Once fixed, shutdown
saves only the marked ones (O(changed) instead of O(all)) and a crash loses
at most the last minute of these edits.

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

## Considered, not needed

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
