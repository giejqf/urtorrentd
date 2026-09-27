# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `--initial-settings <file>` (`URTORRENTD_INITIAL_SETTINGS`): the settings
  of a new data directory's first start, as a JSON object of setting fields
  over the defaults, so a daemon can start offline from its first second
  (no DHT bootstrap). Ignored once settings are stored; unknown fields are
  errors.
- The daemon serves the web UI at `/` next to the API
  ([ADR 0008](docs/adr/0008-web-ui.md)): built in with the `web-ui` cargo
  feature, from a directory with `--web-ui <dir>` (`URTORRENTD_WEB_UI`),
  or not at all (`--no-web-ui`, and builds without the feature). Paths
  without a file of their own get `index.html`; the pages carry a strict
  Content-Security-Policy and refuse framing; hashed assets are cached for
  good. Unknown `/api/...` paths stay JSON 404s.
- `api_cors_origins`: browser origins allowed to call the API (CORS with
  credentials; preflights answered, errors readable, the CSRF check
  passed). Empty by default: nothing changes until an origin is listed.
- Behind a trusted proxy that says `X-Forwarded-Proto: https`, the session
  cookie is `Secure`.
- Web UI (`frontend/`, SolidJS): first-run setup and sign-in, with session
  expiry and bans explained; the torrents screen as designed: a virtualized
  list grouped by state, sidebar filters by status, category, tag and
  tracker with counts, the daemon's search, keyboard selection and bulk
  actions, a detail panel (properties, category and tag editing, pieces and
  availability, transfer, trackers), adding by link or `.torrent` file,
  and deleting with or without files. Live through the event stream. A
  seed nobody downloads from shows as Idle; only a download that gets no
  data shows as Stalled.
- Web UI: the add dialog as designed. Sources are magnet links, info-hashes
  and URLs, `.torrent` files, or a folder to watch. The daemon previews
  each source before it is added (files, size, pieces, swarm, trackers)
  and each file can be skipped or prioritised. Every option is there: save
  path with a browser of the daemon's folders, category, tags, content
  layout, stop condition, automatic management, speed and ratio limits.
  Duplicates and failures are shown with the daemon's reason, and previews
  that are not used are dropped.
- Web UI: Settings, starting with Speed as designed: global and
  alternative limits in kB/s next to the rates now, the switch to the
  alternative limits, the schedule (window, time zone, days) with a chart
  of the week and when it switches next, and the connection budget. Changes
  are a draft, saved together (Ctrl/⌘ S) or discarded, and leaving asks
  first. A banner offers to restart the daemon when engine settings wait
  for one.
- Web UI: Settings › Downloads as designed: save and download paths with a
  folder browser, the incomplete-file suffix, automatic management, and a
  picture of where a new torrent goes; the categories' paths, added, edited
  and removed in place; content layout, stop condition and the other add
  options; file names to skip; `.torrent` exports; trackers for new public
  torrents, with the fetched list and "Fetch now".
- Web UI: Settings › Queue & share limits as designed: the queue limits
  with the slots they hand out now (downloading, seeding, slow, waiting,
  over the limit), the queue's order, reordered by dragging a row or from
  the keyboard, and the
  default share limits in days, hours or minutes with the seeding torrents
  closest to a limit and when they get there.
- Web UI: Settings › Connection, BitTorrent and Banned addresses as
  designed: reachability and the addresses peers see, the listen port,
  interface and address families with the machine's interfaces, peer
  transports; DHT, PEX and LSD with the last day's peer traffic by how the
  peer was found, bootstrap routers, encryption and identity; bans added
  and lifted at once, what they cover, and the peer log with bans per day.
- Web UI: Settings › Watch folders, RSS and Webhooks as designed: watch
  folders with their options, whether each can be read and what they
  picked up; RSS polling with the next hour it plans, download rules
  switched on and off, feeds refreshed on demand; webhooks with their
  health, edited in place, a test, their last deliveries with redelivery,
  and what the last one sent.
