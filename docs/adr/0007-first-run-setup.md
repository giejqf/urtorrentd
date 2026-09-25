# ADR 0007: First-run setup of the credentials

Status: accepted (2026-09-24, maintainer decision). Amended by [ADR 0008](0008-web-ui.md): origins listed in `api_cors_origins` get their preflights granted.

## Context

Until 0.12.0, a daemon without a password printed a temporary one at every
start; a client logged in with it and then set permanent credentials
(`PUT /auth/credentials`), or the operator ran `urtorrentd passwd`. A client
UI could not offer a "create your account" screen: it had no way to tell
that the daemon was waiting for credentials, and it needed the printed
password first.

The maintainer's decision: while no credentials exist, the first client
creates them, with no code (the onboarding of Home Assistant or Jellyfin).
The alternatives were a setup code (the printed temporary password) and a
code required only from non-loopback clients.

## Decision

- `GET /auth/status` (public) answers `{"setup_required": true}` while no
  password is stored.
- `POST /auth/setup` (public) takes a user name and password (the rules of
  `PUT /auth/credentials`: 1 to 128 characters, 8 to 1024), stores them,
  ends every session and answers `204` with a session cookie. Once a
  password is stored it answers `409 conflict`, and after a restart too.
- **One caller wins**: the claim is an atomic check-and-set on the
  credentials in memory, before they are written; a second caller fails
  however the two interleave. If the write fails the claim is undone.
- The temporary password is still printed at start and works until setup
  (scripts, and an operator who wants to set the credentials first); it and
  the sessions opened with it end at setup. `urtorrentd passwd` still sets
  credentials while the daemon is stopped.
- The setup is logged with the caller's address.

## Risks and mitigations

Whoever reaches the API first while no credentials exist owns the daemon,
and with it save paths, directory listings and deleting with files.

- The API listens on `127.0.0.1` by default; exposing it is a deliberate
  `--api-listen`. The startup line says that the first caller of
  `POST /auth/setup` chooses the credentials.
- A web page cannot claim a local daemon through its visitor's browser: a
  cross-origin `Origin` / `Referer` is refused (with `api_csrf_protection`,
  the default), the body must be `application/json` (a cross-site request
  with it needs a CORS preflight, which the daemon never grants), and DNS
  rebinding fails the `Host` check (`api_allowed_hosts`).
- An operator who exposes the API before the first client connects should
  set the credentials first (`urtorrentd passwd`, or the temporary
  password).

## Consequences

- Client UIs can offer onboarding: `GET /auth/status`, then either a setup
  form or a login form.
- qBittorrent has no such flow; it is ours, like the API it belongs to.
