# The HTTP API

The machine-readable reference is [`openapi.json`](../openapi.json) (OpenAPI
3.1), generated from the handlers and types and served at
`GET /api/v1/openapi.json`. This page is the human overview, and the map from
qBittorrent's WebAPI (the feature checklist, AGENTS.md section 2) onto this
API.

## Conventions ([ADR 0001](adr/0001-api-conventions.md))

- Everything is under `/api/v1`. Bodies are JSON both ways; the one binary
  payload is a `.torrent`, sent base64 inside JSON and returned as
  `application/x-bittorrent` by the export endpoint.
- Units: bytes, bytes per second, seconds, unix seconds. `null` means unknown
  or unlimited; there are no magic numbers.
- Torrents are addressed by their lowercase hex v1 info-hash. Bulk actions
  take `{"hashes": [...]}` or `{"hashes": "all"}` and answer with
  `BulkResult` (`applied`, `not_found`, `failed`), so one bad hash never hides
  the others.
- Errors: an HTTP status and `{"error": {"code": ..., "message": ...}}`;
  clients branch on `code` (`ErrorCode` in the schema), never on the message.
- Authentication: a login session (`POST /auth/login` sets the
  `urtorrentd_sid` cookie) or an API key (`Authorization: Bearer <key>`).
  Loopback clients and whitelisted address blocks can be exempted in the
  settings. `POST /auth/login`, `GET /auth/status`, `POST /auth/setup` and
  `GET /openapi.json` are public.
- First run ([ADR 0007](adr/0007-first-run-setup.md)): while no password is
  set, `GET /auth/status` answers `{"setup_required": true}` and the first
  `POST /auth/setup` with `{"username": "me", "password": "..."}` (8
  characters or more) stores them and logs that client in (`204`, session
  cookie); later calls get `409 conflict`. Until then the temporary password
  printed at start works too.

## Typed clients

`openapi.json` is committed and kept current by a test (`cargo xtask openapi`
regenerates it). Every response in the integration tests is validated against
it, so the schema is what the API sends. Any OpenAPI 3.1 generator works; the
repository checks one path end to end (`cargo xtask sdk`, in
[`sdk/typescript`](../sdk/typescript)):

```sh
npx openapi-typescript openapi.json -o schema.d.ts   # types
# then, with openapi-fetch:
#   const api = createClient<paths>({ baseUrl });
#   const { data } = await api.GET("/api/v1/torrents", { params: { query: { filter: "seeding" } } });
```

`operationId`s (SDK method names) are unique and stable: they are the
handler names (`list_torrents`, `add_torrents`, `get_torrent`, ...).

## Live updates

`GET /api/v1/events` is a server-sent event stream (`text/event-stream`) of
the same updates `GET /sync` returns. Every event is named `sync`, its `id`
is the revision, and its `data` is a `SyncResponse`: the first one is
everything (or, with `?rev=N` or a `Last-Event-ID` header, the changes since
that revision), the next ones only what changed, at most once a second and
only when something did. Nothing is queued for a slow client: it gets the
latest changes, never a backlog. An idle stream sends a comment every 15 s.
Streams end when the daemon shuts down.

```ts
const events = new EventSource("/api/v1/events", { withCredentials: true });
events.addEventListener("sync", (e) => {
  const update: components["schemas"]["SyncResponse"] = JSON.parse(e.data);
  // update.full: replace the state; otherwise apply torrents, *_removed, tags, transfer
});
```

`EventSource` reconnects on its own and sends the last id back, so a client
resumes where it left off (or gets everything, if that revision is too old).
Browsers cannot set headers on `EventSource`: use the login cookie; other
clients can send the API key. Polling `GET /sync` stays for scripts.

## Metadata preview

qBittorrent's `fetchMetadata` / `saveMetadata`: see what a magnet link holds
before adding it.

```sh
POST /api/v1/previews {"source": "magnet:?xt=urn:btih:<hash>&dn=..."}   # or an info-hash, or a .torrent URL
GET  /api/v1/previews/<hash>
{"hash": "...", "state": "fetching", "peers": 3, "metadata": null, ...}
{"hash": "...", "state": "ready", "name": "album", "metadata": {"files": [{"path": "album/01.flac", "size": 90000}, ...], ...}}
GET  /api/v1/previews/<hash>/torrent-file      # the .torrent
POST /api/v1/torrents {"urls": ["<hash>"], "options": {...}}   # adds it with the fetched metadata
```