- Web UI: Settings › Statistics & GeoIP, Security & API, Engine and About
  as designed: retention with what is on disk and where it is cut, the
  opt-in scrape, removed torrents' history, the GeoIP files; how the
  daemon sees this browser's request, the login and the API key (shown
  once), sessions and sign-in bans ended or lifted at once, the HTTP layer
  with the browser origins, the cookie jar; the machine, engine tuning
  beside what runs, restarting now or once the torrents are idle; the
  instance, diagnostics to copy (no addresses, paths, URLs or names),
  deleting statistics and shutting down.
- Web UI: the RSS screen as designed: every feed in its folders with what
  is unread, articles by age, filtered by what they are and by title, read
  with their description as text and their links by host; downloaded
  through the add dialog; feeds, folders and rules added and changed from
  the sidebar, and a rule edited beside what it would take.
- Web UI: the Log screen as designed: the main log by day, by level and
  topic and by text, repeats folded; one entry with its torrent, how often
  it came, the last day by hour and what recurs; followed live or held
  while reading; exported as text.
- Web UI: Stats › Overview and Trackers as designed. The Overview has the
  range's traffic against the range before, the transfer rate (uPlot), top
  torrents, traffic by category, peers by client or another breakdown, idle
  seeds with Reclaim, and the newest events. Trackers shows each host's
  traffic and announces beside its torrents now, traffic by tracker, and
  announce problems with Reannounce, Remove and adding the trackers for new
  public torrents. Ranges are presets or days picked; hosts only, never URLs.
- Web UI: Stats › Peers & geo, Idle seeds and Timeline as designed. Peers &
  geo draws a world map from the daemon's country to its peers', now (the
  peers of the torrents moving data, or all of one torrent's) or over a day
  or a week, with the peers to ban or add, traffic by country or network
  and how peers connect; places are countries and networks, never cities.
  Idle seeds sets every complete torrent's size against what it uploaded in
  the window, least valuable first, to stop, tag `keep` or remove, and
  exports CSV. Timeline shows the events by kind, one lane per torrent and a
  feed by day, with what needs attention now, and exports CSV. The
  Overview's Reclaim leaves torrents tagged `keep` alone.
- Web UI: the detail panel's tabs as designed. Files is the torrent's tree
  with each file's size, progress and priority, a checkbox to download or
  skip a file or a folder, priorities for the rows chosen, renames, and the
  pieces each file spans. Peers lists the connected peers fastest first,
  with their country, client and connection, and peers to add. Trackers
  edits, adds (one tier per batch) and removes trackers, shown by host only,
  offers a public torrent the trackers new ones get, and edits web seeds.
  History has the last 30 days, the last 12 weeks of seeding days and the
  last day's traffic, and deletes the torrent's history. Options saves the
  name, comment, limits, share limits, behaviour, category, tags and
  location as one draft, and asks before leaving it unsaved.
- Web UI: several torrents at once, as designed: a panel that acts on all of
  them (figures, actions, the queue, category, tags, upload limit, share
  limits, location, automatic management), a selection bar over the list,
  a box on each row, and a context menu whose keys work in the list (S,
  ⇧F, R, A, L, M, ⌘C, ⌫). The designed dialogs: Remove (the torrents named,
  those tagged keep said, what deleting the files deletes and where), Move
  content (save or download path, free space there, rename or copy, now or
  on completion), Choose a folder (free space, what each folder holds,
  whether the daemon can write in it) behind every Browse, and a Share
  limits dialog. RSS rules are edited in the designed rule dialog beside a
  dry run of the rule as typed, with why each article is left out.
- Web UI: the designed new API key, category and feed dialogs. The key is
  shown once with the header to send it and waits for "I have copied it";
  a category shows the path it resolves to and which of its torrents a
  change moves; a feed is read before it is added (its title, articles and
  whether cookies go with it), and can be added without running the rules
  on what it already has.
- Web UI: categories and tags managed from the torrents screen's sidebar
  (made from the "+", edited, removed or deleted from a row's menu, with
  how many torrents it concerns); a torrent's piece hashes, found by number
  or hash and saved as text; two-line rows and wrapping headers on phones;
  a bar saying since when the figures are while the daemon is away; and a
  card instead of a blank page when a page fails, offering a reload when
  the daemon serves a newer UI.
- Web UI: the designed ⌘K palette (torrents by the daemon's search, removed
  ones from their history, files across torrents, commands; ⌘K or / opens
  it, , opens Settings and ⌥S switches the alternative limits anywhere);
  the light theme, following the system or chosen from the instance menu
  and kept with the user's preferences; and the designed phone screens:
  the list with its status chips and tab bar, one torrent on the whole
  screen with its actions below, and every other page fitted to the width.
- `POST /rss/dry-run`: a rule as being edited, unsaved, over its feeds'
  articles: each one's verdict (`take`, `taken` by a rule already,
  `filtered`) and why the filters leave it.
