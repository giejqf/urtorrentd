# API operations the web UI does not call

`src/api/coverage.test.ts` checks that every operation in
[`../openapi.json`](../openapi.json) is either called by the UI or listed here
with its reason (AGENTS.md 7.3, the UI's version of the charter's rule 3).
Remove a row when the UI starts calling the operation; the test fails on a
row whose operation the UI calls.

## Served by the event stream instead

| Operation                    | Why the UI does not call it                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- |
| `GET /api/v1/torrents`       | The rows come from the event stream; a search asks `GET /api/v1/torrents/hashes` which of them match. |
| `GET /api/v1/sync`           | The UI reads the event stream (`GET /api/v1/events`); polling is for scripts.                         |
| `GET /api/v1/transfer`       | The event stream carries the transfer state (`SyncResponse.transfer`).                                |
| `GET /api/v1/tags`           | The event stream carries the tags.                                                                    |
| `GET /api/v1/torrents/count` | Counts come from the live store; the E2E suite checks them against `GET /torrents?filter=`.           |

## Adding torrents

| Operation                                  | Why the UI does not call it                                                            |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| `GET /api/v1/previews`                     | The add dialog follows its own previews one by one; the list is for other clients.     |
| `GET /api/v1/previews/{hash}/torrent-file` | The add dialog adds a previewed source by its hash, which uses the fetched `.torrent`. |

## W3: one torrent in depth

| Operation                                      | Why the UI does not call it                                                      |
| ---------------------------------------------- | -------------------------------------------------------------------------------- |
| `GET /api/v1/torrents/{hash}`                  | W3: the fields beyond the list row (web seeds, known peers, source URL).         |
| `PATCH /api/v1/torrents/{hash}`                | W3: rename, comment.                                                             |
| `GET /api/v1/torrents/{hash}/files`            | W3: the files tab.                                                               |
| `POST /api/v1/torrents/{hash}/files/priority`  | W3: the files tab.                                                               |
| `POST /api/v1/torrents/{hash}/files/rename`    | W3: the files tab.                                                               |
| `POST /api/v1/torrents/{hash}/folders/rename`  | W3: the files tab.                                                               |
| `GET /api/v1/torrents/{hash}/peers`            | W3: the peers tab.                                                               |
| `GET /api/v1/torrents/{hash}/pieces/hashes`    | W3: the pieces tab.                                                              |
| `POST /api/v1/torrents/{hash}/trackers`        | W3: editing trackers.                                                            |
| `POST /api/v1/torrents/{hash}/trackers/edit`   | W3: editing trackers.                                                            |
| `POST /api/v1/torrents/{hash}/trackers/remove` | W3: editing trackers.                                                            |
| `GET /api/v1/torrents/{hash}/webseeds`         | W3: web seeds.                                                                   |
| `POST /api/v1/torrents/{hash}/webseeds`        | W3: web seeds.                                                                   |
| `POST /api/v1/torrents/{hash}/webseeds/edit`   | W3: web seeds.                                                                   |
| `POST /api/v1/torrents/{hash}/webseeds/remove` | W3: web seeds.                                                                   |
| `POST /api/v1/torrents/limits`                 | W3: speed limits.                                                                |
| `POST /api/v1/torrents/share-limits`           | W3: share limits.                                                                |
| `POST /api/v1/torrents/location`               | W3: moving the content.                                                          |
| `POST /api/v1/torrents/download-path`          | W3: the download path.                                                           |
| `POST /api/v1/torrents/auto-management`        | W3: automatic management.                                                        |
| `POST /api/v1/tags`                            | W3: managing tags (the detail panel creates them through `POST /torrents/tags`). |
| `POST /api/v1/tags/remove`                     | W3: managing tags.                                                               |

## W4: settings, security, logs

| Operation                   | Why the UI does not call it                                          |
| --------------------------- | -------------------------------------------------------------------- |
| `GET /api/v1/webhooks/{id}` | The Webhooks page reads the list: every webhook with its deliveries. |

## RSS

| Operation                    | Why the UI does not call it                                               |
| ---------------------------- | ------------------------------------------------------------------------- |
| `GET /api/v1/rss/feeds/{id}` | The RSS screen reads every feed's articles at once (`GET /rss/articles`). |

## W6: statistics

| Operation                                   | Why the UI does not call it                            |
| ------------------------------------------- | ------------------------------------------------------ |
| `GET /api/v1/stats/torrents/{hash}/traffic` | W6: a torrent's history (not designed yet).            |
| `GET /api/v1/stats/torrents/{hash}/days`    | W6: a torrent's seeding days (not designed yet).       |
| `DELETE /api/v1/stats/torrents/{hash}`      | W6: deleting one torrent's history (not designed yet). |

## W7: the palette

| Operation                    | Why the UI does not call it                            |
| ---------------------------- | ------------------------------------------------------ |
| `GET /api/v1/torrents/files` | W7: finding files across torrents from the ⌘K palette. |
