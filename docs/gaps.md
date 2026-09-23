# What the daemon needs from urtorrent

Things the daemon wants that the library (the `urtorrent` facade, 0.11.4)
does not offer, with what the daemon does in the meantime (AGENTS.md rule 5:
record, raise upstream, do not hack around). Ordered by what they block.

## Needed before the planned items

### 1. An errored torrent cannot be recovered

`TorrentState::Error` is terminal: `Session::resume` and `force_resume`
return early when the torrent has an error (`torrent::resume`, `if !t.paused
|| t.error.is_some()`), and `Session::force_recheck` returns `Ok(())` without
checking anything (`torrent::recheck` returns early on an error, the command
replies `Ok` regardless). The only way out is removing and re-adding the
torrent. A disk that filled up or a drive that was unmounted leaves torrents
dead until then.

Wanted: `force_recheck` (and `resume` / `force_resume`) clear the error and
retry, the way a user expects "recheck" and "start" to recover; and an error
*kind* next to the text (`TorrentStatus::error`), at least "content missing"
versus "I/O error" versus "bad metadata", so a missing-files state can be
shown and handled (recheck once the files are back).

Workaround here: `start`, `force-start` and `recheck` refuse an errored
torrent with `409 conflict` instead of reporting a success that did nothing.

### 2. Holding a magnet torrent once its metadata arrives

When a magnet's metadata arrives the engine creates the files, checks and
starts requesting pieces in one go (`torrent::on_metadata`, then
`initial_check` → `finish_check`), and emits `MetadataReceived` on the way.
Anything the daemon does in reaction lands after files exist and requests
may be in flight. That makes these racy or impossible for magnets:

- the stop conditions (`metadata_received`, `files_checked`): some payload
  may be downloaded, and trackers see `started` then `stopped`;
- the content layout (renames after files were created);
- excluding files by name, and file priorities chosen after seeing the file
  list (`AddTorrent::file_priorities` needs the file count up front);
- a metadata preview (`fetchMetadata` / `saveMetadata` in the checklist):
  fetch the info dictionary, show the files, let the user pick options, then
  add or discard.

Wanted, one of:

- `AddTorrent::hold_after_metadata(true)` + `Session::release(id)`: once the
  metadata is installed the torrent waits: no files created, no check, no
  piece requests, peers kept; `files()`, `set_file_priorities`,
  `rename_file`, `move_storage`, `pause` and `remove_torrent` work while it
  waits; `release` continues (create files, check, start, or stay paused).
  A preview is then "add held, read `torrent_file`, release or remove".
- or libtorrent's `stop_when_ready` for the stop conditions plus a separate
  metadata-only fetch (`Session::fetch_metadata(magnet) -> Vec<u8>`) for the
  preview. This covers less (no layout or exclusions before files exist).

For `.torrent` files no library change is needed: a torrent added paused
still runs its initial check and stays stopped, so the daemon implements
`files_checked` that way, race-free.

## Worth having (performance and fidelity)

| Gap | Workaround here | Affects |
|---|---|---|
| `statuses()` carries no tracker summary (working tracker, tracker count, max scrape seeds / leechers, URLs) | a per-torrent cache refreshed from `trackers(id)` after tracker events and edits: one call per torrent at start and after each announce | list rows: `tracker`, `trackers_count`, `swarm_seeds`, `swarm_leechers`, `magnet_uri` trackers |
| No distributed copies in any status | computed from `pieces(id)`, cached 10 s, at most 32 torrents per list request, 0 without peers | `availability` |
| No event when the engine bans a peer on its own (hash failures) | the peer log shows only bans made through the API or settings | `GET /log/peers` |
| `TorrentStatus` has no `sequential` flag | the daemon mirrors it in its record | `sequential` |
| No "last seen complete" / "last activity" times | derived from snapshots, persisted in the record | `seen_complete`, `last_activity` are approximate |
| The facade exports no version constant | read from the `native` profile's user agent (`urtorrent/<version>`) | `GET /app` `library` |
| Plain `remove_torrent` leaves `<hash>.resume` behind (the engine writes a final one while stopping) | the daemon deletes it after every removal and before a fresh add | none |

## Only if these features are wanted (unsupported today)

| Gap | Checklist items |
|---|---|
| No piece priorities | first / last piece first (`toggleFirstLastPiecePrio`, `firstLastPiecePrio`) |
| No suffix for incomplete files | `incomplete_files_ext` |
| No per-listen-socket tracker detail, no "announce in progress" flag | tracker endpoint rows, an `updating` status |
| No SSRF guard for tracker and web seed URLs | `ssrf_mitigation` |
| No IP ranges in the ban list | IP filter ranges (file formats stay a non-goal) |

## Resolved

- 0.11.4: `rustls-pemfile` (unmaintained, RUSTSEC-2025-0134) replaced by
  `rustls-pki-types`' PEM parsing; the advisory ignore is gone from
  `deny.toml`.

## Behaviour worth knowing (not gaps)

- `Session::resume` hands a torrent back to the queue (`auto_managed =
  true`); a torrent added paused (for content-layout renames) and meant to be
  force-started is started with `force_resume` instead.