- `POST /rss/feeds/probe`: a feed's URL fetched and read without keeping
  anything (its title and article count), to look before adding it. A feed
  added with `skip_existing` keeps its first articles without running the
  download rules on them, so auto-download takes only what comes later.
- `GET /stats/torrents`: the torrents with recorded history, removed ones
  included, found by name, to reach what is no longer in the session.
- `GET /fs/file-system`: the file system holding a path (mount point,
  type, size, free space). `GET /fs/directory` entries say whether the
  daemon can write in them and how many entries they hold.
- `cargo xtask web` (the UI's checks and end-to-end tests) and
  `cargo xtask dist` (a release binary with the UI built in).

- List rows (`GET /torrents`, the event stream) carry `tracker_hosts`: the
  host of every configured tracker, working or not (never the URLs, which
  can carry passkeys). `GET /torrents?tracker=<host>` filters by it (`""`:
  torrents without trackers).
- `GET /torrents/hashes`: the info-hashes of the list, with the same
  filters, search, sorting and paging as `GET /torrents`, for clients that
  keep the rows from the event stream.

- Categories carry share limits (`share_limits`, as a torrent's): a
  torrent's `global` limits defer to its category's where the category
  sets them, then to the settings. Stored in a new column (schema version
  3); existing categories keep all-`global` limits, so nothing changes
  until one is set.
- Previews keep the swarm the trackers reported (`swarm_seeds`,
  `swarm_leechers`) once the metadata is here, and count connected seeds
  (`seeds`) while fetching.

- `POST /app/restart`: a graceful shutdown, then the same binary starts
  again in the same process with the same arguments, so settings that
  apply after a restart take effect without a shell on the machine.
- `GET /app` has the daemon's system time zone (`time_zone`), the one the
  alternative-limits schedule uses when it names none.
- `PUT /torrents/{hash}/queue-position` puts a torrent at a place in the
  queue in one call (urtorrent 0.13.5), for clients that reorder by
  dragging; the queue decides once which torrents run.
- List rows carry `slow`: running for a minute below 2 KiB/s both ways,
  the state in which a queued torrent holds no slot unless
  `count_slow_torrents` (urtorrent 0.13.5).
- `GET /watch-folders`: when each watch folder was last read, why one
  cannot be, and the last files they took with what became of each
  (added, already there, rejected).
- Webhooks keep what their last deliveries sent:
  `GET /webhooks/{id}/deliveries/{delivery}` reads it, and
  `.../redeliver` sends it again (same payload and delivery id).
- Peer-log entries say who banned or unbanned the address (`source`:
  `engine` or `settings`) and, for the engine's bans, on which torrent
  (`torrent`).
- `POST /app/fetched-trackers/refresh` fetches the `add_trackers_url` list
  at once instead of at its daily turn; `fetched_trackers.fetching` in
  `GET /app` says a fetch is under way.
- `GET /auth/account` (the user name, when the API key was made and its
  last use), `GET /auth/sessions` (login sessions with their address,
  user agent and last use; `DELETE` ends one, or every other), and
  `GET /auth/bans` (addresses with failed logins and their bans;
  `DELETE /auth/bans/{address}` lifts one).
- `POST /auth/check` says how the daemon sees the request: the client
  through the proxies, the host check, the authentication and the
  cross-origin check, for setting up a reverse proxy.
- `GET /app` shows the settings that apply after a restart as the engine
  runs them (`running`), since when one waits
  (`restart_required_since`), and a restart waiting for idle torrents
  (`restart_waiting`): `POST /app/restart?when=idle` restarts once nothing
  is checking, moving or receiving data, and `DELETE /app/restart` calls it
  off.
- `GET /app/system`: CPUs, kernel, memory, the open-file limit and how
  many files are open, and the default save path's file system.
- Main-log entries say what they are about (`topic`: `torrents`,
  `trackers`, `rss`, `watch_folders`, `webhooks`, `settings`, `security`,
  `network`, `statistics`, `daemon`) and which torrent (`torrent`);
  `GET /log?topics=` filters by it. The fetched tracker list and webhook
  deliveries that failed after their retries are logged now (by host or
  name: their URLs can carry tokens).
- RSS articles say which rule a download would add them by
  (`matched_rule`); articles can be marked unread again (`unread` in
  `POST /rss/feeds/{id}/read`); `POST /rss/feeds/refresh` and
  `POST /rss/feeds/read` refresh several feeds, or mark them read, at once.
- `DELETE /stats` deletes every statistic, and `DELETE /stats/removed` the
  history of removed torrents (counted by `removed` in `GET /stats`); the
  file shrinks. The GeoIP databases say when they were read (`loaded`).
- `GET /torrents/trackers`: every tracker host across the torrents as it
  stands now: how many torrents have a tracker on it (and how many of them
  are private), how many work with it, and the running torrents whose
  announces to it fail, with the latest error, the most failures in a row
  and since when. Hosts only, never URLs.
- `POST /torrents/trackers` adds trackers to many torrents at once, and
  `POST /torrents/trackers/remove` removes every tracker on some hosts from
  them.
- `GET /stats/trackers?series=true`: each tracker's buckets (traffic of
  its torrents, announces answered and failed), like `/stats/groups`.
- `GET /transfer/peers`: the peers across torrents, located: those of every
  torrent moving data as sampled every 10 s (now also while statistics
  recording is off), or every peer of one torrent now; with where the
  daemon itself is (its external address in the GeoIP databases).

### Changed

- Requires urtorrent 0.13.5.
- `POST /torrents/location` on an incomplete torrent downloading in its
  download path sets the save path and leaves the content there until the
  torrent completes (qBittorrent's `setSavePath`); before, it moved the
  partial files at once and dropped the download path. `POST
  /torrents/download-path` still moves them now.
- The session cookie has no `Max-Age`: it lasts for the browser session,
  and the daemon ends login sessions after `api_session_timeout` idle
  seconds. Before, the browser dropped it that long after sign-in even
  while the user was active.
- An event stream opened with a login session keeps the session alive while
  open, and ends when the session ends (sign-out, new credentials, expiry).
  Before, a signed-out page kept receiving updates on a stream it had open.

### Fixed

- A torrent removed before the statistics recorder had seen it (right
  after it was added) kept no name in its history; the removal records it
  now.

### Security

- A request carrying forwarding headers (`X-Forwarded-For`, `X-Real-IP`,
  `Forwarded`) from an address that is not in `api_trusted_proxies` is no
  longer exempt from authentication by `api_bypass_local_auth` or
  `api_auth_whitelist`: its real client is unknown. Before, a reverse proxy
  on loopback that was not listed as trusted exempted every client it
  relayed while `api_bypass_local_auth` was on. The daemon logs a warning
  the first time.
- A webhook delivery that got no answer recorded the error with the
  webhook's URL in it, and URLs often carry a token; the error is kept
  without it now.
- A tracker that could not be added to a new torrent was logged with its
  URL, which can carry a passkey; the log names its host now.
- Clients that need no login (`api_bypass_local_auth`,
  `api_auth_whitelist`) now pass the cross-origin check like login
  sessions: a web page on another origin could otherwise make their
  browser change things on the daemon, a shutdown included, without being
  able to read the answers. Scripts send no `Origin` and are not affected.

## [0.13.0] - 2026-09-24

First-run setup ([ADR 0007](docs/adr/0007-first-run-setup.md)).

### Added

- `POST /auth/setup` (public): while no password is set, the first client
  chooses the user name and password and is logged in at once; afterwards
  `409 conflict`. One caller wins however requests interleave; a
  cross-origin request is refused. The temporary password printed at start
  still works until then, and ends with its sessions at setup.
- `GET /auth/status` (public): `setup_required`, so a client UI can show a
  setup form or a login form.

### Changed

- User names are 1 to 128 characters and passwords 8 to 1024, for
  `PUT /auth/credentials` as for setup.

## [0.12.0] - 2026-09-24

Search over the managed torrents.

### Added

- `GET /torrents?search=`: words that must all match the name, category,
  a tag, any tracker's host, or (6+ hex digits) the start of the info-hash;
  `*` and `?` wildcards, case ignored. Combines with the other filters.
- `GET /torrents/files?search=`: file names across every torrent (or one,
  `hash`), paged, with each file's torrent, index, size, progress and
  priority. The daemon keeps the file paths in memory, so a search does not
  ask the engine for every torrent's files.

### Changed

- Requires urtorrent 0.13.4: HTTP(S) tracker announces and web-seed
  downloads now leave from the listen address (and fail while it is gone),
  and peer connections follow a live `listen_v4` / `listen_v6` /
  `listen_interface` change. `listen_interface` on a VPN interface keeps
  all of the daemon's torrent traffic on it; `docs/gaps.md` has no open
  item.

### Fixed

- A folder rename or incomplete-file suffix pass that failed part way now
  drops the cached content path, so later reads see the renames that did
  happen.

## [0.11.0] - 2026-09-24

The checklist's remaining "planned" rows: every qBittorrent WebAPI endpoint
and preference is now mapped or unsupported with its reason.

### Added

- Settings `content_layout` and `stop_condition`: defaults for adds that
  do not say (`options.content_layout` / `options.stop_condition` are now
  optional).
- `category_paths_in_manual_mode`: a manually managed torrent added with a
  category and no save path goes to the category's.
- `excluded_file_names`: files (or folders on their path) matching a
  wildcard get priority 0 when added; a magnet is held until its metadata
  so nothing is created first.
- `merge_trackers`: adding a torrent again merges its trackers and web
  seeds into the one there (never private ones; the 409 says how many).
- `export_dir`, `export_dir_finished`: the `.torrent` of every torrent
  added / finished is written there.
- `recheck_on_completion`: a finished torrent is rechecked (after its move
  to the save path).
- `POST /torrents/download-path`: move incomplete torrents to a download
  path, or back to the save path.
- The cookie jar (`GET` / `PUT /app/cookies`), sent with `.torrent`
  downloads, RSS feeds and the tracker list.
- `add_trackers_url`: a tracker list fetched at the start and every 24
  hours, added to new public torrents; `GET /app` → `fetched_trackers`.
- `api_trusted_proxies`: behind these reverse proxies the client's address
  (`X-Forwarded-For`, read from the right) and host (`X-Forwarded-Host`)
  are the forwarded ones, for bans, the local bypass, the whitelist and the
  host and origin checks.
- `listen_interface` and `GET /app/interfaces`: listen on and dial peers
  from an interface's addresses, followed as they change, loopback only
  while it has none; `GET /app` → `listen_addresses`. HTTP trackers and web
  seeds are not bound yet (`docs/gaps.md`).
- `instance_name`, shown in `GET /app`.

## [0.10.0] - 2026-09-24

### Added

- **RSS** (qBittorrent's `rss/*`): feeds in folders (`/rss/feeds`,
  `/rss/folders`), refreshed at their interval (`rss_enabled`,
  `rss_refresh_interval`, per-feed `refresh_interval`) with a delay
  between requests to one host and conditional requests; RSS 2.0 and
  Atom with enclosures and torznab / newznab attributes; articles with
  read marks (`/rss/articles`, `/rss/feeds/{id}/read`). Download rules
  (`/rss/rules`): wildcards or regular expressions, episode filters, a
  smart filter taking each episode once (repacks once more), ignore days,
  add options per rule, and a dry run (`/rss/rules/{name}/matches`).
  Errors are logged without the feed URL (passkeys).
- **Client data store** (qBittorrent's `clientdata/*`): `/client-data`
  keeps JSON values by key for client UIs.
- `urtorrentd.db` schema version 2 (migrated on open).

### Removed from the plan

- E-mail notifications (webhooks notify) and HTTPS in the daemon (a
  reverse proxy terminates TLS): their preferences are unsupported, with
  the reason.

## [0.9.0] - 2026-09-24

### Added

- **Alternative-limits scheduler** (`alt_speed_schedule`: `from` / `to` as
  `HH:MM`, weekdays, IANA time zone): the alternative limits go on and off
  at the window's boundaries, in local time with daylight saving; a switch
  by hand holds until the next boundary. qBittorrent's `scheduler_*` and
  `schedule_*` preferences are covered.
- **Watch folders** (`watch_folders`): `.torrent` and `.magnet` files are
  added with each folder's add options once they have settled, then
  renamed to `.added` (or deleted) or, when they cannot be added,
  `.rejected` with the reason logged; optionally recursive. qBittorrent's
  `scan_dirs` is covered.

### Changed

- Tested with urtorrent 0.13.3 (a partial seed says `upload_only`, as
  libtorrent's does); 0.13.2 remains the oldest supported.

## [0.8.0] - 2026-09-24

### Added

- **Metadata preview** (qBittorrent's `fetchMetadata` / `saveMetadata`):
  `POST /previews` fetches a magnet's (or URL's) metadata without adding
  the torrent; `GET /previews/{hash}` shows it fetching, then ready with the
  files; `GET /previews/{hash}/torrent-file` returns the `.torrent`;
  `DELETE` drops it. Adding the same info-hash uses the fetched metadata.
  Previews are in no list or statistic, are not kept across restarts, and
  go away after 15 minutes unread.
- **Webhooks** (ADR 0006; qBittorrent's run-on-add and run-on-completion,
  without running programs): `/webhooks` calls URLs on `added`,
  `metadata`, `finished`, `moved`, `error` and `removed` with a typed
  `WebhookPayload` (the torrent's list row included), signed with
  HMAC-SHA256 when a secret is set, retried on no answer, 429 and 5xx,
  redirects not followed; `POST /webhooks/{id}/test`; the last deliveries
  are shown. The `autorun_*` preferences are covered.

## [0.7.0] - 2026-09-23

### Added

- **Peer breakdowns**: `GET /stats/peers?dim=` `client` (name without its
  version), `source` (tracker, DHT, PEX, LSD, incoming, ...), `transport`,
  `encryption`, `ip_version`, `direction`; per torrent or overall, with
  `unattributed` so the rows add up, optionally as a series.
- **Groups**: `GET /stats/groups?group=category|tag`: traffic by the
  category and tags each torrent has.
- **Trackers**: `GET /stats/trackers`: per tracker host, the traffic of the
  torrents working with it and its announces answered and failed. Hosts
  only, never URLs (passkeys).
- **Idle seeds**: `GET /stats/idle-seeds?days=`: complete torrents by what
  they uploaded in the window relative to their size, least first.
- **Scrapes** (opt-in, `stats_scrape_interval`): the swarm's completed
  downloads in each day (`swarm_completed_max`).
- `stats.db` schema version 3 (migrated on open).

## [0.6.0] - 2026-09-23

### Added

- **Geolocation**: settings `geoip_database` and `geoip_asn_database` take
  MaxMind DB files you provide (DB-IP Lite, GeoLite2, IPinfo Lite; never
  downloaded, re-read when replaced). Peers (`GET /torrents/{hash}/peers`)
  carry `country`, `asn` and `as_org`; `GET /app` shows the databases in
  use. qBittorrent's `resolve_peer_countries` is covered.
- **Traffic by place**: `GET /stats/geo` has peer traffic by country or
  autonomous system, per torrent or overall, per hour or day, optionally as
  a series. Rows plus `unattributed` (web seeds, missed closes, the seconds
  since the last sample) add up to the torrents' traffic. Per-connection
  counters are differenced like a torrent's: peers of active torrents are
  sampled every 10 s and closed connections bring their final counters.
  Peer addresses are never written to disk.
- `stats.db` schema version 2 (migrated on open).

## [0.5.0] - 2026-09-23

### Added

- **Statistics** (ADR 0005), recorded in `<data dir>/stats.db`: per-torrent
  traffic by minute and hour, a row per torrent per day it ran or moved data
  (its seeding history: bytes, running and seeding time, all-time counters,
  ratio, swarm size), session traffic, a timeline (added, metadata,
  finished, moved, error, removed, state changes) and the periods in which
  anything was recorded. All from differences of the library's counters.
  Endpoints: `GET /stats`, `/stats/transfer`,
  `/stats/torrents/{hash}/traffic`, `/stats/torrents/{hash}/days`,
  `/stats/top`, `/stats/timeline`, `DELETE /stats/torrents/{hash}`. Removed
  torrents keep their history.
- Settings `stats_enabled`, `stats_minute_retention` (48 h),
  `stats_hour_retention` (90 days), `stats_day_retention` (forever).
- Error code `unavailable` (503): a `stats.db` that cannot be opened turns
  statistics off for the run instead of stopping the daemon.

### Changed

- urtorrent 0.13.2. It marks resume data for every change the data records
  (trackers, per-torrent settings, the queue flag, queue moves), so shutdown
  saves only the torrents that changed instead of all of them.

### Fixed

- A seed's transfer counters were saved only at a clean shutdown: the
  library does not mark resume data for counters, so after `kill -9` a
  seed's upload fell back to its last save (possibly days old). The daemon
  now saves a torrent whose counters moved, at most once a minute.

## [0.4.0] - 2026-09-23

### Added

- **Live updates as server-sent events**: `GET /api/v1/events` pushes the
  same diffs as `GET /sync` (`SyncResponse` data, the revision as the event
  id): everything at once, then only what changed, at most once a second
  and only when something did. `EventSource` resumes with `Last-Event-ID`;
  an unknown id gets everything; a slow client gets the latest changes, not
  a backlog; idle streams send a comment every 15 s. The TypeScript check
  types a client's `EventSource` handler from the generated schema.

### Fixed

- A shutdown (API, SIGTERM, SIGINT) ends open event streams first, so the
  HTTP server's graceful shutdown does not wait on them; covered by a test
  that stops the real binary with a stream open.

## [0.3.0] - 2026-09-23

### Added

- **A suffix for incomplete files**: the `incomplete_file_suffix` setting
  (`".!qB"` gives qBittorrent's behaviour; off by default). Files that are
  not complete carry it and lose it as each one completes; a check takes it
  off the files it finds complete and puts it back on any a recheck finds
  incomplete; changing the setting renames the files of every torrent. Done
  with the library's `rename_file` and `FileCompleted` (no library change);
  a `.torrent` is held at once while the suffix is on, so no file is created
  under its final name first.
- `docs/settings.md` shows how to stage downloads in a download path and have
  them move to their category's directory on completion (automatic
  management), now covered end to end by a test together with the suffix.

## [0.2.0] - 2026-09-23

Persistence moves to SQLite, and the daemon follows urtorrent 0.13.1, which
closed the gap list the daemon had filed (`docs/gaps.md`). Breaking: the
data directory's format (0.1 directories are imported on the first start),
and new enum values in the API (`TorrentState::held` / `unknown`,
`TrackerStatus::updating`).

### Changed

- **All state lives in one SQLite database**, `urtorrentd.db` (ADR 0004):
  settings, credentials, categories, tags, totals, the DHT state, and per
  torrent the record, the `.torrent` and the library's resume data. One
  transaction per change set (a bulk action over thousands of torrents is one
  commit) instead of two `fsync`s per file; the per-minute rewrite of every
  record is gone. The daemon now holds the resume data itself: saved when the
  library says it changed (at most once a minute), after checks and
  completions, and for every torrent at shutdown.
- A 0.1 data directory is imported in one transaction on the first start; the
  old files move to `imported-0.1/`.
- Built on urtorrent 0.13.1. List rows take the working tracker, swarm
  counts, availability (distributed copies), `sequential` and the activity
  times from `statuses()`; the caches and mirrored fields that stood in for
  them are gone, and the activity times now survive restarts.
- **Errored torrents recover**: `start` looks for missing files again or
  retries after a disk error, `recheck` clears the error and rechecks; only
  unusable metadata is refused (`409 busy`). The torrent's `error_kind`
  (`content_missing`, `io`, `metadata`) is in the API.
- **Magnets are held** when a stop condition or a content layout needs it:
  nothing is downloaded before the stop, and the layout is applied before any
  file exists. A `.torrent` whose layout renames files is held at once.

### Added

- First and last piece of each file first: `options.first_last_piece_priority`
  and `POST /torrents/first-last-piece-priority` (urtorrent 0.13 piece
  priorities); piece priorities in `GET /torrents/{hash}/pieces`.
- Banned address ranges: the `banned_ip_ranges` setting (`10.0.0.0/8`,
  `fd00::/8`, `first-last`).
- Tracker rows per listen socket (`endpoints`) and an `updating` status.
- Peers the engine bans for corrupt data appear in the peer log.

## [0.1.0] - 2026-09-23

The first release: a daemon on urtorrent 0.11.4 with a typed HTTP API that
covers the features of qBittorrent 5.2.3's WebAPI the library supports
(`docs/api.md`, `docs/settings.md`). The alternative-limits scheduler, RSS,
watch folders and the other "planned" rows follow; `docs/gaps.md` lists what
they need from the library.

### Added

- The daemon on urtorrent 0.11.4: one engine session, a registry of torrents
  by info-hash, and a data directory that survives restarts and `kill -9`
  (engine-managed resume files, daemon records, atomic writes; ADR 0002).
- The HTTP API under `/api/v1` on axum (ADR 0001): login sessions and API
  keys, login bans, CSRF and `Host` checks; settings with live apply and
  restart-only fields; adding torrents from `.torrent` files, magnet links,
  info-hashes and URLs (with the identity's user agent); the torrent list
  with filters, sorting and paging; bulk start / stop / force start /
  recheck / reannounce / delete / queue moves / limits / share limits /
  location / category / tags / automatic management / peers; per-torrent
  detail, files (priorities, renames), trackers, web seeds, peers, pieces,
  piece hashes and `.torrent` export; categories and tags; transfer state,
  alternative speed limits and bans; incremental sync; main and peer logs.
- Daemon policies: automatic management (save path from the category),
  download path with a move on completion, stop conditions, content layout,
  automatic trackers for public torrents only, share limits (stop, remove,
  remove with files).
- A typed OpenAPI 3.1 schema generated from the code (utoipa), committed as
  `openapi.json` and served at `/api/v1/openapi.json`; tests validate every
  response against it, and `cargo xtask sdk` type-checks a TypeScript client
  generated from it (ADR 0003).
- The feature checklist: qBittorrent 5.2.3's WebAPI actions and preference
  keys (`docs/reference`), each mapped or marked unsupported in
  `docs/api.md` / `docs/settings.md`, enforced by `tests/coverage.rs`.
- Stop conditions on `.torrent` files are race-free: the torrent is added
  stopped and still runs its initial check. On magnets they react to the
  engine's events (racy until the library can hold a magnet after its
  metadata; docs/gaps.md).
- `start`, `force-start` and `recheck` refuse a torrent in the `error` state
  (`409 conflict`) instead of reporting a success that did nothing: the
  library cannot clear an error yet (docs/gaps.md).
