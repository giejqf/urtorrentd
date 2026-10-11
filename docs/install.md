# Install and run

## Requirements

- **Linux 6.1 or newer with io_uring enabled** (`sysctl kernel.io_uring_disabled` is `0`).
  There is no fallback: without io_uring the daemon exits at start with an error naming
  what is missing.
- **Not Ubuntu 24.04's 6.8.0 kernels from 6.8.0-136 on** (still so in -146): a backport
  inverted a check in `io_uring/kbuf.c`, so the kernel rejects every provided buffer ring
  and the daemon stops at start with `provided buffer ring: Invalid argument`. Use the HWE
  kernel (`linux-generic-hwe-24.04`) or another distribution's.
- **In a container**, a seccomp profile that allows the `io_uring_*` system calls.
  Docker's default profile blocks them; urtorrent ships one that works
  (`testkit/docker/seccomp-io_uring.json` in the library's repository).
- **To build**: Rust 1.98 (the repository pins it in `rust-toolchain.toml`), and Node.js 22
  for the web UI.

## Build

```sh
cargo xtask dist                         # web UI + release binary: target/release/urtorrentd
cargo build --release -p urtorrentd      # the API only, without the web UI
```

A binary without the UI built in can serve a build of it from a directory:
`npm run build` in `frontend/`, then `--web-ui frontend/dist`.

## Run

```sh
urtorrentd --data-dir /var/lib/urtorrentd --api-listen 127.0.0.1:8080
```

| Option | Environment | Default |
|---|---|---|
| `--data-dir <DIR>` | `URTORRENTD_DATA_DIR` | `$XDG_DATA_HOME/urtorrentd`, else `~/.local/share/urtorrentd` |
| `--api-listen <ADDR>` | `URTORRENTD_API_LISTEN` | `127.0.0.1:8080` (loopback only) |
| `--web-ui <DIR>` | `URTORRENTD_WEB_UI` | the UI built into the binary, if any |
| `--no-web-ui` | | serve the API only |
| `--initial-settings <FILE>` | `URTORRENTD_INITIAL_SETTINGS` | the first settings of a new data directory ([settings](settings.md)) |
| `--geoip-mirror <URL>` | `URTORRENTD_GEOIP_MIRROR` | `https://download.db-ip.com/free` ([geolocation](settings.md#geolocation)) |

Subcommands: `run` (the default), `passwd --username <NAME>` (sets the login while the
daemon is stopped; the password is read from stdin) and `openapi` (prints the schema).
Logs go to stderr; `RUST_LOG` filters them (default `info`), and `GET /api/v1/log` keeps
the recent ones.

SIGTERM and SIGINT stop the daemon gracefully, as `POST /api/v1/app/shutdown` does: the
trackers hear `stopped`, and every torrent's state is saved first.

## First sign-in

Until a password is set, the first client to choose one sets it: the web UI asks for it,
and scripts call `POST /api/v1/auth/setup` with `{"username": ..., "password": ...}`
([ADR 0007](adr/0007-first-run-setup.md)). Meanwhile the daemon prints a temporary
password for the user `admin` at every start. **With `--api-listen` on a reachable
address, set the credentials before anyone else can.**

Change them later with `PUT /api/v1/auth/credentials` (or in the web UI), or while the
daemon is stopped:

```sh
echo 'a new password' | urtorrentd passwd --username admin
```

## Data and backups

Everything the daemon keeps is in its data directory:

| File | What |
|---|---|
| `urtorrentd.db` | Settings, credentials (hashed), torrents with their metainfo and resume data, categories, tags, RSS, webhooks, client data ([ADR 0004](adr/0004-sqlite.md)) |
| `stats.db` | Recorded history ([ADR 0005](adr/0005-statistics.md)). Disposable: deleting it loses the history only |
| `geoip/` | DB-IP Lite databases, when downloaded on request |

Back the database up while the daemon runs:

```sh
sqlite3 /var/lib/urtorrentd/urtorrentd.db ".backup urtorrentd-backup.db"
```

New torrents are saved to `~/Downloads` unless the `save_path` setting says otherwise.

## As a systemd service

```ini
# /etc/systemd/system/urtorrentd.service
[Unit]
Description=urtorrentd BitTorrent daemon
After=network-online.target
Wants=network-online.target

[Service]
User=urtorrentd
ExecStart=/usr/local/bin/urtorrentd --data-dir /var/lib/urtorrentd
StateDirectory=urtorrentd
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

Set the `save_path` setting to where downloads belong (the default is the service
user's `~/Downloads`). `journalctl -u urtorrentd` shows the temporary password of the
first start.
`POST /api/v1/app/restart` restarts the daemon in the same process, so systemd sees no
exit.

## HTTPS and remote access

The daemon speaks plain HTTP. For access from other machines, put a reverse proxy that
terminates TLS in front, such as Caddy:

```
torrents.example.com {
    reverse_proxy 127.0.0.1:8080
}
```

Then set `api_trusted_proxies` and `api_allowed_hosts`:
[settings › the web UI and reverse proxies](settings.md#the-web-ui-and-reverse-proxies).
