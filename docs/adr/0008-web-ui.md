# ADR 0008: The web UI, served by the daemon

Status: accepted (2026-09-24, maintainer decision).

Amends [ADR 0007](0007-first-run-setup.md) on one point: cross-origin
preflights are granted to the origins in `api_cors_origins`, and to no
other.

## Context

Until 0.13.0 the daemon was API-only, and a UI was someone else's client.
The maintainer decided to build a web UI in this repository
([`frontend/`](../../frontend/AGENTS.md): SolidJS, shadcn components,
Tailwind, Lucide, Vite) and to have the daemon serve it, with a reverse
proxy such as Caddy terminating TLS, and asked for the cross-origin cases to
be handled. The UI is at `/` and the API at `/api/v1`, on one host and port;
mounting under a sub-path is not supported. The UI stays a client of
`openapi.json`: nothing in the API exists for it alone.

## Decision

- **Where the files come from.** Release builds embed `frontend/dist` in the
  binary (cargo feature `web-ui`, turned on by `cargo xtask dist`; the build
  script reads the directory, so `cargo build` without the feature needs no
  Node). `--web-ui <dir>` serves a build from a directory instead
  (qBittorrent's alternative WebUI; the end-to-end tests run a debug daemon
  this way). `--no-web-ui` serves none. It is a start-up option, never an
  API setting: the files are served without authentication, so an API
  setting would let any API user publish any directory to anyone.
- **Routes.** `/api/...` is the API; its unknown paths stay JSON 404s. Every
  other path is the UI's: a file of the build if one matches, else
  `index.html` for `GET` and `HEAD` when the last segment has no extension
  (a route of the single-page app), else a 404 (a stale asset never turns
  into a page). Hidden files, `..` and symbolic links that leave the build
  are never served. The UI's files pass the same guards as the API (bans,
  the `Host` check) but need no session.
- **Headers.** `assets/` (named by content hash) is cached for a year and
  immutable, everything else is `no-cache`. Every UI response has a
  `Content-Security-Policy` that allows the UI's own scripts only (styles
  may be inline: components and the toaster set them), data only from the
  daemon, and no framing (`frame-ancestors 'none'`, `X-Frame-Options:
  DENY`: qBittorrent's clickjacking protection, always on), plus `nosniff`
  and `Referrer-Policy: no-referrer`.
- **Behind a TLS-terminating proxy.** A trusted proxy's
  `X-Forwarded-Proto: https` makes the session cookie `Secure`. The CSRF
  check already compares the `Origin`'s authority with the (forwarded)
  host, not the scheme, so it holds behind TLS. A request that carries
  forwarding headers (`X-Forwarded-For`, `X-Real-IP`, `Forwarded`) from a
  peer that is not in `api_trusted_proxies` comes from an unknown client: it
  gets no address-based exemption (`api_bypass_local_auth`,
  `api_auth_whitelist`), and the daemon logs a warning once. Without this, a
  proxy on loopback that the operator forgot to trust would have exempted
  every client on the internet.
- **CORS.** The UI is same-origin with the API (in development too: Vite
  proxies `/api` and keeps `Host`), so it needs none. Other browser clients
  are opt-in: `api_cors_origins` lists exact origins (no wildcard, since
  credentials are allowed). CORS is the outermost layer: preflights from a
  listed origin are answered before authentication, every response to one
  (errors included) carries `Access-Control-Allow-Origin` and
  `-Credentials` with `Vary: Origin`, and its requests pass the CSRF check.
  Unlisted origins get no CORS headers and their preflights a `403
  cross_origin`. Cookies still reach only the same site (`SameSite=Strict`):
  a page on another site uses an API key.

## Alternatives

- **Only a directory, never embedded**: one more thing to deploy next to the
  binary. Kept as the override.
- **Only embedded**: every `cargo build` would need Node and a UI build, and
  the end-to-end tests would rebuild the daemon for every UI change.
- **A web UI setting instead of `--web-ui`**: refused above.
- **Hash routing** (`/#/torrents`), to need no fallback: the fallback is a
  few lines, and real paths are what users bookmark.

## Consequences

- One process and one origin serve everything; the reverse proxy only
  terminates TLS.
- `docs/settings.md`: `alternative_webui_*` are done (`--web-ui`),
  clickjacking protection and the `Secure` cookie are fixed behaviours,
  custom headers stay unsupported (CORS has its own setting; other headers
  belong in the proxy).
- The daemon's tests cover the routes, headers, fallback, CORS, the
  `Secure` cookie and relays (`tests/web.rs`); the UI's end-to-end tests
  load it from a real daemon.
