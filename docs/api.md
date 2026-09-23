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
  settings. `POST /auth/login` and `GET /openapi.json` are public.

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

## Endpoints

| Method | Path | What |
|---|---|---|
| POST | `/auth/login` | Log in (public); sets the session cookie |
| POST | `/auth/logout` | End the session |
| PUT | `/auth/credentials` | Change user name and password (ends every session) |
| POST, DELETE | `/auth/api-key` | Create (rotate) or delete the API key |
| GET | `/app` | Version, library, pid, start time, data dir, default save path, peer port, settings waiting for a restart |
| POST | `/app/shutdown` | Graceful shutdown |
| GET, PATCH | `/settings` | All settings; change some ([settings.md](settings.md)) |
| GET | `/fs/directory` | List a directory (for choosing paths) |
| GET, POST | `/torrents` | The list (filter, category, tag, hashes, private, sort, paging); add torrents |
| GET | `/torrents/count` | How many torrents |
| POST | `/torrents/parse` | Describe a `.torrent` without adding it |
| POST | `/torrents/start`, `/stop`, `/force-start`, `/recheck`, `/reannounce`, `/delete` | Bulk lifecycle |
| POST | `/torrents/queue` | Move in the queue (top, up, down, bottom) |
| POST | `/torrents/sequential`, `/first-last-piece-priority`, `/limits`, `/share-limits`, `/location`, `/category`, `/tags`, `/auto-management`, `/peers` | Bulk settings and peers |
| GET, PATCH | `/torrents/{hash}` | Everything about one torrent; change its name or comment |
| GET | `/torrents/{hash}/files` | Files with progress, priority, piece range, availability |
| POST | `/torrents/{hash}/files/priority`, `/files/rename`, `/folders/rename` | File priorities and renames |
| GET, POST | `/torrents/{hash}/trackers` | Trackers (with a row per listen socket) and DHT / PEX / LSD sources; add trackers |
| POST | `/torrents/{hash}/trackers/remove`, `/trackers/edit` | Remove or replace trackers |
| GET, POST | `/torrents/{hash}/webseeds` | Web seeds; add |
| POST | `/torrents/{hash}/webseeds/remove`, `/webseeds/edit` | Remove or replace web seeds |
| GET | `/torrents/{hash}/peers` | Connected peers |
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
| GET | `/log`, `/log/peers` | Main log; peer (ban) log |

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
| `app/sendTestEmail` | planned | with e-mail notifications |
| `app/cookies` | planned | a stored cookie jar for URL downloads (per request today: `options.cookie`) |
| `app/setCookies` | planned | as above |
| `app/rotateAPIKey` | done | `POST /auth/api-key` |
| `app/deleteAPIKey` | done | `DELETE /auth/api-key` |
| `app/networkInterfaceList` | planned | interface names for the listen settings |
| `app/networkInterfaceAddressList` | planned | as above |
| `log/main` | done | `GET /log` |
| `log/peers` | done | `GET /log/peers` |
| `sync/maindata` | done | `GET /sync` |
| `sync/torrentPeers` | done | `GET /torrents/{hash}/peers` (the full list each time; peer lists are small) |
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
| `torrents/info` | done | `GET /torrents` |
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
| `torrents/setDownloadPath` | planned | per torrent after adding (at add time: `options.download_path`) |
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
| `torrents/fetchMetadata` | planned | a metadata preview; the library's hold (0.12) makes it possible |
| `torrents/parseMetadata` | done | `POST /torrents/parse` |
| `torrents/saveMetadata` | planned | with `fetchMetadata` |
| `rss/addFolder` | planned | RSS (after 0.1.0) |
| `rss/addFeed` | planned | RSS |
| `rss/setFeedURL` | planned | RSS |
| `rss/setFeedRefreshInterval` | planned | RSS |
| `rss/removeItem` | planned | RSS |
| `rss/moveItem` | planned | RSS |
| `rss/items` | planned | RSS |
| `rss/markAsRead` | planned | RSS |
| `rss/refreshItem` | planned | RSS |
| `rss/setRule` | planned | RSS |
| `rss/renameRule` | planned | RSS |
| `rss/removeRule` | planned | RSS |
| `rss/rules` | planned | RSS |
| `rss/matchingArticles` | planned | RSS |
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
| `clientdata/load` | planned | a key-value store for client UIs |
| `clientdata/store` | planned | as above |
