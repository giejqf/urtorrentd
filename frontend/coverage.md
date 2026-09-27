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

| Operation                                   | Why the UI does not call it                                                                                 |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `GET /api/v1/torrents/{hash}/pieces/hashes` | W3: piece hashes have no design yet (the Files tab and the Overview draw the pieces from `GET .../pieces`). |
| `POST /api/v1/tags`                         | W3: managing tags (the detail panel creates them through `POST /torrents/tags`).                            |
| `POST /api/v1/tags/remove`                  | W3: managing tags.                                                                                          |

## W4: settings, security, logs

| Operation                   | Why the UI does not call it                                          |
| --------------------------- | -------------------------------------------------------------------- |
| `GET /api/v1/webhooks/{id}` | The Webhooks page reads the list: every webhook with its deliveries. |

## RSS

| Operation                    | Why the UI does not call it                                               |
| ---------------------------- | ------------------------------------------------------------------------- |
| `GET /api/v1/rss/feeds/{id}` | The RSS screen reads every feed's articles at once (`GET /rss/articles`). |

## W7: the palette

| Operation                    | Why the UI does not call it                            |
| ---------------------------- | ------------------------------------------------------ |
| `GET /api/v1/torrents/files` | W7: finding files across torrents from the ⌘K palette. |
