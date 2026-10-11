<h1>
  <img src="frontend/public/favicon.svg" alt="" width="36" align="top">
  urtorrentd
</h1>

[![CI](https://github.com/giejqf/urtorrentd/actions/workflows/ci.yml/badge.svg)](https://github.com/giejqf/urtorrentd/actions/workflows/ci.yml)
[![version](docs/badges/version.svg)](CHANGELOG.md)
[![licence](docs/badges/licence.svg)](LICENSE)
[![rust](docs/badges/rust.svg)](rust-toolchain.toml)
[![urtorrent](docs/badges/library.svg)](https://crates.io/crates/urtorrent)
[![platform](docs/badges/platform.svg)](docs/install.md#requirements)

[![OpenAPI](docs/badges/openapi.svg)](openapi.json)
[![qBittorrent WebAPI](docs/badges/webapi.svg)](docs/api.md#coverage-of-qbittorrent-523s-webapi)
[![preferences](docs/badges/settings.svg)](docs/settings.md#coverage-of-qbittorrent-523s-preferences)
[![web UI](docs/badges/webui.svg)](frontend/AGENTS.md)

A BitTorrent daemon for Linux, built on the [urtorrent](https://crates.io/crates/urtorrent)
engine (io_uring, IPv4 + IPv6). You control it through a typed HTTP API or the web UI it
serves. The API offers every feature of qBittorrent's WebAPI that urtorrent supports, with
a design of its own: one unit per kind of value, `null` instead of magic numbers, and an
OpenAPI 3.1 schema generated from the code.

## Features

- **Torrents**: add from files, magnets, info-hashes or URLs; preview a magnet's files
  before adding; queue, force start, limits, share limits, file and piece priorities,
  sequential download, trackers, web seeds, renames, moves.
- **Organise**: categories with their own save and download paths, tags, automatic
  management, an incomplete-file suffix, search by name, tag, tracker or file name.
- **Automation**: RSS feeds with download rules, watch folders, an alternative-limits
  schedule, and webhooks instead of run-on-completion programs.
- **Live updates**: incremental sync, pushed as server-sent events.
- **History**: traffic per torrent and for the session over time, seeding days, and
  breakdowns by country and network (GeoIP), peer client, tracker, category and tag.
- **Safe by default**: sign-in required, API keys, login bans, CSRF and `Host` checks,
  listening on loopback only. Counters are never faked, and the daemon never adds
  trackers or peers to private torrents on its own.
- **Durable**: torrents, settings and resume data live in one SQLite database, and come
  back after a crash or `kill -9`.

## Quick start

Linux 6.1+ with io_uring and Rust 1.98+ ([requirements](docs/install.md#requirements)).
Building the web UI needs Node.js 22.

```sh
cargo xtask dist                 # the web UI, then a release binary with it built in
target/release/urtorrentd        # API and web UI on http://127.0.0.1:8080
```

Open `http://127.0.0.1:8080/` and choose your user name and password: the first client to
do so sets them. From a script:

```sh
curl -c jar -H 'content-type: application/json' \
  -d '{"username":"admin","password":"..."}' http://127.0.0.1:8080/api/v1/auth/login
curl -b jar -H 'content-type: application/json' \
  -d '{"urls":["magnet:?xt=urn:btih:..."]}' http://127.0.0.1:8080/api/v1/torrents
```

## Documentation

| | |
|---|---|
| [Install and run](docs/install.md) | Requirements, options, first sign-in, data and backups, systemd, HTTPS |
| [HTTP API](docs/api.md) | Conventions, live updates, every endpoint, the map from qBittorrent's WebAPI |
| [Settings](docs/settings.md) | Every setting, and the map from qBittorrent's preferences |
| [`openapi.json`](openapi.json) | The schema, also at `GET /api/v1/openapi.json`; generate a client with any tool |
| [Development](docs/development.md) | Building, testing, the repository layout |
| [Decisions](docs/adr/) | Architecture decision records |
| [Changelog](CHANGELOG.md) | What changed in each release |

Contributors and coding agents start with [AGENTS.md](AGENTS.md), the project charter.

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
