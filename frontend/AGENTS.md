# AGENTS.md: the web UI

Guide for coding agents working on `frontend/`, the web UI of urtorrentd. Read the repository's
[`AGENTS.md`](../AGENTS.md) first. It is the project charter, and its rules bind this directory
too (section 1 restates them for the UI). This file adds what is specific to the UI.

Status (2026-09-27): W0, W1, W2, W3 and W5 are done: sign-in, first-run setup, the shell, the
torrents screen and the add dialog, one torrent in depth, and the RSS screen, as the mockups
have them. W4 has every settings section (Downloads, Speed, Queue & share limits, Connection,
BitTorrent, Banned addresses, Watch folders, RSS, Webhooks, Statistics & GeoIP, Security & API,
Engine, About) and the Log screen. W6 has every Stats report: Overview, Trackers, Peers & geo,
Idle seeds and Timeline. W3 has the detail panel's tabs (Files, Peers, Trackers, History,
Options), several torrents at once (the panel, the selection bar, the context menu and its
keys), the move, remove, share limits, folder and piece hashes dialogs, and categories and tags
managed from the sidebar. RSS rules are edited in the designed rule dialog. W7 has the ⌘K
palette, the light theme and the phone screens as designed. What has no design yet is in 6.5.
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
      theme.ts          the theme: dark, light or the system's (6.2)
    components/
      ui/               shadcn primitives from solid-ui, restyled to the tokens; our code now
      *.tsx             shared pieces: progress ring, status dot, kbd, empty state, the folder
                        dialog behind every Browse (folder-picker.tsx; folder-paths.ts)
    features/           one folder per area, following the API's groups
      auth/             the session (auth.tsx), first-run setup, sign-in
      shell/            the signed-in gate and the page frame (protected.tsx), the live store
                        (live.tsx), sidebar (sidebar.tsx; its rows in sidebar-items.tsx,
                        categories and tags in organize.tsx), navigation, transfer footer,
                        instance menu, the ⌘K palette (palette.tsx; palette-view.ts), a
                        phone's tab bar (tab-bar.tsx), the connection bar
      torrents/         the screen (torrents.tsx), the list, filters and sort (view.ts), the
                        detail panel (detail-panel.tsx: the header, the tabs, the Overview),
                        pieces (pieces.ts), detail/ (the tabs: Files with files.ts, Peers,
                        Trackers and web seeds with trackers.ts, History with history.ts,
                        Options with options.ts, the draft's model, share-fields.tsx), several
                        at once (bulk.ts, bulk-panel.tsx: the panel and the selection bar;
                        row-menu.tsx: the context menu), the dialogs (torrent-dialogs.tsx
                        opens them: remove in delete-dialog.tsx with removal.ts, move in
                        move-dialog.tsx with move.ts, share-limits-dialog.tsx), add/ (the
                        dialog, its sources and previews, form.ts), actions
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
                        folders, rules), the article panel, the rule dialog and the rule's
                        summary (rule-dialog.tsx; rule-form.ts), feed dialogs, the shared
                        queries (data.ts), view.ts
      log/              the Log screen (log.tsx): its sidebar sections (sidebar.tsx: levels,
                        topics), the shared log query (use-log.ts), view.ts
      stats/            the Stats screen: Overview (overview.tsx; view.ts), Trackers
                        (trackers.tsx; trackers-view.ts), Peers & geo (peers.tsx;
                        peers-view.ts, the map in map.tsx on world.ts), Idle seeds (idle.tsx;
                        idle-view.ts) and Timeline (timeline.tsx; timeline-view.ts); the
                        reports in the sidebar (sidebar.tsx), the range from the URL
                        (range.ts), the queries (data.ts), uPlot time series (chart.tsx),
                        cards, figures and the torrent picker (parts.tsx)
  e2e/
    daemon.ts           starts and stops real daemons, one per test that asks (7.4)
    torrent.ts          makes .torrent files for tests (bencode, SHA-1)
    servers.ts          a page on another origin (CORS), a Caddy-like forwarding proxy
    fixtures.ts         Playwright fixtures: daemons, a signed-in page, the offline and CSP guard
    mmdb.ts             writes GeoIP files for tests (MaxMind DB, country records)
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
| Everything else from the API (detail tabs, settings, RSS, logs, statistics) | TanStack Query, one key per resource. A tab refetches on an interval only while it is visible (peers, files, pieces: every 2 s; trackers every 5 s). A mutation invalidates the keys it changes. |
| View state: section, filters, search, selection, open tab | The URL, so reload, back and shared links work. |
| Preferences: columns, grouping, sort, accent, units, panel sizes, theme | `/client-data`, under keys starting with `webui.`, so they follow the user to any browser (64 KiB per value). Mirrored in `localStorage` only so the sign-in page can render before it is allowed to read them. |
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
  | `checking_queued`, `checking` | Queued for check, Checking (with how far, from `pieces_checked`) | `--warn` |
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
- `Stats-html.zip`, `Stats___Trackers-html.zip`: Stats › Overview (`Stats.dc.html`: figures
  against the range before, the transfer rate, rankings and breakdowns, idle seeds, the newest
  events) and Stats › Trackers (`StatsTrackers.dc.html`: each host's traffic and announces,
  traffic by tracker, announce problems). The Overview artboard has the older, roomier shell;
  both are built at the Trackers artboard's density, which is the current shell's.
