# urtorrentd

A BitTorrent daemon for Linux on the [urtorrent](../urtorrent) library
(io_uring, IPv4 + IPv6), controlled through a typed HTTP API. The API offers
the features of qBittorrent's WebAPI that urtorrent supports, with its own
consistent design; its OpenAPI 3.1 schema is generated from the code, so
frontends get a type-safe SDK from any generator.

Read [AGENTS.md](AGENTS.md) first: it is the project charter.

## Run

```sh
cargo run --release -p urtorrentd -- --data-dir ~/.local/share/urtorrentd --api-listen 127.0.0.1:8080
```

All state is in one SQLite database, `<data dir>/urtorrentd.db`; back it up
with `sqlite3 urtorrentd.db ".backup copy.db"`, even while the daemon runs.

On the first start without a password the daemon prints a temporary one for
the user `admin`; set a permanent login with
`PUT /api/v1/auth/credentials`, or while stopped with
`urtorrentd passwd --username admin` (password on stdin). Requirements are
the library's: Linux 6.1+ with io_uring enabled (containers need a seccomp
profile that allows it).

## The API

- Schema: [`openapi.json`](openapi.json), also served at
  `GET /api/v1/openapi.json`; `urtorrentd openapi` prints it.
- Overview, and the map from qBittorrent's WebAPI: [docs/api.md](docs/api.md).
- Settings: [docs/settings.md](docs/settings.md).

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
```

The tests start real engines on loopback addresses (`127.0.0.x`) and never
touch the public internet.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
