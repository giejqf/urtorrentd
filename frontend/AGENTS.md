# AGENTS.md: the web UI

Guide for coding agents working on `frontend/`, the web UI of urtorrentd. Read the repository's
[`AGENTS.md`](../AGENTS.md) first. It is the project charter, and its rules bind this directory
too (section 1 restates them for the UI). This file adds what is specific to the UI.

Status (2026-09-26): W0, W1, W2 and W5 are done: sign-in, first-run setup, the shell, the
torrents screen and the add dialog, and the RSS screen, as the mockups have them. W4 has every
settings section (Downloads, Speed, Queue & share limits, Connection, BitTorrent, Banned
addresses, Watch folders, RSS, Webhooks, Statistics & GeoIP, Security & API, Engine, About) and
the Log screen.
Section 10 has the milestones.

## 1. What this is

A single-page web UI for urtorrentd, written in SolidJS. It is a client of the daemon's HTTP API
and nothing else. It reads and changes the daemon's state only through `/api/v1`, with types
generated from the committed [`openapi.json`](../openapi.json). The daemon serves the UI's built
files itself (section 5), so one process on one origin serves both the API and the UI. A reverse
proxy such as Caddy terminates TLS in front of it.

The UI lives in the daemon's repository so that an API change and the UI that uses it land
together. It is still its own npm package with its own toolchain. Rust contributors never need
Node: `cargo xtask check` does not build the UI.

The UI covers what the API offers: torrents (list, detail, add with previews, every per-torrent
operation), categories and tags, transfer limits and alternative limits, settings (including
security, webhooks, watch folders and the schedule), RSS, logs and statistics.

### Rules

These restate the charter's rules for the UI and add the UI's own. They are non-negotiable.

1. **The API is the only interface.** Types come from `openapi.json` through
   `openapi-typescript`. Never hand-write a request or response type, and never type API data
   as `any`. When the UI needs something the API does not offer, change the daemon first, in its
   own commit and following the charter (annotate, register, test, `docs/api.md`,
   `cargo xtask openapi`). Never work around a missing field: do not parse log lines, do not
   loop one request per torrent, do not guess. A list of 10 000 torrents costs one event
   stream.
2. **Every number is the daemon's** (charter rule 1). Show what the API reports. Formatting is
   presentation only. Never invent, interpolate, smooth or extrapolate a counter, rate, ratio,
   ETA, progress or availability. `null` means unknown or unlimited and is shown that way ("—",
   "∞"), never as `0`. The sample data in the mockups is illustration only: for example, the
   pieces chart there is noise from a hash function.
3. **No control that does nothing** (charter rule 3). If a design element has no API behind it,
   leave it out and list it in section 6.4. Never ship a dead toggle or a placeholder value.
4. **Private torrents are sacred** (charter rule 2). The UI never adds trackers, web seeds or
   peers for the user. Only an explicit per-torrent action by the user does that. Show the
   private flag wherever trackers are edited.
5. **Only the daemon's origin.** The page loads nothing from anywhere else. Fonts and icons are
   bundled. No CDN, analytics, telemetry, update checks or tracker favicons. Tests never touch
   the public internet (charter rule 4), and the E2E suite fails on any request to a
   non-loopback address.
6. **Untrusted text stays text.** Torrent names, file paths, comments, tracker messages, RSS
   titles and log lines come from strangers, so render them as text. `innerHTML` is banned by
   the linter. A link taken from a torrent or a feed opens only when the user clicks it, with
   `rel="noopener noreferrer"`. Tracker, feed and magnet URLs often carry passkeys. Lists show
   only the host. The full URL appears only where the user edits it, and never in a toast, the
   page title or the UI's own URL.
7. **Credentials.** The browser session is the daemon's `HttpOnly` cookie. The UI never stores
   a password or an API key. A newly rotated API key is shown once and then dropped.
8. **Tests.** Never weaken, skip or delete a failing test (charter rule 6). Every screen and flow
   has end-to-end tests against real daemons (section 7).
9. **Never copy GPL code** (charter rule 7). That includes qBittorrent's WebUI and VueTorrent.
   Components taken from solid-ui (MIT) keep its notice (section 8).

## 2. Stack

These versions were current when this plan was written (2026-09-24). Pin exact versions in
`package.json`, commit `package-lock.json` and install with `npm ci` everywhere. The package
manager is npm, as in `sdk/typescript`, and the runtime is Node 22, as in CI.