A preview is not a torrent of the session: it is in no list, statistic or
file, and a restart forgets it. A magnet is fetched from its trackers,
`x.pe` peers and the DHT, outside the queue; once the metadata is here the
engine lets go of it and the daemon keeps the `.torrent`. Adding the same
info-hash (magnet or hash) uses that `.torrent`, so the files are known at
once. A preview nobody reads for 15 minutes is dropped; 32 at most at once.
The `add_trackers` setting is not applied to previews.

## RSS

Feeds live in folders (`tv/anime`); each keeps its newest `rss_max_articles`
articles. With `rss_enabled` the daemon refreshes every feed at its interval
(`refresh_interval`, else `rss_refresh_interval`); `POST
/rss/feeds/{id}/refresh` refreshes one now either way.

```sh
POST /api/v1/rss/feeds {"url": "https://indexer.example/rss?passkey=...", "folder": "tv", "name": "Indexer"}
GET  /api/v1/rss/feeds/1          # the feed and its articles: title, date, torrent_url, size, read, downloaded
PUT  /api/v1/rss/rules/Show%201080p {"must_contain": "show 1080p", "must_not_contain": "cam",
     "episode_filter": "2x1-;", "smart_filter": true, "feeds": [1], "add_options": {"category": "tv"}}
GET  /api/v1/rss/rules/Show%201080p/matches    # what it would take now
```

A rule takes an article when its title passes:

- `must_contain`: words that must all appear, any order, case ignored; `*`
  is any text, `?` any character, `|` separates alternatives (`show 1080p |
  show 2160p`). With `use_regex` it is a regular expression. Empty takes all.
- `must_not_contain`: the same, and no match allowed.
- `episode_filter`: `1x2;1x8-15;2x1-;` is season 1 episode 2, episodes 8 to
  15, and season 2 on from episode 1 (every later season too); an item
  without a season keeps the previous one's. Titles are read as `S01E02`,
  `S01E02-E03` or `1x02`.
- `smart_filter`: each episode once (`S01E02`, `1x02`, or a date for daily
  shows); with `rss_download_repacks` a REPACK or PROPER once more. The
  episodes taken are in `matched_episodes`.
- `ignore_days`: after taking something, nothing for that many days.

With `rss_auto_download`, new articles of a rule's `feeds` go through the
rules (one rule per article), and saving a rule runs it over its feeds'
articles. What a rule takes is added with its `add_options`, marked
`downloaded` and read. Errors of a feed are in its `error` and the log,
without the URL (a feed URL can carry a passkey).

## Search

Both searches take `search`: words that must all match (case ignored, `*`
any text, `?` one character, everything else literal).

- `GET /torrents?search=ubuntu%20iso` filters the list. A word matches the
  name (a display-name override if set), the category, a tag or the host of
  any of its trackers (working or not); a word of 6 or more hex digits also
  matches the start of the info-hash. It combines with `filter`, `category`,
  `tag` and the rest, then `sort` and paging apply.
- `GET /torrents/files?search=s01e0?%20mkv` searches file paths (with their
  torrent's folder) across every torrent, or one (`hash`). Torrents come by
  name, files in their order; `total` counts every match, `limit` (1 to
  1000, default 100) and `offset` page through them:

```json
{"total": 2, "files": [
  {"hash": "5a8e…", "torrent": "Show.S01.1080p", "index": 0,
   "path": "Show.S01.1080p/Show.S01E01.mkv", "size": 1468006400,
   "progress": 1.0, "priority": 4}
]}
```

`index` is the file's index in `GET /torrents/{hash}/files` (for priorities
and renames). The daemon keeps every torrent's file paths in memory,
refreshed on renames, content layouts, the incomplete-file suffix and
metadata arriving, so a search asks the engine only for the page it
returns. A magnet has no files until its metadata arrives. At most 16
words, 512 bytes; more is a 400.

## Client data

