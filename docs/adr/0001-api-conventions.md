# ADR 0001: API conventions

Status: accepted (2026-09-22)

## Context

qBittorrent's WebAPI is the feature checklist (AGENTS.md section 2), not a
compatibility target. Its shape has accidents we do not want to repeat:
form-encoded requests, plain-text and JSON responses mixed, KiB/s in one
place and bytes/s in another, `-1`, `0` and `8640000` as sentinels,
`|`-separated hash lists, and unknown hashes silently ignored. Clients should
get a typed SDK from the schema (ADR 0003).

## Decision

- **Base path** `/api/v1`, grouped by feature like the reference's scopes
  (`auth`, `app`, `settings`, `torrents`, `torrents/{hash}`, `categories`,
  `tags`, `transfer`, `sync`, `log`) so the checklist maps cleanly
  (`docs/api.md`).
- **JSON both ways.** A `.torrent` travels base64 inside JSON; the export
  endpoint returns `application/x-bittorrent`.
- **One unit per kind of value:** bytes, bytes per second, seconds, unix
  seconds. **`null`** is unknown or unlimited. Optional response fields are
  still always present (`required` + nullable in the schema).
- **Info-hashes** (lowercase hex, v1) address torrents; `TorrentId` never
  leaves the process.
- **Bulk actions** are `POST /torrents/<action>` with `{"hashes": [...] |
  "all"}` and answer `BulkResult` (`applied`, `not_found`, `failed` with an
  error per torrent). Invalid hex is a 400; unknown hashes are reported, not
  dropped. Per-torrent resources live under `/torrents/{hash}` and answer 404
  for an unknown hash.
- **Partial updates** (`PATCH /settings`, `PATCH /torrents/{hash}`,
  `/torrents/limits`) change only the fields present; `null` means "remove
  the limit / restore the default" where the field allows it. Unknown fields
  are a 400.
- **Errors**: the HTTP status plus `{"error": {"code", "message"}}`, with
  `code` from the `ErrorCode` enum. Library errors map deliberately
  (`NoSuchTorrent` 404, `InvalidArgument` 400, `Busy` / `Duplicate` 409,
  `Shutdown` 503). Rejected JSON, query and path input use the same shape.
- **Long operations** (recheck, storage moves) start and return; progress
  shows in the torrent's `state` (`checking`, `moving`).
- **Incremental sync** (`GET /sync?rev=`): the full state first, then the
  torrents and categories that changed (whole objects), removal lists, the
  tag list when it changed, and the transfer state every time. Snapshots are
  shared by all clients (built at most every 500 ms, the last 16 kept); no
  per-client state. Server-sent events may come later on top.
- **Authentication**: cookie sessions (`urtorrentd_sid`, HttpOnly,
  SameSite=Strict) and a bearer API key; CSRF (`Origin` / `Referer`) checks
  for cookie sessions; `Host` checks against DNS rebinding (IP literals always
  pass). Bans after repeated login failures.
- **Operation ids** are the handler names and unique (`list_torrents`,
  `get_torrent`, ...): they become SDK method names.

## Consequences

Clients written against qBittorrent do not work unchanged (by design). The
checklist in `docs/api.md` records where every reference feature lives here.
