# urtorrentd

A BitTorrent daemon for Linux on the [urtorrent](https://crates.io/crates/urtorrent) library
(io_uring, IPv4 + IPv6), controlled through a typed HTTP API. The API offers
the features of qBittorrent's WebAPI that urtorrent supports, with its own
consistent design; its OpenAPI 3.1 schema is generated from the code, so
frontends get a type-safe SDK from any generator.

Read [AGENTS.md](AGENTS.md) first: it is the project charter.

## Run

```sh
cargo run --release -p urtorrentd -- --data-dir ~/.local/share/urtorrentd --api-listen 127.0.0.1:8080
```

The web UI is at `http://127.0.0.1:8080/` when the binary has it built in
(`cargo xtask dist` builds the UI and then a release binary with it); a
plain `cargo build` serves the API only, or a build of the UI with
`--web-ui frontend/dist`. For HTTPS, put a reverse proxy such as Caddy in
front (`reverse_proxy 127.0.0.1:8080`) and set `api_trusted_proxies` and
`api_allowed_hosts` ([docs/settings.md](docs/settings.md#the-web-ui-and-reverse-proxies)).

All state is in one SQLite database, `<data dir>/urtorrentd.db`; back it up
with `sqlite3 urtorrentd.db ".backup copy.db"`, even while the daemon runs.
Recorded history (statistics) is in `<data dir>/stats.db`: disposable,
deleting it loses the history only.

Until a password is set, the first client to call
`POST /api/v1/auth/setup` with a user name and password chooses them and is
logged in (`GET /api/v1/auth/status` tells a client UI whether setup is
open); meanwhile the daemon prints a temporary password for the user `admin`
at every start. Change the login later with `PUT /api/v1/auth/credentials`,
or while stopped with `urtorrentd passwd --username admin` (password on
stdin). With `--api-listen` on a reachable address, set the credentials
before anyone else can. Requirements are
the library's: Linux 6.1+ with io_uring enabled (containers need a seccomp
profile that allows it).

## The API

- Schema: [`openapi.json`](openapi.json), also served at
  `GET /api/v1/openapi.json`; `urtorrentd openapi` prints it.
- Overview, and the map from qBittorrent's WebAPI: [docs/api.md](docs/api.md).
- Settings: [docs/settings.md](docs/settings.md).
- Live updates: `GET /api/v1/events` pushes what changed as server-sent
  events (`EventSource` in a browser); `GET /api/v1/sync` is the polled form.
- Automation: an alternative-limits schedule and watch folders are
  settings ([docs/settings.md](docs/settings.md)); RSS feeds with download
  rules are under `/api/v1/rss`; client UIs keep their preferences in
  `/api/v1/client-data`.
- Search: `GET /api/v1/torrents?search=` filters the list by name,
  category, tag, tracker or info-hash; `GET /api/v1/torrents/files?search=`
  finds files by name across every torrent.
- Metadata preview: `POST /api/v1/previews` fetches a magnet's file list
  without adding it; webhooks (`/api/v1/webhooks`) call your URLs when
  torrents are added, finish, move or go away (no program is ever run).
- History: `/api/v1/stats/...` has traffic per torrent and for the session
  over time, each torrent's seeding days, rankings, a timeline, traffic by
  country and network with a GeoIP database you provide
  ([settings](docs/settings.md#geolocation)), breakdowns by peer client,
  source and transport, by category, tag and tracker, and an idle-seed
  report.

```sh
curl -s -c jar -H 'content-type: application/json' \
  -d '{"username":"admin","password":"..."}' http://127.0.0.1:8080/api/v1/auth/login
curl -s -b jar -H 'content-type: application/json' \
  -d '{"urls":["magnet:?xt=urn:btih:..."],"options":{"category":"linux"}}' \
  http://127.0.0.1:8080/api/v1/torrents
curl -s -b jar 'http://127.0.0.1:8080/api/v1/torrents?filter=downloading'
```

A TypeScript client in two commands (see [sdk/typescript](sdk/typescript)):

```sh
npx openapi-typescript openapi.json -o schema.d.ts
npm install openapi-fetch   # createClient<paths>({ baseUrl })
```

## Develop

```
cargo xtask check     # fmt, clippy -D warnings, tests, docs, cargo-deny
cargo xtask openapi   # regenerate openapi.json after an API change
cargo xtask sdk       # generate TypeScript types and type-check a client (needs Node.js)
cargo xtask web       # the web UI's checks and end-to-end tests (Node.js, Playwright's Chromium)
cargo xtask dist      # a release binary with the web UI built in
```

The tests start real engines on loopback addresses (`127.0.0.x`) and never
touch the public internet. The web UI lives in [`frontend/`](frontend/AGENTS.md)
(SolidJS, Vite): `npm run dev` there serves it on `localhost:5173` against a
daemon on `127.0.0.1:8080`.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