`/client-data` keeps JSON values by key for client UIs (their preferences,
column layouts): `PATCH {"ui.theme": "dark", "old.key": null}` stores and
removes, `GET ?keys=ui.theme,ui.columns` reads (all keys without `keys`).
The daemon never reads them. 4096 keys, 256 a request, 64 KiB a value.

## Webhooks ([ADR 0006](adr/0006-webhooks.md))

qBittorrent runs a program when a torrent is added or finishes; urtorrentd
calls a URL instead (it never runs a program):

```sh
POST /api/v1/webhooks {"url": "https://media.lan/hooks/torrents", "events": ["finished", "moved"], "secret": "..."}
POST /api/v1/webhooks/1/test      # {"status": 200, "error": null, "attempts": 1, ...}
```

Events: `added`, `metadata`, `finished`, `moved` (with a download path, the
content reached its save path after `finished`), `error`, `removed`, and
`test`; `events: []` subscribes to all. Each is a `POST` of a
`WebhookPayload`:

```json
{"event": "finished", "time": 1790200000, "delivery": "5f0c...", "hash": "...", "detail": null,
 "torrent": {"name": "...", "category": "linux", "save_path": "...", "content_path": "...", "size": 1234, ...}}
```

With a secret, `X-Urtorrentd-Signature: sha256=<hex>` is the HMAC-SHA256 of
`<X-Urtorrentd-Timestamp>.<body>`; check it on the raw body. Redirects are
not followed; no answer, 429 and 5xx are retried after 2 s, 10 s and 60 s.
`GET /webhooks` shows each webhook's last 20 deliveries (since the start).

## Statistics ([ADR 0005](adr/0005-statistics.md))

The daemon records history in `<data dir>/stats.db` (settings:
`stats_enabled`, retention per step; [settings.md](settings.md)). Series are
bytes and seconds per bucket, computed from differences of the library's
counters, never from rates. Each bucket is named by its start `t` (unix
seconds, UTC-aligned); buckets in which nothing moved are left out, and
`periods` says when anything was recorded at all (a gap outside every
period means the daemon was down or recording was off).

```sh
# A torrent's last day, per minute (the default step is the finest one kept)
GET /api/v1/stats/torrents/<hash>/traffic
{"hash": "...", "name": "...", "removed": null, "from": 1790112000, "to": 1790198400, "step": "minute",
 "points": [{"t": 1790197140, "downloaded": 0, "uploaded": 4194304, "peers_max": 3, "seeds_max": 0}, ...],
 "periods": [{"started": 1790100000, "ended": null, "clean": true}]}

# Its seeding history: a row per UTC day it ran or moved data
GET /api/v1/stats/torrents/<hash>/days?from=1787000000
{"days": [{"t": 1790121600, "uploaded": 734003200, "seeding_time": 86400, "uploaded_total": 9663676416,
           "ratio": 4.5, "swarm_seeds_max": 41, "swarm_leechers_max": 7, ...}], ...}

# What seeded most this week, and what happened to it
GET /api/v1/stats/top?from=1789593600&by=uploaded&limit=10
GET /api/v1/stats/timeline?hash=<hash>
```

### By place