| Package | Role |
|---|---|
| `solid-js` 1.9 | The UI framework. Stay on 1.x until 2.0 is stable and Kobalte, solid-ui and TanStack support it. |
| `vite` 8, `vite-plugin-solid` | Dev server and build. |
| `typescript` 5.9 | The same version as `sdk/typescript`. `openapi-typescript` and `typescript-eslint` need 5.x. |
| `tailwindcss` 4, `@tailwindcss/vite`, `tw-animate-css` | Styling. The tokens are in CSS (6.2). |
| shadcn components from [solid-ui](https://www.solid-ui.com), with `@kobalte/core`, `corvu`, `class-variance-authority`, `clsx`, `tailwind-merge` | The primitives. solid-ui ports shadcn/ui to Solid on top of Kobalte and corvu, and publishes it as a shadcn registry. The `shadcn` CLI copies each component into `src/components/ui/` (`npx shadcn@latest add https://www.solid-ui.com/r/<name>.json`). From then on the code is ours. |
| `lucide-solid` | Icons. Import each icon from its own module (`lucide-solid/icons/play`) so dev builds stay fast. |
| `@solidjs/router` | Routes. |
| `@tanstack/solid-query` | Request/response data: everything except the live stream. |
| `@tanstack/solid-virtual` | The torrent list and other long lists. |
| `openapi-typescript`, `openapi-fetch` | Types from `openapi.json` and the typed client, at the same versions as `sdk/typescript`. |
| `solid-sonner` | Toasts (the library shadcn uses). |
| `cmdk-solid` | The ⌘K palette (solid-ui's command component). |
| `@fontsource-variable/geist`, `@fontsource-variable/geist-mono` | The design's fonts, bundled. |
| `uplot` | Time-series charts for statistics, added in the statistics milestone. |
| dev: `vitest` | Unit tests. |
| dev: `@playwright/test`, `@axe-core/playwright` | End-to-end and accessibility tests. |
| dev: `eslint`, `typescript-eslint`, `eslint-plugin-solid`, `prettier`, `prettier-plugin-tailwindcss` | Linting, including Solid's reactivity rules, and formatting. |

Keep the dependency tree small. Justify each new dependency in its commit and prefer platform
APIs (`Intl`, `EventSource`, `URL`, `crypto`). Solid stores and TanStack Query cover all state,
so add no other state library. No CSS-in-JS and no second component library.

## 3. Layout

```
frontend/
  AGENTS.md
  package.json package-lock.json
  index.html
  vite.config.ts        Solid and Tailwind plugins, `~` → src, dev proxy to the daemon (5.3)
  tsconfig.json         strict, noUncheckedIndexedAccess
  components.json       shadcn CLI: aliases (`~/components/ui`, `~/lib/utils`), solid-ui registry
  eslint.config.js .prettierrc
  playwright.config.ts
  coverage.md           API operations the UI does not call, each with its reason (7.3)
  public/               favicon (the logo mark)
  src/
    main.tsx            mount, router, query client
    app.css             Tailwind, the tokens (6.2), base styles: the only file with colour values
    routes.tsx          the route table, one lazy chunk per feature
    api/
      schema.d.ts       generated from ../openapi.json (gitignored)
      client.ts         the openapi-fetch client; errors → ApiError; 401 → sign-in
      live.ts           /api/v1/events → the live store (4.3)
      keys.ts           query keys
    lib/
      utils.ts          cn()
      format.ts         bytes, rates, durations, times, ratios: the only place units turn into text and back
      torrent.ts        state → label, colour and group; filters; tracker hosts
      prefs.ts          UI preferences in /client-data (4.2)
    components/
      ui/               shadcn primitives from solid-ui, restyled to the tokens; our code now
      *.tsx             shared pieces: progress ring, status dot, kbd, empty state, pieces chart
    features/           one folder per area, following the API's groups
      auth/             the session (auth.tsx), first-run setup, sign-in
      shell/            the signed-in gate (protected.tsx), the live store (live.tsx), sidebar,
                        navigation, transfer footer, instance menu; screens still to come
      torrents/         the screen (torrents.tsx), the list, filters and sort (view.ts), the
                        detail panel, pieces (pieces.ts), add/ (the dialog, its sources and
                        previews, form.ts), delete, actions; later files,
                        peers, trackers, web seeds, limits
      settings/         the settings screens: navigation (nav.tsx), the page frame with the
                        restart banner (frame.tsx, restart.tsx), rows, fields and the save bar
                        (controls.tsx), the draft, save and leave logic every page shares
                        (form.tsx); Downloads (downloads.tsx; downloads-form.ts, categories,
                        the path flow, paths.ts), Speed (speed.tsx; speed-form.ts, the
                        schedule in schedule.ts, the week chart) and Queue (queue.tsx;
                        queue-form.ts, the queue's slots in queue-now.ts, the draggable list
                        in queue-list.tsx, share limits in share.ts), Connection and BitTorrent
                        (connection.tsx, bittorrent.tsx; network-form.ts) and Banned addresses
                        (banned.tsx; bans.ts), Watch folders (watch-folders.tsx;
                        watch-form.ts), RSS (rss-settings.tsx; rss-view.ts) and Webhooks
                        (webhooks.tsx; webhooks-view.ts), Statistics & GeoIP (statistics.tsx;
                        statistics-form.ts), Security & API (security.tsx; security-form.ts),
                        Engine (engine.tsx; engine-form.ts) and About (about.tsx;
                        about-view.ts)
      rss/              the RSS screen (rss.tsx): its sidebar sections (sidebar.tsx: feeds in
                        folders, rules), the article panel, the rule editor (rule-editor.tsx;
                        rule-form.ts), feed dialogs, the shared queries (data.ts), view.ts
      log/              the Log screen (log.tsx): its sidebar sections (sidebar.tsx: levels,
                        topics), the shared log query (use-log.ts), view.ts
      stats/
  e2e/
    daemon.ts           starts and stops real daemons, one per test that asks (7.4)
    torrent.ts          makes .torrent files for tests (bencode, SHA-1)
    servers.ts          a page on another origin (CORS), a Caddy-like forwarding proxy
    fixtures.ts         Playwright fixtures: daemons, a signed-in page, the offline and CSP guard
    *.spec.ts
```

Unit tests sit next to their code (`format.test.ts`). The root `.gitignore` has
`/frontend/node_modules`, `/frontend/dist`, `/frontend/src/api/schema.d.ts`,
`/frontend/test-results` and `/frontend/playwright-report`.

## 4. Architecture

### 4.1 Talking to the daemon

- There is one client, in `api/client.ts`: `createClient<paths>()` with the page's origin as its
  base URL. Paths are the schema's (`/api/v1/...`). The UI is always same-origin with the API
  (section 5), so its own requests never involve CORS, and `fetch` sends the session cookie by
  default.
- **Errors.** Every failure has an `ErrorBody` (`{"error": {"code", "message"}}`). `client.ts`
  turns it into one `ApiError` (status, code, message). Branch on `code`, never on the message,
  and show the message to the user.
  - `unauthorized`: go to sign-in, then return to where the user was.
  - `banned`, `cross_origin`, `host_not_allowed`: explain what happened and name the setting
    involved.
  - `shutting_down`: show the daemon-stopped screen.
- **Bulk actions** send `{"hashes": [...]}` or `{"hashes": "all"}`. Their `BulkResult`
  (`applied`, `not_found`, `failed`) is shown whenever not everything applied. Never drop it.
- **Long operations** (recheck, move, file priorities) answer as soon as the daemon accepts
  them. Progress arrives through the live stream as the torrent's state (`checking`, `moving`),
  and failures go to the main log. Don't keep a spinner running on the HTTP call.
- **Units** are the API's: bytes, bytes per second, seconds and unix seconds. `null` means
  unlimited in requests too. User input is converted in `format.ts` and nowhere else.

### 4.2 State

| What | Where |
|---|---|
| Torrents, categories, tags, transfer state | The live store, fed by the event stream (4.3). Nothing polls `/torrents`. |
| Everything else from the API (detail tabs, settings, RSS, logs, statistics) | TanStack Query, one key per resource. A tab refetches on an interval only while it is visible (peers, trackers, pieces: every 2 s). A mutation invalidates the keys it changes. |
| View state: section, filters, search, selection, open tab | The URL, so reload, back and shared links work. |
| Preferences: columns, grouping, sort, accent, units, panel sizes | `/client-data`, under keys starting with `webui.`, so they follow the user to any browser (64 KiB per value). Mirrored in `localStorage` only so the sign-in page can render before it is allowed to read them. |
| Everything else | Component signals. |

### 4.3 The live store

- The UI opens `EventSource("/api/v1/events")` and listens for events named `sync`. Each event's
  `data` is a `SyncResponse` and its `id` is the revision. The browser reconnects by itself and
  resumes from the revision it sends as `Last-Event-ID`.
- **Applying an update.** When `full` is set, replace everything. Otherwise:
  - replace each changed torrent and category whole, through `reconcile` so that only the fields
    that changed notify their subscribers;
  - delete everything listed in the `*_removed` fields;
  - replace the tag list when `tags` is present;
  - replace `transfer`.

  The reducer that does this is a pure function with unit tests.
- **Connection state** (connecting, live, reconnecting, signed out, daemon stopped) drives the
  sidebar's status dot. An `EventSource` cannot see HTTP statuses. When the stream closes, call
  `GET /auth/status` and `GET /app` to find out whether the session ended or the daemon went
  away. Then either go to sign-in or retry with backoff, passing `rev`.
- **Scale.** The target is 10 000 torrents, the number the library handles in one session.
  Filters, groups, sorts and sidebar counts are memos, each computed in one pass over the store.
  Lists are virtualized. There is no effect, timer or query per row, and relative times ("12 s
  ago") all tick from one shared clock.

### 4.4 Torrent semantics come from the daemon

- **States.** The API gives `TorrentState` plus the flags `stalled` (running but moving no
  payload) and `forced` (started regardless of the queue limits). `lib/torrent.ts` holds the
  mapping:

  | API state | Shown as | Colour |
  |---|---|---|
  | `downloading` | Downloading, or Stalled when `stalled` | `--brand` (stalled: `--muted-foreground`) |
  | `seeding` | Seeding, or Idle when `stalled` (nobody downloads from it: normal, not a problem) | `--ok` (idle: `--ok` at 45 %) |
  | `metadata` | Fetching metadata | `--warn` |
  | `checking_queued`, `checking` | Queued for check, Checking | `--warn` |
  | `moving` | Moving | `--warn` |
  | `queued` | Queued | `--muted-foreground` |
  | `held` | Held | `--muted-foreground` |
  | `stopped` | Stopped | `--subtle` |
  | `error` | Error, with the `error_kind` | `--danger` |
  | `unknown` | Unknown | `--subtle` |

  `forced` adds a "Forced" badge. The daemon's `stalled` filter covers both cases, so the
  sidebar offers Idle (`stalled_seeding`) and Stalled (`stalled_downloading`) instead; the
  Filter menu keeps the combined one as "Stalled or idle".
- **Filters.** The sidebar's status filters are the daemon's `TorrentFilter` values, with the
  daemon's meanings (`filter_matches` in `crates/urtorrentd/src/daemon/view.rs`). Some of these
  meanings are easy to get wrong: Downloading means *not complete*, whatever the state, and
  Stopped includes Held. The E2E suite checks every sidebar count against
  `GET /torrents?filter=`. Queued is a state, not a filter. If the UI offers it, it means
  `state == queued`.
- **Search** uses the daemon's matching: `GET /torrents/hashes?search=` (name, category, tag,
  tracker host, info-hash prefix; the hashes only, since the rows are in the live store) and
  `GET /torrents/files?search=` for files. Debounce the input, then intersect the returned
  hashes with the live store. Don't reimplement the matching in the UI.
- **Sessions.** The daemon ends the event stream when its login session ends, and an open
  stream keeps the session alive; the live store reports `signed_out` and the page returns to
  sign-in with "Your session ended".
- **Sizes** are the wanted totals the daemon reports. File indexes are the daemon's (it never
  lists padding files).
- **Deleting** always asks for confirmation. Deleting the files as well is a separate choice,
  shown in red.

### 4.5 Routing

`@solidjs/router` with history URLs at the root of the host: `/torrents`, `/torrents/<hash>`,
`/stats/...`, `/rss/...`, `/log`, `/settings/...`, `/setup` and `/sign-in`. Filters and search
go in the query string. The daemon answers unknown paths outside the API with `index.html` (5.1).

## 5. Serving (daemon side)

The maintainer decided this on 2026-09-24: the daemon serves the UI with axum, a reverse proxy
(Caddy) terminates TLS, and the daemon handles CORS. The UI is at `/` and the API at `/api/v1`,
on the same host and port. Release builds embed the UI, and `--web-ui <dir>` can serve a
directory instead (5.1). The serving code is daemon code
(`crates/urtorrentd/src/web.rs`, `api/cors.rs`, `build.rs`) and falls under the charter:
ADR 0008, Rust integration tests (`tests/web.rs`), and `docs/api.md` / `docs/settings.md` rows.

### 5.1 Routes and files

- `/api/v1/...` is the API, as today, and unknown `/api/...` paths stay JSON 404s.
- `/` is the UI, and every other path outside `/api/` belongs to it. The daemon serves the built file if one matches, and
  otherwise `index.html` for `GET` and `HEAD` (the single-page-app fallback). Hashed files under
  `/assets/` get `Cache-Control: public, max-age=31536000, immutable`. `index.html` gets
  `no-cache`.
- **Where the files come from.**
  - Release builds embed `frontend/dist` in the binary (cargo feature `web-ui`, turned on by
    `cargo xtask dist`). There is one file to deploy, as with qBittorrent's built-in WebUI.
  - `--web-ui <dir>` serves a directory instead. This covers qBittorrent's alternative WebUI,
    and the E2E suite runs a debug build of the daemon this way (7.4). It is a command-line
    flag and never an API setting. The static files are served without authentication, so an
    API setting would let any API user publish any directory to anyone.
  - With neither, the daemon is API-only. That is what `cargo xtask check` builds, and it needs
    no Node.
- **The UI's files are public.** They contain no secrets, and everything behind them needs a
  session. The `gate` guard still applies to them (banned addresses, the `Host` check).
- **Headers on UI responses.**
  - `Content-Security-Policy: default-src 'self'; frame-ancestors 'none'; base-uri 'none';
    object-src 'none'; form-action 'self'`, tuned when the code is built. No inline scripts. The
    E2E suite fails on any CSP violation.
  - `X-Frame-Options: DENY`. Together with `frame-ancestors 'none'`, this is qBittorrent's
    clickjacking protection, always on here.
  - `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

### 5.2 Behind a reverse proxy

The daemon speaks plain HTTP on `--api-listen` (loopback by default). Caddy terminates TLS and
forwards requests to it:

```
torrents.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

A deployment must get the following right. The README documents it, with this Caddyfile, when
the serving code lands.

- **`api_trusted_proxies`** lists the addresses the proxy connects from (`["127.0.0.1",
  "::1"]`). The daemon then sees the real client through `X-Forwarded-For` and
  `X-Forwarded-Host`, for bans, `api_auth_whitelist` and the `Host` check. **Without this
  setting, every client appears to come from the proxy's loopback address, and turning on
  `api_bypass_local_auth` would let the whole internet in.** So the daemon never exempts a
  request that carries forwarding headers from a peer that is not trusted, and logs a warning
  the first time it sees one.
- **`api_allowed_hosts`** includes the public name (`torrents.example.com`). The default is
  `localhost` only. IP addresses always pass.
- **CSRF protection keeps working.** It compares the authority of `Origin`
  (`torrents.example.com`) with the forwarded `Host`, not the scheme, so TLS termination does
  not affect it. Caddy passes `Host` through by default. A proxy that rewrites `Host` must send
  `X-Forwarded-Host` and be trusted.
- **Secure cookie.** When a trusted proxy sends `X-Forwarded-Proto: https`, the
  session cookie gets `Secure`. This is qBittorrent's `web_ui_secure_cookie_enabled`, automatic
  here.
- **The event stream** passes through Caddy unbuffered, because Caddy flushes
  `text/event-stream` at once. The daemon's keep-alive comment every 15 s keeps idle streams
  open through proxy timeouts. Other proxies may need buffering turned off (nginx:
  `proxy_buffering off`).
- **The UI is at the root of its host** (`/`, API at `/api/v1`; maintainer decision,
  2026-09-24). Proxy the whole host to the daemon, using a subdomain such as
  `torrents.example.com`. Mounting under a sub-path (`example.com/torrents/`) is not
  supported.

### 5.3 CORS

The UI itself never needs CORS. It is same-origin in production (the daemon serves it, behind
the proxy) and in development (Vite proxies `/api` to the daemon). The table lists what can still
break and how each case is handled.

| Situation | What happens today | Handling |
|---|---|---|
| The Vite dev proxy with `changeOrigin: true` | `Host` becomes the daemon's but `Origin` stays `localhost:5173`, so every POST gets `403 cross_origin`. | The dev proxy keeps `Host` (`changeOrigin: false`, Vite's default). `localhost` is in `api_allowed_hosts` by default. |
| A browser app on another origin (a second UI, a dashboard, the dev server without its proxy) | The daemon sends no CORS headers, so the browser hides every response. Preflights get `401` because they carry no credentials. | The opt-in setting `api_cors_origins` (below). |
| A proxy that rewrites `Host` | `403 cross_origin` or `host_not_allowed`. | Trust the proxy so the daemon reads `X-Forwarded-Host` (5.2). |
| TLS at the proxy | `Origin` is `https://x` and `Host` is `x`. | Nothing to do: the check compares authorities, not schemes. |

