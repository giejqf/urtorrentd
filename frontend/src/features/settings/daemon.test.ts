// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import type { Schemas } from "~/api/client";

import { diagnostics, uptime } from "./about-view";
import { engineDiff, engineDraft, pendingChanges, revertPatch } from "./engine-form";
import {
  blockProblem,
  hostAllowed,
  hostProblem,
  maskValue,
  originProblem,
  parseCookie,
  sameCookie,
  securityDiff,
  keyAbbrev,
  securityDraft,
  shortAgent,
} from "./security-form";
import {
  axis,
  daysLabel,
  locatedShare,
  parseDays,
  statsDiff,
  statsDraft,
  tierLabel,
  tiers,
} from "./statistics-form";

const running = {
  dht_bootstrap_nodes: null,
  hash_threads: 2,
  max_open_files: 512,
  max_checking: 1,
  piece_extent_affinity: true,
  max_concurrent_announces: 32,
  disk_thread: true,
  zero_copy_send: false,
} satisfies Schemas["RestartSettings"];

const saved = {
  ...running,
  api_session_timeout: 3600,
  api_max_auth_failures: 5,
  api_ban_duration: 900,
  api_bypass_local_auth: false,
  api_auth_whitelist: [],
  api_trusted_proxies: ["127.0.0.1"],
  api_allowed_hosts: ["localhost", "*.ts.net"],
  api_csrf_protection: true,
  api_cors_origins: [],
  stats_enabled: true,
  stats_minute_retention: 2 * 86_400,
  stats_hour_retention: 90 * 86_400,
  stats_day_retention: null,
  stats_scrape_interval: null,
  geoip_database: null,
  geoip_asn_database: "/var/lib/GeoIP/GeoLite2-ASN.mmdb",
  identity: "native",
  encryption: "enabled",
  transports: "prefer_tcp",
  dht: true,
  pex: true,
  lsd: false,
  listen_interface: "wg0",
  listen_v4: "0.0.0.0",
  listen_v6: null,
  queueing_enabled: true,
  max_active_downloads: 3,
  max_active_uploads: null,
  max_active_torrents: 5,
} as unknown as Schemas["Settings"];

describe("engine", () => {
  it("saves counts of at least 1 and switches", () => {
    const d = engineDraft(saved);
    expect(engineDiff(saved, d).changed.size).toBe(0);
    const next = engineDiff(saved, { ...d, hash_threads: "4", disk_thread: false });
    expect(next.patch).toEqual({ hash_threads: 4, disk_thread: false });
    expect(next.names).toEqual(["hash_threads", "disk_thread"]);
    for (const bad of ["0", "", "1.5", "x"]) {
      expect(engineDiff(saved, { ...d, max_checking: bad }).errors.max_checking).toBeDefined();
    }
  });

  it("says what waits for a restart, and how to go back", () => {
    const later = { ...saved, hash_threads: 4, disk_thread: false, dht_bootstrap_nodes: [] };
    const pending = pendingChanges(later, running, [
      "dht_bootstrap_nodes",
      "hash_threads",
      "disk_thread",
      "listen_port",
    ]);
    expect(pending).toEqual([
      { setting: "dht_bootstrap_nodes", running: "the identity's", saved: "0 routers" },
      { setting: "hash_threads", running: "2", saved: "4" },
      { setting: "disk_thread", running: "on", saved: "off" },
    ]);
    expect(revertPatch(pending, running)).toEqual({
      dht_bootstrap_nodes: null,
      hash_threads: 2,
      disk_thread: true,
    });
    // Saved back to what runs: nothing waits, whatever the list says.
    expect(pendingChanges(saved, running, ["hash_threads"])).toEqual([]);
  });
});