With a GeoIP database configured (`geoip_database`, `geoip_asn_database`;
[settings.md](settings.md#geolocation)), peers carry `country`, `asn` and
`as_org`, and `/stats/geo` has the traffic by country or autonomous system:

```sh
# Where this torrent's upload went this week, with a daily series of the top 5
GET /api/v1/stats/geo?hash=<hash>&from=1789593600&dim=country&limit=5&series=true
{"hash": "...", "step": "hour", "dim": "country", "located": true,
 "rows": [{"country": "DE", "asn": null, "as_org": null, "downloaded": 0, "uploaded": 734003200, "peers_max": 12}, ...],
 "points": [{"t": 1789596000, "country": "DE", "downloaded": 0, "uploaded": 4194304, "peers": 3}, ...],
 "unattributed": {"downloaded": 0, "uploaded": 16384}}

# Which networks peers came from, over all torrents
GET /api/v1/stats/geo?dim=asn&by=downloaded
```

Rows plus `unattributed` add up to the torrents' traffic over the range.
`unattributed` holds what no peer accounts for: web seeds, a connection whose
end was missed, and the last seconds of a running transfer (peers are sampled
every 10 s). A row with `country` (or `asn`) `null` is peers the database
does not place, or all peers when there is no database (`located` false):
traffic is recorded by peer either way, so a database added later locates
new traffic, not old. `peers` is distinct addresses per torrent and bucket;
peer addresses themselves are never stored. Places are kept per hour and per
day, with the same retention as the traffic.

### Breakdowns

The same per-peer accounting breaks traffic down by what peers are:

```sh
GET /api/v1/stats/peers?dim=client&step=day      # qBittorrent, Transmission, ... (no versions)
GET /api/v1/stats/peers?dim=source&hash=<hash>   # tracker, dht, pex, lsd, incoming, manual, resume
GET /api/v1/stats/peers?dim=transport            # tcp, utp; also encryption, ip_version, direction
```

and torrents' traffic by what they belong to (`PeerBreakdown` and `GroupStats`
take `series=true` like `/stats/geo`):

```sh
GET /api/v1/stats/groups?group=category&from=1787000000
GET /api/v1/stats/groups?group=tag               # a torrent counts in each of its tags
GET /api/v1/stats/trackers?step=day&from=1787000000
{"rows": [{"host": "tracker.example.org", "uploaded": 9663676416, "downloaded": 0, "torrents": 12,
           "announces": 1310, "announce_errors": 4}, ...]}
```

Groups follow each torrent's category and tags as they are now (or were when
it was removed): moving a torrent to another category moves its history.
Trackers are grouped by the host of the tracker each torrent last worked
with; only hosts are stored, never URLs (private trackers put the passkey in
them). Announces are counted per host as they are answered or fail.

`GET /api/v1/stats/idle-seeds?days=30` lists the complete torrents with what
each uploaded in the last `days` days, `value` = uploaded ÷ size, least
first: the top of the list is what shares least for the disk it takes.
`recorded_from` says when recording began if that was inside the window.