`api_cors_origins` (daemon):

- It is a list of exact origins (`scheme://host[:port]`), empty by default. There is no
  wildcard, because credentials are allowed.
- CORS is the outermost layer, so preflights (`OPTIONS` with `Access-Control-Request-Method`)
  are answered before authentication.
- Every response to a listed origin carries `Access-Control-Allow-Origin: <origin>`,
  `Access-Control-Allow-Credentials: true` and `Vary: Origin`. That includes error responses, so
  the client can read the `ErrorBody`.
- Preflights allow the API's methods and the `Content-Type`, `Authorization` and
  `Last-Event-ID` headers. Unlisted origins get no CORS headers.
- Listed origins pass the CSRF check.
- Cookies still reach only same-site origins (`SameSite=Strict`). A cross-site app
  authenticates with an API key (`Authorization: Bearer`) and reads the event stream with
  `fetch`, because `EventSource` cannot set headers.
- Tests: Rust tests in the daemon (preflights, error bodies with CORS headers, an unlisted
  origin, CSRF), plus one E2E spec that calls the API from a page on a second loopback origin,
  once from a listed origin and once from an unlisted one.

When this lands, `docs/settings.md` changes as follows:

- `alternative_webui_enabled` / `alternative_webui_path` become `--web-ui`.
- `web_ui_clickjacking_protection_enabled` becomes fixed, always on.
- `web_ui_secure_cookie_enabled` becomes automatic behind a trusted HTTPS proxy.
- `web_ui_custom_http_headers` stays unsupported, with a new reason: CORS is `api_cors_origins`,
  and other headers belong in the proxy.