describe("security", () => {
  it("checks blocks, hosts and origins as the daemon reads them", () => {
    for (const ok of ["10.0.0.0/8", "10.66.0.1", "fd00::/8", "::1"]) {
      expect(blockProblem(ok)).toBeNull();
    }
    for (const bad of ["10.0.0.0/33", "10.0.0/8", "fd00::/129", "lan", "10.0.0.0/8/1"]) {
      expect(blockProblem(bad)).not.toBeNull();
    }
    for (const ok of ["*", "localhost", "*.example.com", "seedbox.home.arpa"]) {
      expect(hostProblem(ok)).toBeNull();
    }
    for (const bad of ["http://x", "a b", "*example.com", "-x"]) {
      expect(hostProblem(bad)).not.toBeNull();
    }
    for (const ok of ["https://ui.example.com", "http://localhost:5173", "http://[::1]:8080"]) {
      expect(originProblem(ok)).toBeNull();
    }
    for (const bad of ["ui.example.com", "https://ui.example.com/", "https://*.example.com"]) {
      expect(originProblem(bad)).not.toBeNull();
    }
  });

  it("matches hosts as the daemon's Host check does", () => {
    expect(hostAllowed("127.0.0.1:8080", [])).toBe(true);
    expect(hostAllowed("[::1]:8080", [])).toBe(true);
    expect(hostAllowed("LOCALHOST:8080", ["localhost"])).toBe(true);
    expect(hostAllowed("box.tail3f9c.ts.net", ["*.ts.net"])).toBe(true);
    expect(hostAllowed("ts.net", ["*.ts.net"])).toBe(false);
    expect(hostAllowed("evil.test", ["*"])).toBe(true);
  });

  it("saves limits and lists, and never the host this page is on out", () => {
    const d = securityDraft(saved);
    expect(d.api_session_timeout).toBe("1");
    expect(d.api_session_timeout_unit).toBe("hours");
    expect(d.api_ban_duration).toBe("15");
    expect(d.api_ban_duration_unit).toBe("minutes");
    expect(securityDiff(saved, d, "localhost:8080").changed.size).toBe(0);
    const next = securityDiff(
      saved,
      { ...d, api_session_timeout: "24", api_cors_origins: ["https://ui.example"] },
      null,
    );
    expect(next.patch).toEqual({
      api_session_timeout: 86_400,
      api_cors_origins: ["https://ui.example"],
    });
    expect(
      securityDiff(
        saved,
        { ...d, api_session_timeout: "0.5", api_session_timeout_unit: "minutes" },
        null,
      ).errors.api_session_timeout,
    ).toBeDefined();
    expect(
      securityDiff(saved, { ...d, api_max_auth_failures: "0" }, null).errors.api_max_auth_failures,
    ).toBeDefined();
    const locked = securityDiff(saved, { ...d, api_allowed_hosts: ["*.ts.net"] }, "localhost:8080");
    expect(locked.errors.api_allowed_hosts).toContain("localhost");
    expect(
      securityDiff(saved, { ...d, api_allowed_hosts: ["*"] }, "localhost:8080").errors,
    ).toEqual({});
  });

  it("names clients in a word or two", () => {
    expect(
      shortAgent("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0"),
    ).toBe("Firefox · Linux");
    expect(
      shortAgent(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari · iPhone");
    expect(
      shortAgent(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0",
      ),
    ).toBe("Edge · Windows");
    expect(shortAgent("curl/8.9.1")).toBe("curl/8.9.1");
    expect(shortAgent("python-requests/2.32.3")).toBe("python-requests/2.32.3");
    expect(shortAgent(null)).toBe("unknown client");
  });

  it("reads cookies as Set-Cookie lines", () => {
    const now = 1_790_000_000;
    expect(parseCookie("uid=48213; Domain=.Tracker.example; Path=/", now)).toEqual({
      name: "uid",
      value: "48213",
      domain: "tracker.example",
      path: "/",
    });
    expect(parseCookie("pass=9f3c; Domain=tracker.example; Max-Age=60", now)).toMatchObject({
      expires: now + 60,
    });
    expect(
      parseCookie("pass=x; Domain=t.example; Expires=Wed, 03 Mar 2027 10:00:00 GMT", now),
    ).toMatchObject({ expires: Date.UTC(2027, 2, 3, 10) / 1000 });
    expect(parseCookie("pass=x", now)).toContain("Domain");
    expect(parseCookie("=x; Domain=t.example", now)).toContain("name=value");
    expect(parseCookie("a=b; Domain=t.example; Expires=soon", now)).toContain("not a date");
    expect(maskValue("48213")).toBe("48213");
    expect(maskValue("9f3c0a2be1")).toBe("9f3c…e1");
    const a = { name: "a", value: "1", domain: "t.example" };
    expect(sameCookie(a, { ...a, value: "2", path: "/" })).toBe(true);
    expect(sameCookie(a, { ...a, path: "/x" })).toBe(false);
  });
});

describe("statistics", () => {
  it("keeps retention in days, empty for forever", () => {
    const d = statsDraft(saved);
    expect(d.stats_minute_retention).toBe("2");
    expect(d.stats_day_retention).toBe("");
    expect(d.scrape).toBe(false);
    expect(d.stats_scrape_interval).toBe("60");
    expect(statsDiff(saved, d).changed.size).toBe(0);
    expect(parseDays("0.5")).toBe(43_200);
    expect(parseDays("0")).toBeUndefined();
    expect(parseDays("∞")).toBeNull();
    const next = statsDiff(saved, {
      ...d,
      stats_minute_retention: "7",
      stats_hour_retention: "",
      scrape: true,
      stats_scrape_interval: "45",
      geoip_database: "/var/lib/GeoIP/GeoLite2-Country.mmdb",
      geoip_asn_database: "",
    });
    expect(next.patch).toEqual({
      stats_minute_retention: 7 * 86_400,
      stats_hour_retention: null,
      stats_scrape_interval: 2700,
      geoip_database: "/var/lib/GeoIP/GeoLite2-Country.mmdb",
      geoip_asn_database: null,
    });
    expect(
      statsDiff(saved, { ...d, scrape: true, stats_scrape_interval: "10" }).errors,
    ).toHaveProperty("stats_scrape_interval");
    expect(statsDiff(saved, { ...d, geoip_database: "GeoLite2.mmdb" }).errors).toHaveProperty(
      "geoip_database",
    );
    // Scrape off again: null, the minutes kept for later.
    const scraping = { ...saved, stats_scrape_interval: 3600 };
    const off = statsDiff(scraping, { ...statsDraft(scraping), scrape: false });
    expect(off.patch).toEqual({ stats_scrape_interval: null });
    expect(statsDraft(saved, statsDraft(scraping)).stats_scrape_interval).toBe("60");
  });

  it("draws what is on disk against where retention cuts it", () => {
    const now = 400 * 86_400;
    const t = tiers(
      { oldest_minute: now - 6.2 * 86_400, oldest_hour: now - 89 * 86_400, oldest_day: null },
      {
        stats_minute_retention: 7 * 86_400,
        stats_hour_retention: 90 * 86_400,
        stats_day_retention: null,
      },
      now,
    );
    expect(t.map(tierLabel)).toEqual([
      "6.2 d on disk · cut at 7 d",
      "89 d on disk · cut at 90 d",
      "nothing on disk yet · kept forever",
    ]);
    const ax = axis(t, 120, 728);
    expect(ax.x(1 / 24)).toBe(728);
    expect(ax.x(365)).toBeCloseTo(120);
    expect(ax.x(7)).toBeLessThan(ax.x(1));
    expect(ax.ticks.map((x) => x.label)).toEqual(["1 h", "1 d", "7 d", "30 d", "90 d", "1 y"]);
    // History older than a year widens the axis.
    const long = axis([{ name: "Days", have: 500, keep: null }], 120, 728);
    expect(long.max).toBe(730);
    expect(long.ticks.at(-1)?.label).toBe("2 y");
    expect(daysLabel(0.1)).toBe("2 h");
    expect(daysLabel(0.01)).toBe("14 min");
    // Today's day bucket is one day on disk.
    const today = { oldest_minute: null, oldest_hour: null, oldest_day: now - 3600 };
    const forever = {
      stats_minute_retention: null,
      stats_hour_retention: null,
      stats_day_retention: null,
    };
    expect(tiers(today, forever, now)[2]?.have).toBe(1);
  });

  it("counts the peer traffic GeoIP located", () => {
    const row = (country: string | null, bytes: number) => ({
      country,
      asn: null,
      downloaded: bytes,
      uploaded: 0,
    });
    expect(locatedShare([row("NZ", 97), row(null, 3)], "country")).toBeCloseTo(0.97);
    expect(locatedShare([row("NZ", 97)], "asn")).toBe(0);
    expect(locatedShare([], "country")).toBeNull();
  });
});

describe("about", () => {
  it("says uptime as the design does", () => {
    expect(uptime(12 * 86_400 + 4 * 3600 + 5)).toBe("12 d 4 h");
    expect(uptime(59)).toBe("59 s");
  });

  it("reports without addresses, paths, URLs or names", () => {
    const app = {
      version: "0.13.0",
      api_version: "v1",
      library: "urtorrent/0.13.6",
      pid: 1184,
      started_at: 1_790_000_000,
      data_dir: "/home/alice/.local/share/urtorrentd",
      default_save_path: "/home/alice/Downloads",
      listen_port: 51413,
      restart_required: ["hash_threads"],
      geoip: {
        country: {
          path: "/home/alice/GeoLite2-Country.mmdb",
          database_type: "GeoLite2-Country",
          built: 1_789_000_000,
          loaded: 1_790_000_000,
          error: null,
        },
        asn: null,
      },
      instance_name: "alice's seedbox",
      listen_addresses: ["10.66.0.7"],
      fetched_trackers: {
        url: "https://example.org/list.txt?key=secret",
        trackers: ["udp://tracker.example:1337/announce"],
        fetched: 1,
        error: null,
        fetching: false,
      },
      time_zone: "Pacific/Auckland",
      running,
      restart_required_since: 1_790_000_100,
      restart_waiting: false,
    } satisfies Schemas["AppInfo"];
    const text = diagnostics({
      app,
      system: {
        cpus: 16,
        cpu_model: "AMD EPYC 7302P",
        kernel: "6.8.0",
        memory: 64e9,
        open_files_limit: 65_536,
        open_files_hard_limit: 1_048_576,
        open_files: 2231,
        save_path_fs: {
          path: "/home/alice/Downloads",
          mount_point: "/home",
          fs_type: "ext4",
          total: 4e12,
          free: 1.21e12,
        },
      },
      settings: saved,
      stats: {
        enabled: true,
        size: 38.4e6,
        torrents: 112,
        removed: 100,
        oldest_minute: null,
        oldest_hour: null,
        oldest_day: null,
      },
      transfer: null,
      states: { seeding: 3, downloading: 1 },
      pending: [{ setting: "hash_threads", running: "2", saved: "4" }],
      ui: "0.13.0",
      browser: "Firefox/140",
      now: 1_790_000_000 + 3700,
    });
    expect(text).toContain("urtorrentd 0.13.0 · API v1 · urtorrent/0.13.6");
    expect(text).toContain("Save path: ext4 · 4.0 TB · 1.2 TB free");
    expect(text).toContain("Waiting for a restart: hash_threads 2 → 4");
    expect(text).toContain("Torrents: 4 (seeding 3, downloading 1)");
    expect(text).toContain("interface pinned");
    for (const secret of [
      "alice",
      "10.66.0.7",
      "example.org",
      "secret",
      "/home",
      "wg0",
      "Auckland",
    ]) {
      expect(text).not.toContain(secret);
    }
  });
});

describe("a new API key", () => {
  it("shows its start and end beside it", () => {
    expect(keyAbbrev(`urtd_${"9f3c".padEnd(44, "0")}6e7f`)).toBe("urtd_9f3c…6e7f");
    expect(keyAbbrev("short")).toBe("short");
  });
});
