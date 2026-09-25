# API operations the web UI does not call

`src/api/coverage.test.ts` checks that every operation in
[`../openapi.json`](../openapi.json) is either called by the UI or listed here
with its reason (AGENTS.md 7.3, the UI's version of the charter's rule 3).
Remove a row when the UI starts calling the operation; the test fails on a
row whose operation the UI calls.

## Served by the event stream instead

| Operation                    | Why the UI does not call it                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /api/v1/sync`           | The UI reads the event stream (`GET /api/v1/events`); polling is for scripts.               |
| `GET /api/v1/transfer`       | The event stream carries the transfer state (`SyncResponse.transfer`).                      |
| `GET /api/v1/categories`     | The event stream carries the categories; editing them is W3.                                |
| `GET /api/v1/tags`           | The event stream carries the tags.                                                          |
| `GET /api/v1/torrents/count` | Counts come from the live store; the E2E suite checks them against `GET /torrents?filter=`. |

## W2: adding torrents, the rest

| Operation                                  | Why the UI does not call it                |
| ------------------------------------------ | ------------------------------------------ |
| `POST /api/v1/torrents/parse`              | W2: a `.torrent`'s files before adding it. |
| `GET /api/v1/previews`                     | W2: magnet previews in the add dialog.     |
| `POST /api/v1/previews`                    | W2: magnet previews in the add dialog.     |
| `GET /api/v1/previews/{hash}`              | W2: magnet previews in the add dialog.     |
| `DELETE /api/v1/previews/{hash}`           | W2: magnet previews in the add dialog.     |
| `GET /api/v1/previews/{hash}/torrent-file` | W2: magnet previews in the add dialog.     |

## W3: one torrent in depth

| Operation                                      | Why the UI does not call it                                                                |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/v1/torrents/{hash}`                  | W3: the fields beyond the list row (web seeds, known peers, source URL).                   |
| `PATCH /api/v1/torrents/{hash}`                | W3: rename, comment.                                                                       |
| `GET /api/v1/torrents/{hash}/files`            | W3: the files tab.                                                                         |
| `POST /api/v1/torrents/{hash}/files/priority`  | W3: the files tab.                                                                         |
| `POST /api/v1/torrents/{hash}/files/rename`    | W3: the files tab.                                                                         |
| `POST /api/v1/torrents/{hash}/folders/rename`  | W3: the files tab.                                                                         |
| `GET /api/v1/torrents/{hash}/peers`            | W3: the peers tab.                                                                         |
| `POST /api/v1/torrents/peers`                  | W3: adding peers by hand.                                                                  |
| `GET /api/v1/torrents/{hash}/pieces/hashes`    | W3: the pieces tab.                                                                        |
| `POST /api/v1/torrents/{hash}/trackers`        | W3: editing trackers.                                                                      |
| `POST /api/v1/torrents/{hash}/trackers/edit`   | W3: editing trackers.                                                                      |
| `POST /api/v1/torrents/{hash}/trackers/remove` | W3: editing trackers.                                                                      |
| `GET /api/v1/torrents/{hash}/webseeds`         | W3: web seeds.                                                                             |
| `POST /api/v1/torrents/{hash}/webseeds`        | W3: web seeds.                                                                             |
| `POST /api/v1/torrents/{hash}/webseeds/edit`   | W3: web seeds.                                                                             |
| `POST /api/v1/torrents/{hash}/webseeds/remove` | W3: web seeds.                                                                             |
| `POST /api/v1/torrents/limits`                 | W3: speed limits.                                                                          |
| `POST /api/v1/torrents/share-limits`           | W3: share limits.                                                                          |
| `POST /api/v1/torrents/location`               | W3: moving the content.                                                                    |
| `POST /api/v1/torrents/download-path`          | W3: the download path.                                                                     |
| `POST /api/v1/torrents/auto-management`        | W3: automatic management.                                                                  |
| `PUT /api/v1/categories`                       | W3: managing categories.                                                                   |
| `POST /api/v1/categories`                      | W3: managing categories (the detail panel creates them through `POST /torrents/category`). |
| `POST /api/v1/categories/remove`               | W3: managing categories.                                                                   |
| `POST /api/v1/tags`                            | W3: managing tags (the detail panel creates them through `POST /torrents/tags`).           |
| `POST /api/v1/tags/remove`                     | W3: managing tags.                                                                         |

## W4: settings, security, logs