## 6. Design

### 6.1 References

The mockups are in `.design/` at the repository root. That folder is gitignored and exists only
locally.

- `Login-html.zip`: the sign-in screen.
- `Torrents-html.zip`: the main screen.
- `Add_torrent_dialog-html.zip`: the add dialog (`AddTorrent.dc.html`).
- `Settings_Speed-html.zip`: Settings › Speed (`Settings.dc.html`). Its navigation, header,
  restart banner, rows and save bar are the pattern for every settings section.
- `Settings_Downloads-html.zip`: Settings › Downloads (`SettingsDownloads.dc.html`): path fields
  with a Browse button, a value with its switch, segmented choices, chip lists, a table.
- `Settings_Queue_share_limits-html.zip`: Settings › Queue & share limits
  (`SettingsQueue.dc.html`): the queue's slots and order, share limits with progress bars.
- `Settings_Connection-html.zip`, `Settings_BitTorrent-html.zip`,
  `Settings_Banned_addresses-html.zip`: Settings › Connection (`SettingsConnection.dc.html`),
  BitTorrent (`SettingsBitTorrent.dc.html`) and Banned addresses (`SettingsBans.dc.html`).
- `Settings_Watch_folders-html.zip`, `Settings_RSS-html.zip`, `Settings_Webhooks-html.zip`:
  Settings › Watch folders (`SettingsWatch.dc.html`), RSS (`SettingsRss.dc.html`) and
  Webhooks (`SettingsWebhooks.dc.html`): expanding cards that edit one item each.
- `RSS-html.zip`, `Log-html.zip`: the RSS screen (`Rss.dc.html`: feeds and rules in the
  sidebar, articles by age, one article) and the Log screen (`Log.dc.html`: levels and topics
  in the sidebar, the log by day, one entry with the last day by hour).
- `Settings_Statistics_GeoIP-html.zip`, `Settings_Security_API-html.zip`,
  `Settings_Engine-html.zip`, `Settings_About-html.zip`: Settings › Statistics & GeoIP
  (`SettingsStats.dc.html`), Security & API (`SettingsSecurity.dc.html`), Engine
  (`SettingsEngine.dc.html`) and About (`SettingsAbout.dc.html`): the daemon itself.

They are exports from a design tool: `*.dc.html` artboards at 1440×900, whose inline styles and
`<helmet><style>` block carry the exact values. `support.js` and `vendor/` only render them. To
view one, unzip it into a scratch directory outside the repository and serve it with
`python3 -m http.server`. Replicate the values in our components and never copy the markup.

The main screen links to a Stats artboard that has not been exported yet, and more mockups
may arrive in `.design/`. Build a screen that has no design from the same tokens
and primitives, at the same density. Never invent a new visual language.

`.design/` is not in git, so section 6.2 records its values. Once `app.css` exists it becomes the
source of truth, and 6.2 is kept in step with it.

### 6.2 Tokens (dark, the only theme designed)

Colours are CSS variables in `app.css` (Tailwind v4 `@theme inline`), with shadcn's names where
one fits:

