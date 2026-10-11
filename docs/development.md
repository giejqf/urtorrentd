# Development

Read [AGENTS.md](../AGENTS.md) first: the rules, the architecture and the definition of
done. The web UI has its own guide, [frontend/AGENTS.md](../frontend/AGENTS.md).

## Commands

```sh
cargo xtask check     # fmt, clippy -D warnings, every test, docs, cargo-deny
cargo xtask openapi   # regenerate openapi.json after an API change
cargo xtask sdk       # TypeScript types from openapi.json, and a client type-checked against them
cargo xtask web       # the web UI's checks and its end-to-end tests against real daemons
cargo xtask dist      # the web UI, then a release binary with it built in
cargo xtask badges    # regenerate the README's badges (docs/badges)
```

`sdk`, `web`, `dist` and `badges` need Node.js 22; `web` also needs Playwright's Chromium
(`npx playwright install chromium` in `frontend/`).

## Tests

Every test runs offline. The daemon tests start real urtorrent engines on loopback
addresses (`127.0.0.x`, DHT and LSD off), so they need io_uring like the daemon itself.

| Where | What |
|---|---|
| `crates/urtorrentd/src` | Unit tests: settings, auth, sync diffs, RSS parsing and rules, persistence |
| `crates/urtorrentd/tests` | The API on real engines (two daemons transfer real torrents), restart and `kill -9`, statistics, GeoIP, RSS, webhooks, previews, search, listen binding; every response validated against `openapi.json` |
| `tests/coverage.rs` | Every qBittorrent action and preference key has a row in `docs/api.md` and `docs/settings.md` |
| `tests/openapi.rs` | The committed `openapi.json` is current and well-formed |
| `sdk/typescript` | A client generated from the schema type-checks, and wrong calls do not |
| `frontend/e2e` | Playwright against real daemons: sign-in, a real download, settings, RSS, statistics, accessibility (axe) |

## The web UI

```sh
cd frontend
npm ci
npm run dev           # http://localhost:5173; /api goes to $URTORRENTD_URL (default http://127.0.0.1:8080)
```

## Changing the API

Annotate the handler, register it in `api::routes()`, call it from a test, document it in
[api.md](api.md), run `cargo xtask openapi` and commit `openapi.json` with the change
(AGENTS.md 4.3). A feature the library lacks goes in [gaps.md](gaps.md), not around it.

## Releases

SemVer; each user-visible change gets a line in [CHANGELOG.md](../CHANGELOG.md). After a
version bump, run `cargo xtask badges` and commit the badges.
