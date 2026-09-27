# ADR 0009: GeoIP databases downloaded on request

Status: accepted (2026-09-27, maintainer decision). Amends
[ADR 0005](0005-statistics.md), which had the daemon never download one.

## Context

Peers are placed by MaxMind DB files (ADR 0005, 0.6.0). Until now the user
supplied them: download DB-IP Lite, MaxMind GeoLite2 or IPinfo Lite, copy
the files onto the machine, point `geoip_database` and `geoip_asn_database`
at them, and replace them every month. On the first production box that
took a script and a systemd timer. The maintainer asked for a button in the
web UI instead.

DB-IP Lite needs no account: its country and ASN files are published on
the first of each month at fixed URLs
(`https://download.db-ip.com/free/dbip-{country,asn}-lite-YYYY-MM.mmdb.gz`)
under CC BY 4.0, which asks for credit to DB-IP, with a link, where the data
is shown. MaxMind and IPinfo need an account and a key.

## Decision

- **On request only.** `POST /app/geoip/download` (`{"source": "dbip_lite"}`)
  fetches DB-IP Lite's country and ASN files now: this month's (UTC), or
  the month before when this month's is not out yet. The daemon never
  downloads one on its own: no schedule, no download at start. Asking again
  is the monthly update.
- **Fixed sources.** A request names a source, never a URL: the API cannot
  make the daemon fetch an arbitrary address. The base URL is a start-up
  option (`--geoip-mirror`, for a mirror and for tests, which never reach
  the internet), not a setting.
- **Checked before use.** Each file is at most 64 MiB compressed and
  256 MiB uncompressed, must open as a MaxMind DB of the expected kind
  (`DBIP-Country-Lite`, `DBIP-ASN-Lite`), and is written beside the old one
  and renamed over it (`<data dir>/geoip/`), so a failed download leaves the
  loaded database as it was. Then `geoip_database` and
  `geoip_asn_database` point at the two files, as if set by hand.
- **One at a time**: a second request while one runs gets 409.
- **Credit.** The web UI credits DB-IP ("IP geolocation by DB-IP", linked,
  CC BY 4.0) wherever it shows their data: peers' countries and networks,
  Stats › Peers & geo, and the GeoIP settings. Files supplied by hand stay
  supported, from any source; the UI credits DB-IP when the loaded
  database is theirs.

## Consequences

- The daemon makes an outgoing HTTPS request to `download.db-ip.com` when
  someone with API access asks for it; nothing else changes about when it
  goes online.
- The web UI can set geolocation up in one click, and update it the same
  way; `GET /app` → `geoip` → `built` says how old the files are.