| Token | Value | Use |
|---|---|---|
| `--background` | `#09090b` | Page, list |
| `--card`, `--popover`, `--sidebar` | `#0c0c0e` | Sidebar, detail panel, group headers, sign-in card |
| `--muted` | `#111113` | Row hover, pills, kbd |
| `--accent` (shadcn's hover surface) | `#18181b` | Nav and button hover, selected row |
| `--selected` | `#1f1f23` | Active nav and filter item |
| `--divider` | `#1f1f23` | Panel and bar borders |
| `--row-divider` | `#141416` | Lines between list rows |
| `--border`, `--input` | `#27272a` | Controls, tags, cards |
| `--border-strong` | `#3f3f46` | Checkboxes, the "no category" dot |
| `--foreground` | `#fafafa` | Text |
| `--foreground-2` | `#d4d4d8` | Button text, group headers |
| `--muted-foreground` | `#a1a1aa` | Secondary text, idle nav items |
| `--subtle` | `#808089` (the design's `#71717a`, lifted to pass AA 4.5:1 on the page, card, muted and hover surfaces) | Labels, counts, section headings |
| `--faint` | `#52525b` | Placeholders and chart axes only. It fails AA contrast for text. |
| `--primary`, `--primary-foreground` | `#fafafa`, `#09090b` (hover `#e4e4e7`) | The one primary button per view |
| `--ring` | `#71717a`, plus `0 0 0 3px rgb(250 250 250 / .08)` | Focus |
| `--brand` | `#3987e5`; the user can pick `#1baf7a`, `#9085e9` or `#eb6834` | Downloading, progress, pieces we have |
| `--ok` | `#1baf7a` | Seeding, complete |
| `--warn` | `#eda100` | Fetching metadata, checking, moving |
| `--destructive` / `--danger` | `#e66767` | Errors, delete |
| `--upload` | `#eb6834` | Upload rates, rare pieces |
| `--online` | `#0ca30c` | Connected, working tracker |
| Category palette | `#3987e5`, `#9085e9`, `#1baf7a`, then more from the same family | Category dots |

The design calls `--brand` "accent". It has a different name here because shadcn's `--accent` is
the hover surface. Hex values appear only in `app.css`. Components use tokens.

**Type.**

- Geist for text: 13px, line height 1.4, antialiased.
- Geist Mono with `tabular-nums` for every number, rate, hash and path.
- Sizes 10, 11, 12, 13, 15 and 20; weights 400, 500 and 600.
- Section headings: 11px, weight 500, uppercase, `letter-spacing: .04em`, `--subtle`.
- Detail title: 15/600. Sign-in title: 20/600, `letter-spacing: -.01em`.

**Metrics.**

| Element | Size |
|---|---|
| Top bars | 48px high |
| Sidebar | 224px wide |
| Detail panel | 420px wide |
| List row / group header | 40px / 32px |
| Nav item / filter item | 30px / 28px |
| Toolbar and icon buttons | 28px (sign-in: 40px) |
| Radii | Controls 6px; tags and kbd 4px; sign-in inputs 8px; sign-in card 14px |
| Dots | 6–7px |
| Progress bar | 4px |
| Progress ring | 18px (r 6.5, stroke 2) |

- **List row grid:** ring 20 | name | size 64 | rate 84 | ratio 48 | ETA 56 | category 88, with
  gap 12 and padding 0 16.
- **Sign-in card:** 400px wide, padding 32, shadow `0 24px 64px rgb(0 0 0 / .5)`, on a 48px grid
  (`#18181b`) that fades radially into the background.

**Icons.** Lucide at 13–15px, stroke 2 (2.5 for the logo mark and "+"). The logo mark is
`arrow-down-to-line` on a `#fafafa` tile: 22px with radius 6 in the sidebar, 40px with radius 10
on sign-in.

### 6.3 Layout and behaviour

- **Main screen (1280px and wider)** has three panes:
  - Sidebar: instance menu, search (⌘K), navigation, filters with counts (by status, category,
    tag and tracker), and a transfer footer.
  - List: title and count; Filter, Display and Add buttons; rows grouped by state, each group
    header with its count and summed rate.
  - Detail: breadcrumb (category › short hash) and start / stop / recheck / more; name, state
    pill and progress; properties; pieces and availability; transfer; trackers.
- **Narrower screens.** The artboards are 1440×900 only, so the smaller layouts are ours to
  design in the same language:
  - 1024–1279px: the detail panel becomes a sheet over the list.
  - Below 1024px: the sidebar becomes a sheet too.
  - Below 640px: rows show two lines (name; progress and rate) and the detail is full screen.
- **Keyboard.**

  | Key | Action |
  |---|---|
  | ↑/↓ or j/k | Move |
  | Shift | Extend the selection |
  | ⌘A | Select all shown |
  | Enter | Open |
  | Space | Start or stop |
  | Delete | Delete (asks first) |
  | / | Search |
  | ⌘K | Open the palette |

  ⌘-click and Shift-click select several rows, and a context menu on rows offers the bulk
  actions.
- **Accessibility.** Kobalte provides roles and focus management. Keep focus rings visible.
  Colour is never the only signal: every state has a label next to its dot. Text meets WCAG AA.
  Respect `prefers-reduced-motion`.

### 6.4 The designs against the API

These are the known differences. Resolve each as noted, never by faking.

| Mockup | API | Do |
|---|---|---|
| Sign-in shows the instance name, the version and "daemon reachable" | Only `GET /auth/status`, `POST /auth/login`, `POST /auth/setup` and `GET /openapi.json` are public. The name and version need a session. | Show reachability only (from `/auth/status`). The name and version never appear on the sign-in or setup screens (maintainer decision, 2026-09-24); the instance menu shows them after sign-in. `/auth/status` stays as it is. |
| "Set with `urtorrentd --set-password`" | The real command is `urtorrentd passwd --username <name>` (password on stdin). There is also the temporary password printed at start. | Use the real command. |
| "Stay signed in on this device" | The session length is the `api_session_timeout` setting. There is no per-login choice. | Leave it out. |
| No first-run screen | `setup_required` → `POST /auth/setup` (ADR 0007) | A setup card in the sign-in style: user name, and the password (8+ characters) twice. |
| "seedbox-01 ▾" suggests switching between daemons | One daemon per origin, because the daemon serves the UI | An instance menu: name, version, sign out, shut down. |
| Eight states, a finished torrent with no leecher among them as "Stalled" | 11 `TorrentState` values plus the `stalled` and `forced` flags | The mapping in 4.4: a seed nobody downloads from is Idle, only a download that gets no data is Stalled (maintainer decision, 2026-09-25). |
| One tag per row | Many tags | Show the first tag, then "+n". |
| Tracker filter by host, including "DHT only" | `tracker_hosts` in every list row (added for the UI), `GET /torrents?tracker=` | A torrent counts under each of its trackers' hosts; "No tracker" for `trackers_count == 0`; "Not working" as well while none of its trackers works. |
| Pieces chart ("terrain") drawn from random noise | `GET /torrents/{hash}/pieces` gives `states`, `availability` and `priorities` per piece | Bin the real data. "Rare" means a missing piece with availability ≤ 1, and the legend says so. |
| Limits line "↓ ∞ · ↑ 5.0 MB/s · ratio 5.0" | `download_limit`, `upload_limit` (`null` = unlimited), `share_limits` | As shown. Use ∞ only for `null`. |
| Link to Stats | Not designed yet | Wait for the design, or build from the tokens (6.1). |
| Add dialog: "Skip hash check" | Never offered (charter rule 1: nothing may claim data it has not verified) | Left out. |
| Add dialog: "Use category share limits" | Categories' `share_limits` (added for the UI): a torrent's `global` limits defer to its category's, then to the settings | The switch sends the torrent's limits as all `global`; off, the Ratio limit field is the torrent's own (empty: none) and it has no time limits. Without a category it reads "Use global share limits". |
| Add dialog: "Swarm: 186 seeds · 24 peers" | `swarm_seeds` / `swarm_leechers` on previews (added for the UI), kept after the metadata arrives; `null` when no tracker answered | "186 seeds · 24 leechers", or the connected peers while fetching, or "—". |
| Add dialog: tracker chips with ports | Tracker URLs can carry passkeys (rule 6) | Hosts only. |
| Settings: "Apply limits to µTP and overhead" switch | The engine always counts every byte of a peer connection, µTP and protocol messages included (`limit_utp_rate` and `limit_tcp_overhead` are fixed rows in `docs/settings.md`) | Left out: there is nothing to choose (maintainer decision, 2026-09-25). |
| Settings: "2 engine settings apply after a restart · Restart daemon" | `restart_required` in `GET /app`; `POST /app/restart` (added for the UI) shuts down gracefully and starts the same binary again | The banner and the button, after a confirmation. Sessions live in the daemon's memory, so a restart signs everyone out: the UI waits for the daemon, then shows sign-in. |
| Settings › Speed: the window "local to the daemon unless a time zone is set" | `alt_speed_schedule.time_zone` (`null` = the daemon's); `time_zone` in `GET /app` (added for the UI) | The zone picker's first entry is the daemon's zone by name. The status line, the week chart and "now" use the saved schedule in that zone. |
| Settings › Speed: "Also toggled from the toolbar" | `PUT /transfer/alt-speed`; the torrents screen has no such toolbar button | "Also switched by the schedule and `PUT /transfer/alt-speed`". |
| Settings › Downloads: "/data · 1.21 TB free of 4.0 TB" | `free_space` in the transfer state is the free bytes of the default save path's file system; there is no total | "/data · 1.21 TB free", and nothing while `free_space` is `null`. |
| Settings › Downloads: "2 torrents here now · 4.9 GB" under the download path | List rows' `content_path` and `completed` (verified bytes) | Counted from the live store: the torrents whose content is under that path now, and their verified bytes. |
| Settings › Downloads: "38 trackers · fetched 4 h ago · Fetch now" | `fetched_trackers` in `GET /app`; `POST /app/fetched-trackers/refresh` (added for the UI) with `fetched_trackers.fetching` | As shown, for the saved URL; "Fetch now" waits for an edited URL to be saved. |
| Settings › Downloads: category rows and "Add category" | `/categories` (`PUT` replaces a category, share limits included) | A dialog adds a category, or edits and removes one from its row, at once (not part of the page's draft). Editing reads the category first so its share limits are kept. |
| Settings › Downloads: an off switch next to a path | One nullable setting (`download_path`, `export_dir`, ...) | The switch sends `null`; the typed path stays in the field, also after saving, so turning it back on brings it back. Typing a path turns the switch on. |
| Settings › Queue: "Force-started torrents ignore the limits" | The library runs them whatever the limits but charges them a slot (Q26) | "Force-started torrents run whatever the limits, and take a slot." |
| Settings › Queue: slots held, "slow, still counted", "slot released (slow)", "0 B/s for 6 h" | Rows' `slow` (the queue's own flag, urtorrent 0.13.5), `forced`, `queue_position`, `last_activity` | Slots are counted from the live rows by the library's rules; "no data for 6h" only when both rates are 0. Slot capacities follow the draft, so an over-full kind shows how many are over before saving. |
| Settings › Queue: drag handles on the queue rows | `PUT /torrents/{hash}/queue-position` (urtorrent 0.13.5: one call, one re-plan) | Drag handles, no ↑ / ↓ (maintainer decision, 2026-09-25). From the keyboard: Space picks a row up, the arrow keys move it, Space drops it, Escape puts it back, each announced. The dropped order shows until the daemon's arrives. The first 10 running or waiting torrents are listed, then a count. |
| Settings › Queue: "Defaults — any torrent can use its own value or none, from its properties" | A torrent's `share_limits`, then its category's, then the settings (`daemon/tick.rs`) | "Defaults: a category or a torrent can set its own, or none". Rows are tagged `own` or `category` when those win. |
| Settings › Queue: "ratio at this rate in ~9 d", "no limits (tag keep)" | Rows' `ratio`, `uploaded`, `downloaded`, `completed`, `upload_rate`, `seeding_time`, `last_activity` | The limit reached first if things go on as they are, from the draft's defaults: seeding time is certain, the ratio is an estimate at the current upload rate ("at this rate"), inactive time only while nothing moves. "no limits" without a reason (the API has none). |
| Settings › Connection: "Test port", "Re-detect" | No such operations; `connection_status` comes from incoming connections | Left out. |
| Settings › Connection: "incoming 58% of connections", "61% of current peers are on TCP" | Session-wide peers are counted (`peers`, `connections`), not split by direction or transport; per-torrent peer lists would be an N+1 | "N peers connected"; no share by transport. |
| Settings › Connection: "Apply rate limits to µTP" | Fixed by the engine (`limit_utp_rate`) | Left out (as on Speed). |
| Settings › Connection: interface rows "VPN", "API only" | `GET /app/interfaces` has name, addresses, up; `GET /app` the addresses listened on | "listening" (including through `0.0.0.0` / `::`), "down", or nothing. |
| Settings › BitTorrent: "How your 148 peers were found" with a count per source | Live peers by source are per torrent only; `/stats/peers?dim=source` has peer traffic by source | The last day's peer traffic by how the peer was found, with what the draft's switches keep; a note when statistics are off. |
| Settings › BitTorrent: "Forced drops … 4 of your 148 peers today" | No session-wide count of unencrypted peers | Left out of the description. |
| Settings › BitTorrent: identity cards with peer-id prefixes | `GET /app` → `library` is the native user agent; the qbt profile is named by its versions | The native card shows `library`; the qbt card "qBittorrent 5.2.3 · libtorrent 2.0.14". No peer-id prefixes. |
| Settings › BitTorrent: bootstrap routers shown when none are set | `dht_bootstrap_nodes: null` = the identity's own (not listed by the API); `[]` = none | Chips only for our own list; "Use the identity's routers" goes back to `null`. |
| Settings › Banned addresses: Note and Added columns | `banned_ips` / `banned_ip_ranges` are plain lists | Address, kind, Unban. |
| Settings › Banned addresses: "automatic bans, 30 days", "connections refused today" | The peer log (`source`, `torrent`; added for the UI) holds 10 000 entries since the daemon started; refusals are not counted | "engine bans in the peer log"; no refusals figure. |
| Settings › Banned addresses: "Keep banned", "ban expired" | An engine ban is on one torrent for as long as it runs; nothing expires on a timer | "Ban everywhere" adds the address to `banned_ips`; unbans are the settings'. "Show older" pages through the log already loaded. |
| Settings › Watch folders: "scanned 4 s ago", "not mounted", "Picked up recently" | `GET /watch-folders` (added for the UI): each folder's last read and read error, and the last 100 files taken with their outcome | As shown: "read 4s ago", "cannot be read: …", and the pickups with what became of each. |
| Settings › Watch folders: "3 added this week" | The pickups are kept in memory since the daemon started | Counted from them: "in 7 days" once the daemon has run a week, else "since start". |
| Settings › Watch folders: "Scan now" | The folders are read every 2 s and a file is taken once still for 3 s | Left out: it would change nothing. The flow says "3 to 5 s". |
| Settings › Watch folders: category "Created if missing" | A folder's `category` is created by the add | A select of the categories there are (and the folder's own); new ones are made on Downloads. |
| Settings › RSS: "torrents from rules, 30 days" | Rules keep `last_match` only, not a count | "rules that took something, 30 days". |
| Settings › RSS: "A dry run is available per rule" | `GET /rss/rules/{name}/matches` exists; the RSS screen is W5 | Not said until the RSS screen offers it. |
| Settings › RSS: the next hour of polling | The daemon's rule: a feed is due its interval after its last refresh (failed ones too), at once when never refreshed; the per-host delay can push one back a little | Drawn from the draft's interval and each feed's `last_refresh`; off draws nothing but a note. |
| Settings › Webhooks: URLs in the list | Webhook URLs often carry a token (Discord, Sonarr's API key) | The list shows the origin and "/…"; the full URL only in its edit field (rule 6). |
| Settings › Webhooks: "Redeliver", "Payload of the last finished" | Deliveries kept their result only; `GET /webhooks/{id}/deliveries/{delivery}` and `.../redeliver` (added for the UI) keep and resend the payload | Redeliver on failed rows (once, same delivery id); the payload of the newest delivery that is not a test, else the test. |
| Settings › Webhooks: secret "Rotate" | A secret is never shown back | Rotate or Generate fills a new random one, shown until saved so the receiver can be given it; Remove unsigns. |
| Settings footer: "libtorrent 2.0.11" | `library` in `GET /app` is urtorrent's version | Show the library we run on. |
| Settings › Engine: "8 cores · 16 threads · AMD EPYC", "6.8.0 · io_uring available", "512 asked for · 2 231 in use", "/data · ext4 · NVMe · 4.0 TB · 1.21 TB free" | `GET /app/system` (added for the UI): the CPUs the daemon may use, the CPU model, kernel, memory, the open-file limit and use, the default save path's file system | "16 CPU threads" (no core count), the kernel with "io_uring" (the daemon runs on nothing else), the mount point and file system type, size and free space; no drive kind. |
| Settings › Engine: Running beside Saved, "Changed Sep 25 09:12", "Revert to running" | `running` and `restart_required_since` in `GET /app` (added for the UI) | As shown. A saved setting waiting for the restart is tagged "after restart"; an edit not saved yet keeps the unsaved mark. Revert saves the running values of what waits. |
| Settings › Engine: "Your service manager starts it again", "Needs a kernel with io_uring — yours has it" | `POST /app/restart` starts the same binary again in its own process; the daemon runs only with io_uring | "no service manager needed"; the io_uring sentence is left out. |
| Settings › Engine: "Restart when idle" | `POST /app/restart?when=idle`, `DELETE /app/restart`, `restart_waiting` in `GET /app` (added for the UI): idle is no torrent checking, moving or receiving data | The button, then "Waiting…" with "Call off". |
| Settings › Security: "A request, as configured" | `POST /auth/check` (added for the UI) | As shown, for this browser's own request; forwarding headers from a proxy that is not trusted show as a warning. |
| Settings › Security: the user name in a field beside "Change password" | `PUT /auth/credentials` takes both; `GET /auth/account` (added for the UI) has the user name | The name as text; a dialog changes both (the password twice). Every session ends, so the page signs in again. |
| Settings › Security: API key "created Sep 12 · last used 2 min ago from 10.66.0.9" | `GET /auth/account` (added for the UI): when the key was made (none for keys made before 0.14.0) and its last use since the daemon started | As shown. Regenerate and Delete ask first; a new key shows once, in a dialog. |
| Settings › Security: sessions and bans with "End", "Revoke", "Unban", "End all other sessions", "Firefox · via proxy" | `GET`/`DELETE /auth/sessions`, `DELETE /auth/sessions/{id}`, `GET /auth/bans`, `DELETE /auth/bans/{address}` (added for the UI) | As shown, the client named from its user agent ("Firefox · Linux"); "via proxy" is not recorded. Addresses with failed sign-ins short of a ban are listed too ("Forget"). Revoke deletes the API key. |
| Settings › Security: no row for browser origins | `api_cors_origins` | A row in the HTTP layer: "Browser origins allowed (CORS)". |
| Settings › Security: a list of allowed hosts without this page's host | The `Host` check would refuse the page | Refused before saving: the page's host (or a pattern that covers it) stays. |
| Settings › Security: cookie values "9f3c…e1" | `GET /app/cookies` has the values, often passkeys | Values longer than 6 characters are cut; the full value never shows once added. |
| Settings › Statistics: "97% of peers located by GeoIP", "146 of 148 peers matched to an AS right now" | Live peers are per torrent (an N+1); `GET /stats/geo` has peer traffic by country | "of peer traffic located, last day" from the country rows; the ASN count is left out. |
| Settings › Statistics: "112 torrents with history · 100 removed" | `removed` in `GET /stats` (added for the UI) | As shown. |
| Settings › Statistics: removed history "Review", "21.9 MB of the database" | No size per torrent; the statistics screen is W6 | "Delete all" (`DELETE /stats/removed`, added for the UI); no size, and no Review until W6. |
| Settings › Statistics: GeoIP "Reload now", "last read Sep 16 04:12" | Files are re-read when they change (checked every 2 s); `loaded` on each database (added for the UI) | No reload button (it would change nothing); "read" with its time. |
| Settings › About: "up to date" | No update check (rule 5) | Left out. |
| Settings › About: "Seen as" | The transfer state's `external_v4` / `external_v6` | As shown; "not known yet" until trackers or peers agree on one. |
| Settings › About: "Copy diagnostics", "Delete statistics", "API reference", "Web UI 0.12.0" | `GET /app`, `/app/system`, `/stats`; `DELETE /stats` (added for the UI); `GET /api/v1/openapi.json`; the UI's `package.json` version set at build time | Diagnostics carry versions, the machine, engine and network settings and counts, never an address, a path, a URL or a name. Deleting asks first; recording goes on. The reference opens the schema. |
| RSS: "Linux ISOs › guid 48213" above the article | A guid is often the article's URL, with a passkey | "Linux ISOs › article". |
| RSS: the torrent and link URLs of an article | They carry passkeys (rule 6) | The host and "/…"; a magnet link as the start of its info-hash. The article's page opens from the header's link button. |
| RSS: "Matches “rule”", the "Matches a rule" chip, rule counts "2", "off" | `matched_rule` on every article (added for the UI): the first enabled rule on its feed whose filters take it, its history aside | As shown; a rule's count is the articles kept it would take. |
| RSS: "Mark unread", Refresh and Mark all read for a folder or every feed | `unread` in `POST /rss/feeds/{id}/read`; `POST /rss/feeds/refresh` and `POST /rss/feeds/read` (added for the UI) | As shown. Mark all read is left out while a rule is chosen (its list is a dry run). |
| RSS: "Would be added as" with the rule's category, tags, save path | The rule's `add_options`, and the daemon's path rules | As shown, with when it starts; the save path as the daemon decides it (category, automatic management). |
| RSS: Download | The rule's options belong to the rule | The add dialog with the article's torrent: the user chooses how it is added. |
| RSS: "⋯" in the article header | Nothing to put there | Left out; a feed's and a folder's actions are on their menus in the sidebar. |
| RSS: feeds, folders and rules being added or edited | Not designed | The sidebar's "+" (a feed, a folder, a rule) and each row's menu (refresh, mark read, edit, rename, remove); a chosen rule is edited in the panel, beside the list of what it would take. |
| RSS: the description | HTML from the feed | Its text: tags dropped, entities decoded, never rendered (rule 6). |
| RSS: "14 auto-added" | `downloaded` on the articles kept | Counted from them. |
| Log: "About" topics (Trackers, Peers, Torrents, RSS, Webhooks, Settings, Daemon, Tracker list) and "Open torrent" | `topic` and `torrent` on every entry (added for the UI) | The daemon's topics: torrents, trackers, RSS, watch folders, webhooks, settings, sign-in, network, statistics, daemon. Peers are the peer log's (Settings › Banned addresses). |
| Log: announces, corrupt pieces and such in the list | The main log has what the daemon logs, not the engine's traffic | What there is. |
| Log: "×3" on a row, "Same message", "Recurring today" | Messages are compared whole, never parsed (rule 1) | A row is entries repeated back to back; the counts are of identical messages among those kept. |
| Log: "Reannounce", "Ban peer", "Open files" | Entries name a torrent, not a peer | Open torrent, and Reannounce on torrent and tracker entries. |
| Log: "kept in memory 4 000 entries" | The daemon keeps its last 10 000 | How many are kept now, and since when. |
| Log: "Following" | `GET /log?after=` every 2 s | New entries come in at the top; reading an entry holds the view ("paused · 2 new entries") until Follow. |
| Log: Export | — | A text file of the entries shown, oldest first, in UTC. |
| Add dialog: "Watch folder" tab | The `watch_folders` setting (path, subfolders, what happens to an added file, add options) | The tab appends a watch folder with the dialog's options (`PATCH /settings`); the right column lists the files it will pick up. |

## 7. Testing

End-to-end tests are required (maintainer decision, 2026-09-24). Every screen and every flow has
them, and they run against real daemons in a real browser.

### 7.1 Types

`tsc --noEmit` checks the code against the types generated from `openapi.json`. An API change
that breaks the UI fails here, in the daemon's own PR.

### 7.2 Unit tests

Vitest, in Node. They cover the pure logic: the live-store reducer, filters, grouping, sorting,
formatting and parsing of units, the state mapping and error handling. Fixtures are typed with
`satisfies components["schemas"][...]`, so they cannot drift from the schema. Components get no
tests under DOM emulation. Their behaviour is tested in the browser (7.4).

### 7.3 Coverage

`src/api/coverage.test.ts` checks that every operation in `openapi.json` is either called by the
UI or listed with a reason in `frontend/coverage.md`. For example, `GET /sync` is listed because
the UI uses the event stream instead. This is the UI's version of charter rule 3.

### 7.4 End to end

Playwright, in `e2e/`.

- **Real daemons.** `npm run e2e` first runs `cargo build -p urtorrentd` and `vite build`; the
  harness (`e2e/daemon.ts`) builds nothing itself. Each test that asks for one gets its own
  `urtorrentd` from `target/debug/`, with:
  - a temporary data directory;
  - `--api-listen 127.0.0.1:<free port>`;
  - `--web-ui dist`;
  - first-start settings (next bullet).

  The harness waits for `GET /auth/status` to answer, sets the credentials with
  `POST /auth/setup` and talks to the API with an API key; at the end it stops the daemon with
  SIGTERM (the shutdown endpoint's path; SIGKILL if it hangs). The browser opens the daemon's
  own origin, so it gets the same files, headers, CSP and fallback as production.
- **Offline.** The first-start settings listen on `127.0.0.<n>`, turn DHT and LSD off with no
  bootstrap nodes, and save into the temporary directory, as `crates/urtorrentd/tests/common`
  does. A fixture routes every browser request and fails the test on any host that is not
  loopback.
- **First-start settings.** The defaults turn the DHT on with public bootstrap nodes, so every
  daemon starts with `--initial-settings <file.json>` (W0): settings for the first start of a
  data directory, ignored once settings are stored. Never start a test daemon without it.
- **Real transfers.** A second daemon (the seeder, on `127.0.0.<n+1>`) is driven only through
  its API. The UI's daemon downloads from it, with the seeder's address given through
  `POST /torrents/peers`, since there is no DHT or tracker. The assertions go through the UI:
  progress reaches 100 %, the state becomes Seeding, the pieces chart is full, and the counters
  equal the API's. `e2e/torrent.ts` generates the `.torrent` files (random data, bencode,
  SHA-1). Tests never download anything from outside.
- **Sign-in.** One spec drives first-run setup, sign-in, wrong passwords, bans and session
  expiry through the UI. All other specs start signed in: the fixture calls `POST /auth/setup`
  and hands the cookie to the browser context. Never use `api_bypass_local_auth` in UI tests,
  because it hides auth bugs.
- **Assertions** use roles, labels and text (`getByRole`, `getByLabel`). Use `data-testid` only
  where nothing accessible fits, and never select on Tailwind classes. Use web-first assertions
  and `expect.poll` with timeouts that fit the work, never a fixed sleep.
- **Accessibility.** `@axe-core/playwright` runs on every screen. A violation fails the test.
- **Scale** (tagged `@slow`, W7). The test adds 10 000 magnets through the API: random info-hashes,
  no trackers, DHT off, so they all wait in `metadata`. The list must render, scroll, filter and
  search within set time budgets.
- **Serving.** Specs cover:
  - the fallback, the cache headers and the CSP (no violation reported on any screen);
  - the whole app behind a local forwarding proxy that acts like Caddy (it keeps `Host` and adds
    `X-Forwarded-*`);
  - CORS from a second loopback origin (5.3).
- **Browsers.** Chromium runs on every CI run. Firefox and WebKit run in the full suite
  (`npm run e2e:all`) before a release.
- **Menus hand focus back.** A Kobalte menu returns focus to its trigger when its closing
  animation ends. Before typing into something else, wait for the menu to be gone
  (`expect(page.getByRole("menu")).toHaveCount(0)`), or the keys land on the trigger.
- **Needs.** io_uring (like the daemon's own tests), Rust, and Playwright's browsers, installed
  once with `npx playwright install chromium`. That download happens at install time, never
  during a test.

### 7.5 Daemon tests

The serving code (5.1–5.3) is tested by Rust integration tests in `crates/urtorrentd/tests/`,
like every other daemon feature.

## 8. Conventions

- **TypeScript:** `strict` with `noUncheckedIndexedAccess`. No `any`, and no `!` on API data.
- **Solid.**
  - Never destructure props. Use `splitProps` and `mergeProps`.
  - Read signals inside JSX, memos and effects, never once at component setup.
  - Use `<For>`, `<Index>`, `<Show>` and `<Switch>` for lists and conditions.
  - Derive values with `createMemo`. Never copy state into other state with `createEffect`.

  `eslint-plugin-solid` enforces most of these.
- **Components.** `src/components/ui/` is our code once copied. Restyle a primitive there, never
  by wrapping it. Style with Tailwind classes, merge them with `cn()`, and build variants with
  `cva`. Use inline `style` only for computed geometry (widths, chart paths).
- **File names** are kebab-case (`torrent-list.tsx`). Component names are PascalCase.
- **Text.** Sentence case, short. Use the API's words: Start and Stop, not Resume and Pause. An
  error toast shows the daemon's message and what to do next.
- **Formatting** goes through `lib/format.ts`.
  - Sizes and rates use decimal units by default (`6.3 GB`, `8.1 MB/s`), as the design does.
    Binary units are a preference.
  - Piece sizes are always binary (`4 MiB`).
  - Times are in the viewer's time zone, and relative when recent.
- **Licence.** Every source file starts with the charter's SPDX header (charter section 7). A
  file copied from solid-ui also keeps solid-ui's copyright lines (MIT: "shadcn" and
  "Stefan E-K") below ours, and the root `NOTICE` names solid-ui once.
- **Versioning.** The UI is released with the daemon: one version, one `CHANGELOG.md`, with UI
  lines starting "Web UI:".
- **Commits.** A daemon change the UI needs (code, `openapi.json`, docs, tests) is its own
  commit, landing before the UI commit that uses it.

## 9. Commands

- `npm ci`: install. The `prepare` script generates `src/api/schema.d.ts`.
- `npm run dev`: Vite on `localhost:5173`. It proxies `/api` to `URTORRENTD_URL` (default
  `http://127.0.0.1:8080`) and keeps `Host` (5.3).
- `npm run generate`: generate the types from `../openapi.json`.
- `npm run check`: generate, then `tsc`, eslint, `prettier --check`, vitest and `vite build`.
- `npm run e2e`: `vite build`, `cargo build -p urtorrentd`, then Playwright in Chromium.
  `npm run e2e:all` runs Firefox and WebKit too. Install the browsers once with
  `npx playwright install chromium` (add `--with-deps` on a fresh machine).
- From the repository root:
  - `cargo xtask web`: `npm ci` if needed, then check and e2e.
  - `cargo xtask dist`: build the UI, then `cargo build --release --features web-ui`.

  `cargo xtask check` stays free of Node.
- CI: the `web` job (Node 22, the Rust toolchain, both repositories side by side because the
  daemon needs `../urtorrent`, Playwright's Chromium) runs `cargo xtask web`.

**Definition of done** for a UI change:

- `npm run check` and `npm run e2e` pass;
- new behaviour is covered end to end, and axe reports nothing;
- `coverage.md` is current;
- `CHANGELOG.md` has a line;
- for a visual change, the PR has screenshots next to the mockup.

## 10. Milestones

Each milestone ends with its end-to-end tests green.

- **W0 Foundations** (done).
  - Daemon: `--initial-settings`; serving the UI (5.1: `--web-ui`, the `web-ui` feature,
    headers, fallback) with ADR 0008; `api_cors_origins`, and the `Secure` cookie behind a
    trusted HTTPS proxy (5.2, 5.3); the settings rows updated; README deployment notes with a
    Caddyfile.
  - UI: the package, tokens, fonts, solid-ui primitives, generated types, the client, lint and
    unit tests; the E2E harness with a first spec (the app loads from the daemon, offline); the
    CI job and the xtask commands.
- **W1 Sign-in and shell** (done). Setup, sign-in, sign-out, expiry and bans. The shell (sidebar,
  navigation, footer, instance menu). The live store with its connection states.
- **W2 Torrents** (done). The virtualized, grouped list. Filters with counts (status,
  category, tag, tracker). Search. Selection and bulk actions. The detail panel as designed.
  The add dialog as designed: links, `.torrent` files or a watch folder, the daemon's preview
  of each source with per-file choices, and every option. Delete. Keyboard shortcuts.
- **W3 One torrent in depth.** Files (tree, priorities, rename). Peers (with GeoIP). Trackers
  and web seeds (edit). Pieces. Limits and share limits. Location and download path. Managing
  categories and tags.
- **W4 Settings.** Every settings group, security (credentials, API key), webhooks, watch
  folders and the alternative-limits schedule. Transfer limits and the alternative-limits
  switch. The main and peer logs. Done so far: the settings navigation and frame, the restart
  banner (`POST /app/restart`), Downloads (locations with the path a new torrent takes,
  category paths, add options, skipped file names, `.torrent` exports, trackers for new public
  torrents with the fetched list), Speed (global and alternative limits, the switch, the
  schedule with its week chart, the connection budget) and Queue & share limits (the limits
  with the slots they hand out and the queue's order, reordered by dragging, share limits with
  the seeding torrents closest to one), Connection (reachability, listening, interfaces,
  transports), BitTorrent (discovery with the last day's traffic by source, bootstrap routers,
  encryption, identity), Banned addresses (the list, bans per day, the peer log), Watch folders
  (each folder's options and standing, the files picked up), RSS (polling with the next hour
  planned, rules and feeds) and Webhooks (health, editing, deliveries with redelivery, the
  payload), Statistics & GeoIP (recording and retention with what is on disk, the opt-in scrape,
  removed torrents' history, the GeoIP files), Security & API (how a request is seen, the login
  and the API key, sessions and sign-in bans, the HTTP layer, the cookie jar), Engine (the
  machine, tuning beside what runs, restarting now or when idle) and About (the instance,
  diagnostics, deleting statistics, shutting down) as designed.
  The Log screen: the main log by day with its levels and topics, one entry with its torrent,
  following, export.
- **W5 RSS** (done). Folders, feeds, articles, and rules with their matches: the RSS screen as
  designed, with feeds, folders and rules managed from its sidebar and a rule edited beside
  what it would take.
- **W6 Statistics.** Traffic over time, seeding days, rankings, the timeline, places,
  breakdowns and idle seeds (uPlot).
- **W7 Finish.** The ⌘K palette, small screens, the full browser matrix, and the 10 000-torrent
  budgets.

## 11. Decisions and open questions

### Decided by the maintainer (2026-09-24)

- **Stack:** SolidJS, shadcn components, Tailwind, Lucide and Vite, with small libraries added
  as needed (section 2).
- **End-to-end tests are required** (section 7).
- **The daemon serves the UI** with axum. Release builds embed it, and `--web-ui <dir>` serves
  a directory instead. Caddy or another reverse proxy terminates TLS. The daemon handles CORS
  (section 5).
- **Paths:** the UI is at `/` and the API at `/api/v1`. Mounting under a sub-path is not
  supported.
- **Sign-in shows no name or version.** The sign-in and setup screens never show the instance
  name or the daemon version, and `GET /auth/status` stays as it is.

### Still open (defaults assumed)

- **Light theme.** Not designed yet; the tokens make it possible. Default: dark only.
- **Solid 2.0.** Default: stay on 1.9 until its ecosystem moves.