With `stats_scrape_interval` set ([settings.md](settings.md#statistics)),
the daemon scrapes the trackers of every torrent that often and the days
gain `swarm_completed_max`, the swarm's completed downloads. Off by default:
announces already report the swarm's seeds and leechers.

A time-of-day pattern (an hour × weekday heatmap) is the hourly series
binned in the viewer's time zone; `sdk/typescript/check.ts` shows it.
Removed torrents keep their history (with `removed` set) until the retention
expires or `DELETE /stats/torrents/{hash}` purges it. Peer maxima are
sampled every 2 s, so a short connection may not show. If `stats.db` cannot
be opened, the daemon runs without statistics and `/stats` answers
`503 unavailable`.

## Endpoints

| Method | Path | What |
|---|---|---|
| POST | `/auth/login` | Log in (public); sets the session cookie |
| GET | `/auth/status` | Whether first-run setup is still open (public) |
| POST | `/auth/setup` | First run: choose the user name and password, logged in at once (public; `409` once set) |
| POST | `/auth/logout` | End the session |
| PUT | `/auth/credentials` | Change user name and password (ends every session) |
| POST, DELETE | `/auth/api-key` | Create (rotate) or delete the API key |
| GET | `/app` | Version, library, pid, start time, data dir, default save path, peer port, settings waiting for a restart |
| POST | `/app/shutdown` | Graceful shutdown |
| GET, PATCH | `/settings` | All settings; change some ([settings.md](settings.md)) |
| GET | `/fs/directory` | List a directory (for choosing paths) |
| GET, PUT | `/app/cookies` | The cookie jar for the daemon's own HTTP requests |
| GET | `/app/interfaces` | Network interfaces and their addresses |
| GET, POST | `/torrents` | The list (filter, category, tag, hashes, private, search, sort, paging); add torrents |
| GET | `/torrents/count` | How many torrents |
| GET | `/torrents/files` | Search file names across torrents ([Search](#search)) |
| POST | `/torrents/parse` | Describe a `.torrent` without adding it |
| GET, POST | `/previews` | Metadata previews; fetch a magnet's (or URL's) metadata without adding the torrent |
| GET, DELETE | `/previews/{hash}` | A preview (fetching, ready with the metadata, failed); drop it |
| GET | `/previews/{hash}/torrent-file` | A ready preview as a `.torrent` |
| POST | `/torrents/start`, `/stop`, `/force-start`, `/recheck`, `/reannounce`, `/delete` | Bulk lifecycle |
| POST | `/torrents/queue` | Move in the queue (top, up, down, bottom) |
| POST | `/torrents/download-path` | Move incomplete torrents to a download path, or back |
| POST | `/torrents/sequential`, `/first-last-piece-priority`, `/limits`, `/share-limits`, `/location`, `/category`, `/tags`, `/auto-management`, `/peers` | Bulk settings and peers |
| GET, PATCH | `/torrents/{hash}` | Everything about one torrent; change its name or comment |
| GET | `/torrents/{hash}/files` | Files with progress, priority, piece range, availability |
| POST | `/torrents/{hash}/files/priority`, `/files/rename`, `/folders/rename` | File priorities and renames |
| GET, POST | `/torrents/{hash}/trackers` | Trackers (with a row per listen socket) and DHT / PEX / LSD sources; add trackers |
| POST | `/torrents/{hash}/trackers/remove`, `/trackers/edit` | Remove or replace trackers |
| GET, POST | `/torrents/{hash}/webseeds` | Web seeds; add |
| POST | `/torrents/{hash}/webseeds/remove`, `/webseeds/edit` | Remove or replace web seeds |
| GET | `/torrents/{hash}/peers` | Connected peers, with country and network (GeoIP) |
| GET | `/torrents/{hash}/pieces`, `/pieces/hashes` | Piece states, availability and priorities; piece hashes |
| GET | `/torrents/{hash}/torrent-file` | The `.torrent` (current trackers and web seeds) |
| GET, POST, PUT | `/categories` | Categories; create; edit |
| POST | `/categories/remove` | Remove categories |
| GET, POST | `/tags` | Tags; create |
| POST | `/tags/remove` | Delete tags (also from torrents) |
| GET | `/transfer` | Rates, session and all-time totals, limits in force, connectivity, DHT nodes, external addresses, free space |
| PUT | `/transfer/alt-speed` | Switch to or from the alternative limits |
| POST | `/transfer/bans` | Ban peer addresses |
| GET | `/sync` | Incremental updates: everything, then changes since `rev` |
| GET | `/events` | The same updates pushed as server-sent events |
| GET | `/log`, `/log/peers` | Main log; peer (ban) log |
| GET, POST | `/rss/feeds` | RSS feeds; add one |
| GET, PATCH, DELETE | `/rss/feeds/{id}` | A feed with its articles; change it; remove it |
| POST | `/rss/feeds/{id}/refresh`, `/rss/feeds/{id}/read` | Refresh now; mark articles read |
| GET | `/rss/articles` | Articles across feeds (unread only, one feed) |
| GET, POST | `/rss/folders` | Folders; add one |
| POST | `/rss/folders/remove`, `/rss/folders/move` | Remove a folder with its feeds; move one |
| GET | `/rss/rules` | Download rules |
| PUT, DELETE | `/rss/rules/{name}` | Create or replace a rule; remove it |
| POST | `/rss/rules/{name}/rename` | Rename a rule |
| GET | `/rss/rules/{name}/matches` | What a rule's filters take from its feeds |
| GET, PATCH | `/client-data` | The client data store (JSON by key) |
| GET, POST | `/webhooks` | Webhooks with their last deliveries; add one |
| GET, PATCH, DELETE | `/webhooks/{id}` | One webhook; change it; remove it |
| POST | `/webhooks/{id}/test` | Deliver a `test` event now |
| GET | `/stats` | What the statistics database holds: size, torrents, oldest bucket per step |
| GET | `/stats/transfer` | Session traffic over time, with the recording periods |
| GET | `/stats/torrents/{hash}/traffic` | A torrent's traffic over time (minute, hour or day buckets) |
| GET | `/stats/torrents/{hash}/days` | A torrent's days: bytes, running and seeding time, all-time counters, ratio, swarm size |
| DELETE | `/stats/torrents/{hash}` | Delete a torrent's history |
| GET | `/stats/top` | Torrents ranked by bytes up or down over a range (removed ones too) |
| GET | `/stats/geo` | Peer traffic by country or autonomous system, per torrent or overall, optionally as a series |
| GET | `/stats/peers` | Peer traffic by client, discovery source, transport, encryption, IP version or direction |
| GET | `/stats/groups` | Traffic by category or tag |
| GET | `/stats/trackers` | Per tracker host: traffic of its torrents, announces answered and failed |
| GET | `/stats/idle-seeds` | Complete torrents by what they uploaded in the last days relative to their size, least first |
| GET | `/stats/timeline` | What happened to torrents (added, finished, moved, errors, state changes, removed) |

## Adding torrents: qBittorrent's `torrents/add` parameters

| qBittorrent | Here (`AddTorrentsRequest`) |
|---|---|
| `torrents` (file parts) | `torrents`: base64 `.torrent` files |
| `urls` | `urls`: magnet links, bare info-hashes, `http(s)` URLs |
| `savepath` | `options.save_path` |
| `downloadPath`, `useDownloadPath` | `options.download_path`, `options.use_download_path` |
| `category`, `tags` | `options.category`, `options.tags` (created if missing) |
| `stopped` | `options.stopped` |
| `forced` | `options.forced` |
| `addToTopOfQueue` | `options.add_to_top_of_queue` |
| `stopCondition` | `options.stop_condition` (magnets: held when the metadata arrives, nothing downloaded) |
| `contentLayout` | `options.content_layout` (magnets: applied while held once the metadata arrives) |
| `rename` | `options.rename` |
| `upLimit`, `dlLimit` | `options.upload_limit`, `options.download_limit` |
| `ratioLimit`, `seedingTimeLimit`, `inactiveSeedingTimeLimit`, `shareLimitAction` | `options.share_limits` |
| `autoTMM` | `options.auto_management` |
| `sequentialDownload` | `options.sequential` |
| `filePriorities` | `options.file_priorities` |
| `skip_checking` | unsupported: skipping verification would advertise unverified data (AGENTS.md rule 1) |
| `firstLastPiecePrio` | `options.first_last_piece_priority` |
| `downloader` | not applicable: one built-in downloader; `options.cookie` sets the `Cookie` header |
| (none) | `options.max_connections`, `options.max_uploads`, `options.preallocate` |

## Coverage of qBittorrent 5.2.3's WebAPI

Every action of the reference (`docs/reference/qbittorrent-5.2.3-endpoints.txt`)
has a row; `tests/coverage.rs` fails otherwise. **done**: offered here (the
column names the endpoint). **planned**: a daemon feature not built yet.
**unsupported**: with the reason.

| qBittorrent | Status | Here / why not |
|---|---|---|
| `auth/login` | done | `POST /auth/login` |
| `auth/logout` | done | `POST /auth/logout` |
| `app/version` | done | `GET /app` (`version`) |
| `app/webapiVersion` | done | `GET /app` (`api_version`) |
| `app/buildInfo` | done | `GET /app` (`version`, `library`) |
| `app/processInfo` | done | `GET /app` (`pid`, `started_at`) |
| `app/shutdown` | done | `POST /app/shutdown` |
| `app/preferences` | done | `GET /settings` |
| `app/setPreferences` | done | `PATCH /settings` |
| `app/defaultSavePath` | done | `GET /app` (`default_save_path`) |
| `app/getDirectoryContent` | done | `GET /fs/directory` |
| `app/sendTestEmail` | unsupported | no e-mail (maintainer decision); webhooks notify: `POST /webhooks/{id}/test` |
| `app/cookies` | done | `GET /app/cookies`: the jar sent with `.torrent` downloads, RSS feeds and the tracker list |
| `app/setCookies` | done | `PUT /app/cookies` |
| `app/rotateAPIKey` | done | `POST /auth/api-key` |
| `app/deleteAPIKey` | done | `DELETE /auth/api-key` |
| `app/networkInterfaceList` | done | `GET /app/interfaces` |
| `app/networkInterfaceAddressList` | done | `GET /app/interfaces` (each interface with its addresses) |
| `log/main` | done | `GET /log` |
| `log/peers` | done | `GET /log/peers` |
| `sync/maindata` | done | `GET /sync`; pushed: `GET /events` (server-sent events) |
| `sync/torrentPeers` | done | `GET /torrents/{hash}/peers` (the full list each time; peer lists are small); `country` (code), `asn`, `as_org` from the GeoIP database |
| `transfer/info` | done | `GET /transfer` |
| `transfer/uploadLimit` | done | `GET /transfer` (`upload_limit` in force) |
| `transfer/downloadLimit` | done | `GET /transfer` (`download_limit` in force) |
| `transfer/setUploadLimit` | done | `PATCH /settings` (`upload_limit`, `alt_upload_limit`) |
| `transfer/setDownloadLimit` | done | `PATCH /settings` (`download_limit`, `alt_download_limit`) |
| `transfer/speedLimitsMode` | done | `GET /transfer` (`alt_speed_enabled`) |
| `transfer/setSpeedLimitsMode` | done | `PUT /transfer/alt-speed` |
| `transfer/toggleSpeedLimitsMode` | done | `PUT /transfer/alt-speed` |
| `transfer/banPeers` | done | `POST /transfer/bans` (ranges: the `banned_ip_ranges` setting) |
| `torrents/count` | done | `GET /torrents/count` |
| `torrents/info` | done | `GET /torrents` (also `search`: name, category, tags, tracker host, info-hash prefix); `includeFiles`: `GET /torrents/files` (every torrent's files, paged); `includeTrackers`: `GET /torrents/{hash}/trackers` |
| `torrents/properties` | done | `GET /torrents/{hash}` |
| `torrents/trackers` | done | `GET /torrents/{hash}/trackers` |
| `torrents/webseeds` | done | `GET /torrents/{hash}/webseeds` |
| `torrents/addWebSeeds` | done | `POST /torrents/{hash}/webseeds` |
| `torrents/editWebSeed` | done | `POST /torrents/{hash}/webseeds/edit` |
| `torrents/removeWebSeeds` | done | `POST /torrents/{hash}/webseeds/remove` |
| `torrents/files` | done | `GET /torrents/{hash}/files` |
| `torrents/pieceHashes` | done | `GET /torrents/{hash}/pieces/hashes` |
| `torrents/pieceStates` | done | `GET /torrents/{hash}/pieces` (`states`) |
| `torrents/pieceAvailability` | done | `GET /torrents/{hash}/pieces` (`availability`) |
| `torrents/add` | done | `POST /torrents` (parameters above) |
| `torrents/addTrackers` | done | `POST /torrents/{hash}/trackers` |
| `torrents/editTracker` | done | `POST /torrents/{hash}/trackers/edit` |
| `torrents/removeTrackers` | done | `POST /torrents/{hash}/trackers/remove` |
| `torrents/addPeers` | done | `POST /torrents/peers` |
| `torrents/stop` | done | `POST /torrents/stop` |
| `torrents/start` | done | `POST /torrents/start` |
| `torrents/filePrio` | done | `POST /torrents/{hash}/files/priority` |
| `torrents/uploadLimit` | done | `GET /torrents` / `GET /torrents/{hash}` (`upload_limit`) |
| `torrents/downloadLimit` | done | `GET /torrents` / `GET /torrents/{hash}` (`download_limit`) |
| `torrents/setUploadLimit` | done | `POST /torrents/limits` |
| `torrents/setDownloadLimit` | done | `POST /torrents/limits` |
| `torrents/setShareLimits` | done | `POST /torrents/share-limits` |
| `torrents/toggleSequentialDownload` | done | `POST /torrents/sequential` (set, not toggle) |
| `torrents/toggleFirstLastPiecePrio` | done | `POST /torrents/first-last-piece-priority` (set, not toggle) |
| `torrents/setSuperSeeding` | unsupported | super-seeding is a library non-goal |
| `torrents/setForceStart` | done | `POST /torrents/force-start` |
| `torrents/delete` | done | `POST /torrents/delete` |
| `torrents/increasePrio` | done | `POST /torrents/queue` (`up`) |
| `torrents/decreasePrio` | done | `POST /torrents/queue` (`down`) |
| `torrents/topPrio` | done | `POST /torrents/queue` (`top`) |
| `torrents/bottomPrio` | done | `POST /torrents/queue` (`bottom`) |
| `torrents/setLocation` | done | `POST /torrents/location` |
| `torrents/setSavePath` | done | `POST /torrents/location` |
| `torrents/setDownloadPath` | done | `POST /torrents/download-path` (incomplete torrents move; `null` moves back to the save path) |
| `torrents/rename` | done | `PATCH /torrents/{hash}` (`name`) |
| `torrents/setComment` | done | `PATCH /torrents/{hash}` (`comment`) |
| `torrents/setAutoManagement` | done | `POST /torrents/auto-management` |
| `torrents/recheck` | done | `POST /torrents/recheck` |
| `torrents/reannounce` | done | `POST /torrents/reannounce` (all trackers) |
| `torrents/setCategory` | done | `POST /torrents/category` |
| `torrents/createCategory` | done | `POST /categories` |
| `torrents/editCategory` | done | `PUT /categories` |
| `torrents/removeCategories` | done | `POST /categories/remove` |
| `torrents/categories` | done | `GET /categories` |
| `torrents/addTags` | done | `POST /torrents/tags` (`add`) |
| `torrents/setTags` | done | `POST /torrents/tags` (`set`) |
| `torrents/removeTags` | done | `POST /torrents/tags` (`remove`) |
| `torrents/createTags` | done | `POST /tags` |
| `torrents/deleteTags` | done | `POST /tags/remove` |
| `torrents/tags` | done | `GET /tags` |
| `torrents/renameFile` | done | `POST /torrents/{hash}/files/rename` |
| `torrents/renameFolder` | done | `POST /torrents/{hash}/folders/rename` (one rename per file, not atomic) |
| `torrents/export` | done | `GET /torrents/{hash}/torrent-file` |
| `torrents/SSLParameters` | unsupported | SSL torrents are a library non-goal |
| `torrents/setSSLParameters` | unsupported | as above |
| `torrents/fetchMetadata` | done | `POST /previews`, `GET /previews/{hash}` |
| `torrents/parseMetadata` | done | `POST /torrents/parse` |
| `torrents/saveMetadata` | done | `GET /previews/{hash}/torrent-file` |
| `rss/addFolder` | done | `POST /rss/folders` |
| `rss/addFeed` | done | `POST /rss/feeds` (`folder`, `refresh_interval`) |
| `rss/setFeedURL` | done | `PATCH /rss/feeds/{id}` (`url`) |
| `rss/setFeedRefreshInterval` | done | `PATCH /rss/feeds/{id}` (`refresh_interval`) |
| `rss/removeItem` | done | `DELETE /rss/feeds/{id}`, `POST /rss/folders/remove` |
| `rss/moveItem` | done | `PATCH /rss/feeds/{id}` (`folder`), `POST /rss/folders/move` |
| `rss/items` | done | `GET /rss/feeds`, `GET /rss/feeds/{id}`, `GET /rss/articles`, `GET /rss/folders` |
| `rss/markAsRead` | done | `POST /rss/feeds/{id}/read` |
| `rss/refreshItem` | done | `POST /rss/feeds/{id}/refresh` |
| `rss/setRule` | done | `PUT /rss/rules/{name}` |
| `rss/renameRule` | done | `POST /rss/rules/{name}/rename` |
| `rss/removeRule` | done | `DELETE /rss/rules/{name}` |
| `rss/rules` | done | `GET /rss/rules` |
| `rss/matchingArticles` | done | `GET /rss/rules/{name}/matches` |
| `search/start` | unsupported | search plugins are out of scope (urtorrent non-goal) |
| `search/stop` | unsupported | as above |
| `search/status` | unsupported | as above |
| `search/results` | unsupported | as above |
| `search/delete` | unsupported | as above |
| `search/downloadTorrent` | unsupported | as above |
| `search/plugins` | unsupported | as above |
| `search/installPlugin` | unsupported | as above |
| `search/uninstallPlugin` | unsupported | as above |
| `search/enablePlugin` | unsupported | as above |
| `search/updatePlugins` | unsupported | as above |
| `torrentcreator/addTask` | unsupported | torrent creation is a library non-goal (open question, AGENTS.md section 8) |
| `torrentcreator/status` | unsupported | as above |
| `torrentcreator/torrentFile` | unsupported | as above |
| `torrentcreator/deleteTask` | unsupported | as above |
| `clientdata/load` | done | `GET /client-data?keys=` |
| `clientdata/store` | done | `PATCH /client-data` (`null` removes a key) |