| Operation                         | Why the UI does not call it        |
| --------------------------------- | ---------------------------------- |
| `GET /api/v1/settings`            | W4: the settings screen.           |
| `PATCH /api/v1/settings`          | W4: the settings screen.           |
| `PUT /api/v1/auth/credentials`    | W4: security settings.             |
| `POST /api/v1/auth/api-key`       | W4: security settings.             |
| `DELETE /api/v1/auth/api-key`     | W4: security settings.             |
| `GET /api/v1/app/cookies`         | W4: the cookie jar for URL adds.   |
| `PUT /api/v1/app/cookies`         | W4: the cookie jar for URL adds.   |
| `GET /api/v1/app/interfaces`      | W4: the network settings.          |
| `GET /api/v1/fs/directory`        | W4: choosing paths.                |
| `GET /api/v1/webhooks`            | W4: webhooks.                      |
| `POST /api/v1/webhooks`           | W4: webhooks.                      |
| `GET /api/v1/webhooks/{id}`       | W4: webhooks.                      |
| `PATCH /api/v1/webhooks/{id}`     | W4: webhooks.                      |
| `DELETE /api/v1/webhooks/{id}`    | W4: webhooks.                      |
| `POST /api/v1/webhooks/{id}/test` | W4: webhooks.                      |
| `PUT /api/v1/transfer/alt-speed`  | W4: the alternative-limits switch. |
| `POST /api/v1/transfer/bans`      | W4: banning peers.                 |
| `GET /api/v1/log`                 | W4: the log screen.                |
| `GET /api/v1/log/peers`           | W4: the log screen.                |

## W5: RSS

| Operation                              | Why the UI does not call it |
| -------------------------------------- | --------------------------- |
| `GET /api/v1/rss/articles`             | W5: the RSS screen.         |
| `GET /api/v1/rss/feeds`                | W5: the RSS screen.         |
| `POST /api/v1/rss/feeds`               | W5: the RSS screen.         |
| `GET /api/v1/rss/feeds/{id}`           | W5: the RSS screen.         |
| `PATCH /api/v1/rss/feeds/{id}`         | W5: the RSS screen.         |
| `DELETE /api/v1/rss/feeds/{id}`        | W5: the RSS screen.         |
| `POST /api/v1/rss/feeds/{id}/read`     | W5: the RSS screen.         |
| `POST /api/v1/rss/feeds/{id}/refresh`  | W5: the RSS screen.         |
| `GET /api/v1/rss/folders`              | W5: the RSS screen.         |
| `POST /api/v1/rss/folders`             | W5: the RSS screen.         |
| `POST /api/v1/rss/folders/move`        | W5: the RSS screen.         |
| `POST /api/v1/rss/folders/remove`      | W5: the RSS screen.         |
| `GET /api/v1/rss/rules`                | W5: the RSS screen.         |
| `PUT /api/v1/rss/rules/{name}`         | W5: the RSS screen.         |
| `DELETE /api/v1/rss/rules/{name}`      | W5: the RSS screen.         |
| `GET /api/v1/rss/rules/{name}/matches` | W5: the RSS screen.         |
| `POST /api/v1/rss/rules/{name}/rename` | W5: the RSS screen.         |

## W6: statistics

| Operation                                   | Why the UI does not call it |
| ------------------------------------------- | --------------------------- |
| `GET /api/v1/stats`                         | W6: the statistics screen.  |
| `GET /api/v1/stats/transfer`                | W6: the statistics screen.  |
| `GET /api/v1/stats/torrents/{hash}/traffic` | W6: the statistics screen.  |
| `GET /api/v1/stats/torrents/{hash}/days`    | W6: the statistics screen.  |
| `DELETE /api/v1/stats/torrents/{hash}`      | W6: the statistics screen.  |
| `GET /api/v1/stats/top`                     | W6: the statistics screen.  |
| `GET /api/v1/stats/geo`                     | W6: the statistics screen.  |
| `GET /api/v1/stats/peers`                   | W6: the statistics screen.  |
| `GET /api/v1/stats/groups`                  | W6: the statistics screen.  |
| `GET /api/v1/stats/trackers`                | W6: the statistics screen.  |
| `GET /api/v1/stats/idle-seeds`              | W6: the statistics screen.  |
| `GET /api/v1/stats/timeline`                | W6: the statistics screen.  |

## W7: the palette

| Operation                    | Why the UI does not call it                            |
| ---------------------------- | ------------------------------------------------------ |
| `GET /api/v1/torrents/files` | W7: finding files across torrents from the ⌘K palette. |