- `Peers__geo-html.zip`, `Stats___Idle_seeds-html.zip`, `Timeline-html.zip`: Stats › Peers &
  geo (`Peers.dc.html`: the world map with a curve to each place, the peers, by country, how
  they connect), Idle seeds (`StatsIdle.dc.html`: size against value, the least valuable first
  with a selection to stop, keep or remove) and Timeline (`Timeline.dc.html`: events by kind,
  one lane per torrent, the feed by day, what needs attention).
- `Detail___Files_tab-html.zip`, `Detail___Peers_tab-html.zip`, `Detail___Trackers_tab-html.zip`,
  `Detail___History_tab-html.zip`, `Detail___Options_tab-html.zip`: the detail panel's tabs
  (`MainFiles.dc.html` and the others, the Overview being `Torrents-html.zip`'s panel): the
  file tree with priorities, the peers, trackers and web seeds, the seeding days and the last
  day's traffic, and the options saved as one draft.
- `Bulk_selection__context_menu-html.zip` (`MainBulk.dc.html`): several torrents chosen: the
  panel that acts on all of them, the selection bar over the list, the rows' context menu with
  its keys.
- `Dialog___move_content-html.zip`, `Dialog___remove_torrents-html.zip`,
  `Dialog___choose_folder-html.zip`, `Dialog___RSS_rule_editor-html.zip`: the move
  (`DialogMove.dc.html`), remove (`DialogDelete.dc.html`), folder (`DialogDirectory.dc.html`)
  and rule (`DialogRule.dc.html`) dialogs.
- `API_key_shown_once-html.zip`, `Edit_category-html.zip`, `Add_feed-html.zip`: the new API
  key (`DialogApiKey.dc.html`), a category (`DialogCategory.dc.html`) and a feed
  (`DialogFeed.dc.html`) dialogs.
- `Command_palette__K-html.zip` (`CommandPalette.dc.html`): the ⌘K palette over the torrents
  screen: torrents, files across torrents and commands, with scopes.
- `Color_tokens___dark__light-html.zip` (`Palette.dc.html`): every token in both themes, and
  the torrents screen in light.
- `Torrents___phone-html.zip`, `Torrent___phone-html.zip` (`MobileList.dc.html`,
  `MobileDetail.dc.html`): the list and one torrent at 390×844, with the tab bar.

They are exports from a design tool: `*.dc.html` artboards at 1440×900 (the phone ones at
390×844), whose inline styles and
`<helmet><style>` block carry the exact values. `support.js` and `vendor/` only render them. To
view one, unzip it into a scratch directory outside the repository and serve it with
`python3 -m http.server`. Replicate the values in our components and never copy the markup.

More mockups may arrive in `.design/`. Build a screen that has no design from the same tokens
and primitives, at the same density. Never invent a new visual language.

`.design/` is not in git, so section 6.2 records its values. Once `app.css` exists it becomes the
source of truth, and 6.2 is kept in step with it.

### 6.2 Tokens

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

**The light theme** (`Color tokens — dark & light`) is `:root[data-theme="light"]` in `app.css`:
the zinc scale reversed, panels (`--card`, `--sidebar`) on `#fafafa` beside a `#ffffff` list,
`--muted` `#fafafa`, `--accent` `#f4f4f5`, `--selected` and `--divider` `#e4e4e7`, `--border`
`#d4d4d8`, text `#09090b` / `#3f3f46` / `#52525b`, `--primary` `#18181b`. The design's
semantic colours keep 3:1; text must pass AA, so they are darkened just enough for 4.5:1 on the
page, card and hover surfaces: download `#2670c8` (design `#2a78d6`), upload `#bc4d21`
(`#d95926`), seeding `#0c7f57` (`#0e8f62`), attention `#a26000` (`#b26a00`), error `#cf3636`
(`#d03b3b`), captions `#6b6b74` (`#71717a`); connected is `#007a00` as designed. Seeding days
get darker, not lighter, with more. A switch is grey when off with a white thumb (`--switch-thumb`).
The palette's chosen row and scope are `--highlight` (`#27272a` dark, `#e4e4e7` light).

`lib/theme.ts` sets `data-theme` before the first render: the viewer's choice (dark, light, or
the system's, the default), kept in this browser for the first paint and the sign-in page, and
in `/client-data` (`webui.theme`) so it follows the user; after sign-in the daemon's wins. It is
chosen from the instance menu (Theme) or the palette. uPlot charts copy colours, so they are
built again when the theme changes.

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

**Icons.** Lucide at 13–15px, stroke 2 (2.5 for "+"). The logo mark is one stroke that rises
in a U and runs on into a ring round it, each end tucked behind the other (the maintainer's
artwork, 2026-09-27), drawn as SVG in the text colour (`components/logo.tsx`): 22px in the
sidebar, 40px on sign-in, 56px on About. Its geometry, measured from the artwork, is a
362-unit box centred on the ring: the ring's centre line at 164.5, strokes 33 wide, the U's
legs at ±78.5 with rounded ends centred at y −85 and 14.5, and 13-unit gaps where the ends
tuck in. `public/favicon.svg` draws the same, dark or light as the browser is.

### 6.3 Layout and behaviour

- **Main screen (1280px and wider)** has three panes:
  - Sidebar: instance menu, the Search button that opens the palette (⌘K), navigation,
    filters with counts (by status, category, tag and tracker), and a transfer footer.
  - List: title and count; Filter, Display and Add buttons; rows grouped by state, each group
    header with its count and summed rate.
  - Detail: breadcrumb (category › short hash) and start / stop / recheck / more, then tabs
    (`?tab=`, kept while another torrent is picked). Overview: name, state pill and progress;
    properties; pieces and availability; transfer; trackers. Files, Peers, Trackers, History and
    Options name the torrent small at their top. The Options draft lives with the panel, so a
    switch of tab keeps it; leaving the torrent with it unsaved asks first.
  - Several chosen: the panel acts on all of them (figures, actions, the queue, what to set for
    all), a bar floats over the list (start, stop, recheck, category, tags, queue, remove), and
    every row shows its box. The single torrent's panel stays mounted underneath, so its draft
    outlasts the multi-selection.
- **Narrower screens.** The artboards are 1440×900 only, so the smaller layouts are ours to
  design in the same language:
  - 1024–1279px: the detail panel becomes a sheet over the list.
  - Below 1024px: the sidebar becomes a sheet too.
  - Below 640px, a phone (`Torrents — phone`, `Torrent — phone`): the header is 52px (menu,
    title with "instance · N torrents", one Filter menu that holds Display too), status chips
    under it (All, then the statuses that have torrents), 60px rows (the name over size, ratio
    and time left; the rate, or how far it is, on the right; the box only while several are
    chosen), the transfer line and a tab bar (Torrents, Stats, Add, Search, Settings; RSS and
    Log are in the menu). One torrent takes the whole screen: back, its breadcrumb and "more",
    then the state with its rates, the pieces, four figures and the properties, and Stop /
    Start, Recheck, Files and Peers below; Trackers, History and Options are in "more", and
    back from a tab returns to the overview. Other pages reflow: headers put what does not fit
    on a second line, wide tables scroll in their cards, and the Peers & geo map, the idle
    seeds scatter and the timeline's lanes are left out.
- **Keyboard.**

  | Key | Action |
  |---|---|
  | ↑/↓ or j/k | Move |
  | Shift | Extend the selection |
  | ⌘A | Select all shown |
  | Enter | Open |
  | Space or S | Start or stop |
  | ⇧F | Force start |
  | R / A | Recheck / reannounce |
  | L / M | Share limits / move (dialogs) |
  | ⌘C | Copy the magnet links |
  | Delete or ⌫ | Remove (asks first) |
  | / or ⌘K | Open the palette (anywhere) |
  | , | Settings (anywhere) |
  | ⌥S | Switch the alternative limits (anywhere) |
  | ? | The keyboard shortcuts (anywhere) |
  | ⌘V | Add the magnet link, URL or `.torrent` pasted (anywhere) |

  ⌘-click and Shift-click select several rows (so does a row's box), and a context menu on
  rows offers the bulk actions with these keys beside them.
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
| Downloads › category dialog: "Renaming is not supported by the API", "Relative to the default save path → /data/movies", "global (/data/incoming)", "moves the 4 automatically managed torrents … Tears of Steel stays" | `/categories` has no rename; the daemon's path rules; the live store's rows (`category`, `auto_management`) | As shown: the name read-only, the resolved path, the global download path (or "none"), and what a path change moves counted from the live store, the manual ones named (two or more counted). |
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
| Security › new API key: "Send it as Authorization: Bearer urt_k1_9f3c…6e7f", "I have copied it somewhere safe" | The key is in the answer to `POST /auth/api-key` only | As shown; Done waits for the box, which Copy ticks; "The old key stopped working just now" only when one was replaced. |
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
| RSS: feeds and folders being added or edited | Not designed | The sidebar's "+" (a feed, a folder, a rule) and each row's menu (refresh, mark read, edit, rename, remove). A new rule opens the rule dialog; a chosen rule shows its summary beside the list of what it would take, with Edit rule. |
| RSS › rule dialog: "Matches right now · GET …/matches · dry run", "excluded by must not contain: beta", "already taken" | `GET /rss/rules/{name}/matches` is the saved rule's; `POST /rss/dry-run` (added for the UI) is the rule as typed: every article with `take`, `taken` (a rule added it already) or `filtered` and why | The rule as typed, asked again as typing settles, with the daemon's reasons; a bad expression shows the daemon's error. The dialog's open state is in the URL (`?rule=…&edit=1`). |
| RSS › rule dialog: "PUT /rss/rules/{name} · runs over its feeds' articles at once when auto-download is on", Start "Stopped / Running / Default", Save path "follow category" | `rss_auto_download`; `add_options.stopped`; the daemon's path rules | Whether auto-download is on, said; Start "Stopped / Started / Default"; an empty save path shows where it goes (the category's). |
| Choose a folder: "New folder" | No operation makes a directory; the engine makes a missing folder when content goes there | Left out; typing a path that does not exist is allowed, and the dialog says it is made then. |
| Choose a folder: "1.21 TB free of 4.0 TB", "4 items", "writable" / "read-only" | `GET /fs/file-system` and `writable` / `entries` on `GET /fs/directory` (added for the UI; entries counted up to 1 000) | As shown ("1,000+ items" past the count). A click chooses a row, a second click or a double-click opens it; a path that does not exist opens at its nearest parent. |
| Move content: "Save path — moves now if the torrent is complete; otherwise applies when it finishes" | `POST /torrents/location` (changed for the UI): the content moves now, except an incomplete torrent's in its download path, which goes on completion | Said as the daemon does it, with Now and After for one torrent; several at once too. Download path moves partial files now, and clearing it sends them to the save path. |
| Move content: "/mnt/fast · 412 GB free · same file system as the download path, so the move is a rename" | `GET /fs/file-system` for the typed path and for where the content is now (mount points) | As shown; "another file system: the files are copied" otherwise (the library renames or copies). |
| Remove: "Frees 18.6 GB", "It stays selected because you chose it explicitly", "POST /torrents/delete · statistics history is kept" | Rows' `completed` (verified bytes) and `content_path` | "Deletes 18.6 GB downloaded under …" (verified bytes; what is on disk can differ); kept ones are named ("They go too, since you chose them"); "Statistics keep their history". Removing tells the trackers (the library sends `stopped`). The actions are named Remove, as the designs do. |
| Several chosen: "Avg ratio", "Share limits Global / ∞ / Own…", "Upload limit mixed" | Rows' `ratio`, `share_limits`, `upload_limit` | The mean of the ratios known; Global and ∞ apply at once, Own… opens a Share limits dialog (not designed: the Options rows); a value the torrents do not share shows as mixed, and a typed limit applies on Enter. |
| Context menu: S, ⇧F, R, A, L, M, ⌘C, ⌫; "Download .torrent", "Open in Stats" | — | The same keys work in the list. Download .torrent for one torrent with metadata; Open in Stats opens its Timeline. |
| RSS › feed dialog: "Fetched · “Debian CD images” · 88 articles · cookies for cdimage.debian.org will be sent" | `POST /rss/feeds/probe` (added for the UI): the URL fetched and read as refreshes do, nothing kept; the cookie jar (`GET /app/cookies`) | As shown, once typing settles, or the daemon's error; the cookies line when the jar has one for that host (never a value). |
| RSS › feed dialog: "Run download rules on its articles now" | `skip_existing` on `POST /rss/feeds` (added for the UI): the first refresh's articles skip the rules | Ticked by default (as before: a new feed's articles go through the rules); unticked, only later articles can be downloaded. Disabled, and said, while auto-download is off. |
| RSS › feed dialog: Folder as a select | The daemon makes a folder that does not exist | A field with the folders as suggestions, so a new one can be typed. The refresh interval is Global (the setting, in minutes) or Own. |
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
| Stats: "▲ 12% vs previous 7 days" | `/stats/transfer` for the range and for the one before | The same range one length earlier (Today: yesterday by this time); "—" when nothing was recorded then; nothing to compare for All. |
| Stats: Free space "▼ 48 GB this week · 4.0 TB total" | `free_space` is now only (no history); `GET /app/system` has the file system's size | Free now "of 4.0 TB on /data"; no change over time. |
| Stats: Transfer rate "30-minute buckets, last 24 hours" | `/stats/transfer` has minute, hour or day buckets over the range asked | Follows the range: the daemon's buckets grouped into at most 100 (15 minutes for a day), each the average over the seconds recorded. Time not recorded is a gap; a lone bucket is a dot. |
| Stats: Peer clients "Client ▾" | `/stats/peers` by client, source, transport, encryption, IP version or direction | The menu picks the breakdown, and upload or download. Smaller values, peers that gave none, and bytes tied to no peer are "Other or unknown". |
| Stats: Idle seeds "Reclaim 21.2 GB", values in red and amber | `/stats/idle-seeds` (the last 30 days, whatever the range), `POST /torrents/delete` | The seeds under 0.1× not tagged `keep`, deleted after the usual question; files only when chosen. Red under 0.1×, amber under 1× (the Idle seeds report's classes; this artboard had 0.5×). |
| Stats: Timeline "View all" | The Timeline report | A link to it. |
| Stats: range buttons and "Sep 17 – Sep 24" | Ranges are unix seconds | Presets end now; the date button picks whole days in the viewer's zone (`?from=&to=`). |
| Stats › Trackers: "4 + DHT trackers doing work" | The `null` row is torrents with no working tracker, whatever found their peers | "4 + no tracker" when those moved data too. |
| Stats › Trackers: "private · 4 torrents · passkey", "slow · 4.8 s", "6 min median announce interval" | `GET /torrents/trackers` (added for the UI): torrents on each host now, private ones, and the median `interval` and `response_time` of its trackers' latest replies (urtorrent 0.14) | "private · 4 torrents" (or public, or both); no passkey hint, since the UI never reads URLs here. "slow · 4.8 s" when a host takes 2 s or more to answer; the middle host's interval under "announces answered". The fifth figure is the hosts failing now. |
| Stats › Trackers: "63 failed · 7 in a row", the error, "last try 08:05 · next in 22 min" | `GET /torrents/trackers` (added for the UI): the running torrents failing on a host, the latest error, the most failures in a row, since when, the last one; no next announce per host | As shown without the next announce, with "failing since" and the torrents named as links. URLs in an error show as their host (rule 6). |
| Stats › Trackers: "Reannounce", "Edit URL", "Remove from torrent" | `POST /torrents/trackers/reannounce` (that host alone, urtorrent 0.14); `POST /torrents/trackers/remove` by host (added for the UI) | Reannounce, and Remove after a question. Edit URL is left out: a URL is per torrent (passkeys differ), and editing one is W3; the torrent's link opens its detail. |
| Stats › Trackers: "6 torrents have no working tracker … Add trackers to 6 torrents" | `POST /torrents/trackers` (added for the UI); `add_trackers` and the fetched list in `GET /app` | Offered for the public ones only (rule 4), with the trackers meant for new public torrents; without any, a pointer to Settings › Downloads. The peer sources named are the ones switched on. |
| Stats › Trackers: "Announces · 7 days", "GB per day", "Torrents" column | `/stats/trackers?series=true` (added for the UI): hours when kept for the range, else days | Per hour over a day or two, else per day of the viewer (hours grouped), or per UTC day when only days are kept. Torrents are those on the host now. |
| Stats › Peers & geo: live peers of all torrents, "148 connected", "12 torrents · 163 connections" | `GET /transfer/peers` (added for the UI): the peers of the torrents moving data, as sampled every 10 s, or all of one torrent's now; the live store's `peers` for the count | The header counts every connection; the map, the list and the figures hold the sampled peers ("of 4 torrents moving data · sampled 7s ago"), or all of the torrent picked. |
| Stats › Peers & geo: "seedbox-01 · London", peers in cities ("New York, United States") | GeoIP gives a country and a network, never a city (ADR 0005); `here` in `GET /transfer/peers` (added for the UI) is the external address's country | The daemon at its country's point ("urtorrentd · United Kingdom"), each peer at its country's; no curves until the external address is known. Countries' points are the centres of their largest areas (Natural Earth, `world.ts`). |
| Stats › Peers & geo: country flags | No flag artwork in the UI | The two-letter code in a chip, the name beside it or in its title. |
| Stats › Peers & geo: map modes "Countries / ASN / Peers" | A network has no place of its own | Countries and Peers (a curve per peer, bent apart); networks are in the "Country ▾" menu (By network) and the 24 h / 7 d table. |
| Stats › Peers & geo: "24 h", "7 d" | `/stats/geo` and `/stats/peers` over the range | Curves as wide as the traffic; the list becomes the countries (or networks) with their traffic; Connections are shares of traffic. |
| Stats › Peers & geo: "Add peers", "Ban selected" | `POST /torrents/peers` (per torrent), `POST /transfer/bans` | Add peers once a torrent is picked; Ban asks first and names the addresses. |
| Stats › Idle seeds: "keep" tag, "Tag keep", "Select all under 0.1×" | Tags are the user's; the daemon gives `keep` no meaning | The UI's convention: `keep` is shown on the row, and neither "Select all under 0.1×" nor the Overview's Reclaim take kept torrents. |
| Stats › Idle seeds: state pills "stopped", "error", "stalled" | The live store's state | Every state but seeding, by its label ("Stopped", "Error"); a seed nobody downloads from is normal here, not a pill. |
| Stats › Idle seeds: "full · recording since Mar 02", "30 d" seeding | `recorded_from` in `/stats/idle-seeds`; `seeding_time` | "full" when the window is covered, else how much of it ("3 h of 30 days recorded"); seeding in days, or hours under a day. |
| Stats › Timeline: details ("queued · position 3 · /data/linux", "3.1 GB in 41 min · avg 1.3 MB/s", "with content · 3.1 GB freed · ratio 2.4 at removal", "was added to linux") | Events carry the torrent, the kind, the new state and, for moves and errors, the directory or the error | What the events hold: the error, the new directory, the state before and after (the torrent's last state change), and "in 34s from adding" when the add is in the history. The category chip is the torrent's now; no size, path, rate or ratio at the time. |
| Stats › Timeline: "Re-add" on a removal, "Reannounce" on an error, "Edit tracker" | A removed torrent's `.torrent` is gone; timeline errors are the torrent's (disk, missing files), not a tracker's | "Start" on an error while the torrent is still in error (it recovers missing files and disk errors). Failing trackers are listed in Needs attention with a link to Trackers. |
| Stats › Timeline: lanes coloured from range start | A state is known from the events: a state change, finishing, the metadata; after the last event, the state now | What is not established is drawn dashed, as before the range. |
| Stats › Timeline: "Freed by removals 5.4 GB" | Removals do not record sizes | Left out; "Added → finished" is the median from the events. |
| Detail tabs as links between artboards | One panel | Kobalte tabs, the tab in the URL (`?tab=files`); the Overview is the default and has no parameter. |
| Files: "Priority ▾" and "Rename" with no selection shown | `POST .../files/priority` takes indexes and one priority; `.../files/rename` and `.../folders/rename` one path | A click on a row's name chooses it (Ctrl or ⌘ adds, Shift a range); Priority sets the chosen rows' files, or every file when none is chosen (the menu says which); Rename takes one row. |
| Files: priorities Skip, Low, Normal, High | 0 skips, 1 to 7, 4 normal | The add dialog's: Low 1, Normal 4, High 6, Maximum 7, and Skip. The checkbox downloads or skips; checking a skipped file gives it Normal. |
| Files: folder rows with no size, progress or priority | The daemon lists files only | Folders sum their files' sizes and their progress (by size, over the files not skipped); no priority menu, since their files may differ (Priority sets a chosen folder). Folders open and close. |
| Files: a lane per file under the pieces bar | `first_piece`, `last_piece` per file; `GET .../pieces` | As designed while there are at most 12 files; more and only the bar shows. Skipped files are hatched. |
| Files: "availability 3.2" | The row's `availability` (distributed copies; `null` for a complete seed) | As shown, "—" when `null`. |
| Peers: "24 connected · showing top 10 by rate" | `GET /torrents/{hash}/peers` (every connected peer); `known_peers` in `GET /torrents/{hash}` | Every peer fastest first (the 200 fastest drawn), "· 312 known" when more are known than connected. The country as its code (no flags); "E" and "IN" only when they hold. |
| Peers: "Map" | Stats › Peers & geo takes `?hash=` | A link to the map of this torrent's peers. |
| Trackers: full URLs "https://bttracker.debian.org:443/announce" | Tracker URLs can carry passkeys (rule 6) | The host with the scheme as a badge; the whole URL only in its edit field. Removing asks first (a private tracker's passkey is needed to add it back). |
| Trackers: "Reannounce" on each tracker | `POST /torrents/{hash}/trackers/reannounce` (urtorrent 0.14: that tracker alone, even when another of its tier works) | Reannounce on each tracker, and "Reannounce all" for the torrent. |
| Trackers: "working · 186 seeds · 24 leechers · 1 204 completed" | `seeders`, `leechers`, `downloaded` per tracker, each `null` when not reported | What the tracker reported; a failing one's message and how many times it failed. |
| Trackers: "Add tracker URL… (one per line, same tier)" | `POST .../trackers` with a `tier` (absent: each in a new tier) | The URLs typed together go into one new tier after the last. |
| Trackers: "Public torrent — Add 38 fetched trackers" | `add_trackers` and `fetched_trackers` (`GET /settings`, `GET /app`) | The trackers new public torrents get that this one lacks, each in its own tier as for a new torrent; never offered to a private torrent (rule 4). |
| Trackers: DHT "312 nodes" | Nodes are the session's (`dht_nodes` in the transfer state); peers found are per torrent | The session's nodes beside the torrent's peers; "off · private torrent" for a private one. |
| History: seeding days shaded up to "> 10 GB", "darker = more" | `/stats/torrents/{hash}/days` (UTC days: upload, seeding time) | Shaded by copies of the torrent uploaded that day (under 0.1, 0.5, 1, then a copy or more), so a small and a big torrent read alike; brighter is more; days by UTC. A day it neither seeded nor uploaded is dashed; days before its first record are blank. |
| History: "Recorded since Aug 30, 21:40", "Best day 7.7 GB" | Days, not times | The first day recorded; the best day with its date. |
| History: "Ratio trend +0.05 / week at this rate" | Each day's `ratio` at its end | The change from a week ago to now ("+0.05 in the last 7 days"), not a projection. |
| History: "Swarm completed" | `swarm_completed_max` from the opt-in scrapes | The newest scrape's count, "—" without scrapes. |
| History: "Open in Stats" | The reports that take one torrent are Timeline and Peers & geo | "Open in Timeline". Delete history asks first (`DELETE /stats/torrents/{hash}`). |
| Options: "Peer connections 200", "Upload slots global" | `max_connections` is the cap in force; `max_uploads` `null` = the global budget; `null` in a request = the default | The cap in force; emptied, the torrent goes back to the settings' per-torrent default. |
| Options: share limits "Global" with a dimmed value | A torrent's `global` limits defer to its category's, then the settings' | The value Global stands for shown in the field (from the draft's category); typing a value makes the limit Own. "When reached" names the inherited action ("Global · stop"). |
| Options: "Browse", "Move content…" | `POST /torrents/location` moves the content and turns automatic management off | Browse is the folder icon in the field (the folder dialog). While automatic management is on the path is the category's. "Move content…" opens the Move content dialog; a save path typed with automatic management off moves the content when saved. |
| Options: no download path | `download_path` on the row; `POST /torrents/download-path` | A Download path row while the torrent is incomplete (or has one). |
| Options: "1 unsaved change · Discard · Save" | One call per kind of change | As shown, Ctrl/⌘ S too; the calls go one by one and the first failure stops them, shown in the footer. No toast (it would cover the footer). |
| Sidebar: categories and tags as filters only; tags made only from a torrent | `/categories`; `POST /tags` and `POST /tags/remove` | Not designed: a "+" beside Categories and Tags, and a row's menu (Edit category…, Remove category…, Delete tag…), as the RSS sidebar has them. The category is the Downloads page's dialog; removing asks alone. Deleting a tag says how many torrents lose it. A filter on one that goes goes with it. |
| No design for piece hashes | `GET /torrents/{hash}/pieces/hashes` | Not designed: "Piece hashes…" in the detail's more menu, once the metadata is known: each piece's number, state now and SHA-1, drawn as they scroll; found by number or the start of a hash; "Copy all" and "Save as text" (one hash per line). |
| No design for a lost event stream | Updates stop; the store keeps the last ones | Not designed: after 2 s without the stream, a bar over the page: reconnecting or unreachable, "What is shown is as of 10:41:02", and Try now. |
| Palette: "Add torrent… A", "Open Settings › Downloads ,", "Toggle alternative speed limits ⌥S" | A is Reannounce in the list (the context menu's design) | Add torrent… has no key; `,` opens Settings and ⌥S switches the alternative limits from any page (not while typing or in a dialog). |
| Palette: "Torrents t", "Files f", "Commands >" | — | The scopes: a click, Tab and Shift+Tab, or a prefix typed first: `t `, `f ` (the letter and a space) or `>`. Everything shows five of each. |
| Palette: "debian-12.11.0-amd64-netinst.iso · removed Sep 15 · history only → Stats" | `GET /stats/torrents` (added for the UI): the torrents with history, removed ones included, by name | As shown; Enter opens its Timeline. A removed torrent's size is not always known (removed before the recorder saw it). |
| Palette: a folder as one result ("…/DEBS/libobasis… · 42 files") | `GET /torrents/files` lists files | Files only, each with its size, progress (or "skipped") and torrent; Enter opens its torrent's Files tab. |
| Palette: the sidebar's search as a button | The list's own search (`?q=`) had its field there | The palette's "Show the N in the list" row filters the list; the list's title shows the search (“deb”) with a clear button. |
| Palette: "⌘↵ open in Stats", "2 314 files indexed" | `GET /torrents/files?limit=1` gives the files' total | ⌘↵ opens a torrent's (or a file's torrent's) Timeline; the footer counts the files the daemon indexes. Theme and sign-out are commands too. |
| Color tokens: semantic colours at 3:1 in light | Text meets AA (6.3) | The light theme's text colours darkened for 4.5:1 (6.2). |
| Torrents — phone: no boxes, no bulk | Several at once needs the panel | The box shows only while several are chosen (from the keyboard); the context menu opens on a long press. |
| Torrent — phone: no Trackers section | The Overview has one | Left out on a phone, as designed; the Trackers tab is in "more". |
| Not designed: magnet links clicked in the browser | `registerProtocolHandler` needs a secure page (HTTPS or localhost) | Settings › Downloads › "Magnet links in this browser" (and the palette) ask the browser to hand them to `/torrents?add=<link>`, which opens the add dialog and takes the link out of the address at once (it can carry a passkey). |
| Not designed: sources from anywhere | The add dialog's own sources | A magnet link, URL or `.torrent` pasted on any page, or dropped on it, opens the add dialog with it. |
| Not designed: the add dialog's download path | `download_path` / `use_download_path` in the add options: the daemon's rule when absent (the category's with automatic management, else the setting) | "Keep incomplete in": the path the daemon would use until changed; typing turns it on, the switch off sends none. |
| Not designed: the tab's title | — | The session's rates, then the instance ("↓ 8.1 MB/s ↑ 3.2 MB/s · seedbox-01"), as qBittorrent's WebUI does. |
| Not designed: limits from the torrents screen | `PATCH /settings` (global limits), `PUT /transfer/alt-speed` | The sidebar footer's rates open a popover: the download and upload limits (applied on Enter or leaving the field) and the alternative limits' switch, with a link to Settings › Speed. |
| Peers: no way to ban or copy a peer | `POST /transfer/bans` | Each peer's "⋯": Copy address, and Ban this address… after a question (every torrent; kept in Settings › Banned addresses). |
| Trackers: one line per tracker | `endpoints` on each tracker: its announce through each listen socket | "N endpoints" opens them: the local address, working or its error (URLs cut to their host), what it reported, the next announce. |
| 6.2: the accent and binary units as preferences | `data-accent` tokens; `formatBytes` in binary | The instance menu (and the palette): Theme, Accent (blue, green, violet, orange), Units (decimal or binary, for every size and rate shown), kept like the theme. |
| Not designed: a notification when a download finishes | The live store sees a torrent turn complete | Opt-in from the instance menu ("Notify when downloads finish"), after the browser's permission; kept like the theme. |
| Not designed: the keyboard shortcuts | 6.3's keys | ? or the palette opens them in a dialog. |
| No design for a page that fails | A render error, or a chunk gone because the daemon serves a newer build | Not designed: a card in the sign-in style in place of the page (the sidebar stays): the error and Reload / Try again, or "The web UI was updated" and Reload. Moving to another page tries again. |

### 6.5 Designs wanted

What the UI has no mockup for; each was built in the same language (6.4 says how) and is worth
a designer's look:

- **Tablets** (640–1279px): the detail panel and the sidebar as sheets over the list.
- **Phones beyond the two designed screens**: Stats, RSS, Log, Settings and the dialogs only
  reflow (6.3).
- **Built without a design:** the share limits dialog (the Options rows), managing categories
  and tags from the sidebar, piece hashes, the connection bar, the page error card, the
  first-run setup card, the instance menu (with the theme, accent, units and notifications),
  the one-line prompt and confirm dialogs, the speed limits popover, the keyboard shortcuts,
  the drop overlay, the add dialog's download path, a peer's menu and a tracker's endpoints.

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
- **Themes and phones.** The browser prefers the dark scheme (`playwright.config.ts`), so the
  suite runs in the dark theme; the palette spec switches to light and runs axe on every kind
  of page, and the phone spec checks that no page is wider than 390px.
- **Scale** (`e2e/scale.spec.ts`, tagged `@slow`, W7; runs only with `SLOW=1`). A real daemon
  gets 10 000 torrents (`BENCH_N`) through the API: magnets that wait in `metadata` (no
  trackers, DHT off) and `.torrent` files without content, a third stopped, in categories and
  tags. The spec measures in the page, from the input to the frame that shows the result:
  loading, scrolling, filters, sorting, search, one torrent, choosing all, the palette, the
  idle cost of the live stream (main thread, events and bytes), memory and the bundle. It
  writes `target/bench/web-<N>.json`. Run it against a release daemon. It asserts no budgets
  yet.
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
- The scale benchmark (7), after `npm run build` and `cargo build --release -p urtorrentd`:
  `URTORRENTD_BIN=../target/release/urtorrentd SLOW=1 npx playwright test --grep @slow
  --project=chromium` (`BENCH_N=1000` for fewer torrents).
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
- **W3 One torrent in depth** (done). Files (tree, priorities, rename). Peers (with GeoIP).
  Trackers and web seeds (edit). Pieces. Limits and share limits. Location and download path.
  Managing categories and tags. Built: the detail panel's tabs as designed: Files (the tree with
  priorities, renames, the pieces each file spans), Peers, Trackers and web seeds (editing,
  the trackers new public torrents get), History and Options (name, comment, limits, share
  limits, behaviour, category, tags, save and download paths, as one draft); several torrents
  at once (the panel, the selection bar, the context menu and keys); the move, remove, share
  limits and folder dialogs; piece hashes; categories and tags made, edited and removed from
  the sidebar.
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
  designed, with feeds, folders and rules managed from its sidebar and a rule edited in the
  designed dialog beside a dry run of the rule as typed.
- **W6 Statistics.** Traffic over time, seeding days, rankings, the timeline, places,
  breakdowns and idle seeds (uPlot). Done so far: the Overview (the range's traffic against
  the one before, the transfer rate, top torrents, traffic by category, peers by client or
  another breakdown, idle seeds with Reclaim, the newest events), Trackers (each host's
  traffic and announces beside its torrents now, traffic by tracker, announce problems with
  what can be done about them), Peers & geo (the world map from the daemon to its peers' countries,
  now or over a day or a week; the peers to ban or add; by country or network; how peers
  connect), Idle seeds (size against value; the least valuable first, to stop, keep or remove;
  CSV) and Timeline (events by kind, lanes per torrent, the feed by day, what needs attention;
  CSV) as designed. A torrent's own history (its seeding days and last day's traffic) is the
  detail panel's History tab (W3).
- **W7 Finish.** The ⌘K palette, small screens, the full browser matrix, and the 10 000-torrent
  budgets. Done so far: the palette as designed (torrents, removed ones, files across torrents,
  commands and their keys); the light theme; the phone list and torrent as designed with the
  tab bar, and every other page fitted to a phone (6.3); the connection bar and the page error
  card; the scale benchmark (7), whose first run (2026-09-27) made the daemon send clock-only
  row changes once a minute. Left: the full browser matrix, and budgets asserted from the
  benchmark's numbers.

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

- **Theme.** Dark and light are designed. Default: follow the system; the viewer can pick one.
- **Solid 2.0.** Default: stay on 1.9 until its ecosystem moves.
