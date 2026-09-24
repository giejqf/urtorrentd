# ADR 0006: Webhooks instead of running programs

Status: accepted (2026-09-24, maintainer decision).

## Context

qBittorrent runs an external program when a torrent is added or finishes
(`autorun_on_torrent_added_program`, `autorun_program`, with placeholders
such as `%N` name, `%F` content path, `%L` category). That is the feature on
the checklist. Running programs from a daemon whose API is reachable over
the network turns every API credential into code execution, and it ties the
daemon to the host's shell, paths and environment.

The maintainer's decision: run-on-completion is a webhook, not a program.

## Decision

- **Webhooks are a resource** (`/webhooks`: list, create, change, remove,
  test), stored in `urtorrentd.db` (`state`, key `webhooks`), at most 32.
  The daemon never starts a process.
- **Events**: `added`, `metadata`, `finished`, `moved`, `error`, `removed`
  (the timeline's kinds, state changes excepted), and `test`. A webhook
  subscribes to some or all. `finished` is qBittorrent's "on completion";
  with a download path, `moved` follows when the content is in its final
  place, which is what most consumers want.
- **Delivery**: `POST` of a JSON `WebhookPayload` (in the schema, so
  receivers get types too): the event, its time, a delivery id, the
  info-hash, the torrent's list row (everything qBittorrent's placeholders
  give; for `removed`, read just before the removal) and a detail (the new
  directory, the error). Headers `X-Urtorrentd-Event`,
  `X-Urtorrentd-Delivery`, `X-Urtorrentd-Timestamp`.
- **Signing** (optional secret): `X-Urtorrentd-Signature: sha256=<hex>`,
  the HMAC-SHA256 of `<timestamp>.<body>`; the timestamp in the signed text
  lets a receiver refuse replays. The secret is write-only in the API.
- **Transport**: http or https only; 10 s per request; **redirects are not
  followed** (a redirect is reported as the delivery's result); retries after
  2 s, 10 s and 60 s when there is no answer, 429 or 5xx, never on other
  statuses. Deliveries run in the background, are not kept across restarts,
  and the last 20 per webhook are shown with it. `POST /webhooks/{id}/test`
  delivers a `test` event at once and answers how it went.
- Webhook URLs may point at internal services (that is their use: a media
  server, a home automation hub); only an authenticated administrator
  configures them.

## Consequences

- The four `autorun_*` preference keys map to webhooks; nothing runs a
  program. A user who wants a script runs a small HTTP receiver.
- Events that happen while no receiver answers are lost after the retries;
  events while the daemon is down never happen (the timeline in `/stats`
  keeps the history).
- E-mail notifications stay planned; a webhook-to-mail bridge covers them
  meanwhile.
