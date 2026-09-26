// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import type { Schemas } from "~/api/client";

import { banKind, bansPerDay, coverage, parseBans } from "./bans";
import {
  bitTorrentDiff,
  bitTorrentDraft,
  connectionDiff,
  connectionDraft,
  hostPortProblem,
  isIpv4,
  isIpv6,
  randomPort,
} from "./network-form";

const saved = {
  listen_port: 6881,
  random_port: false,
  listen_interface: null,
  listen_v4: "0.0.0.0",
  listen_v6: null,
  transports: "prefer_tcp",
  dht: true,
  pex: true,
  lsd: false,
  dht_bootstrap_nodes: null,
  encryption: "enabled",
  identity: "native",
} as unknown as Schemas["Settings"];

describe("addresses", () => {
  it("reads them as the daemon does", () => {
    expect(isIpv4("10.0.0.1")).toBe(true);
    expect(isIpv4("10.0.0.256")).toBe(false);
    expect(isIpv4("010.0.0.1")).toBe(false);
    expect(isIpv6("::")).toBe(true);
    expect(isIpv6("fd00::1")).toBe(true);
    expect(isIpv6("fd00::zz")).toBe(false);
    expect(isIpv6("1.2.3.4")).toBe(false);
  });
});

describe("the connection form", () => {
  it("keeps an address that is off and sends null", () => {
    const d = connectionDraft(saved);
    expect(d.listen_v6).toBe("::");
    expect(connectionDiff(saved, d).changed.size).toBe(0);
    const r = connectionDiff(saved, {
      ...d,
      listen_port: "51413",
      listen_v4_on: false,
      listen_v6_on: true,
      listen_interface: "wg0",
      transports: "utp_only",
    });
    expect(r.patch).toEqual({
      listen_port: 51_413,
      listen_interface: "wg0",
      listen_v4: null,
      listen_v6: "::",
      transports: "utp_only",
    });
    expect(
      connectionDraft({ ...saved, listen_v4: null }, { ...d, listen_v4: "10.0.0.2" }).listen_v4,
    ).toBe("10.0.0.2");
  });

  it("says what the daemon would refuse", () => {
    const d = connectionDraft(saved);
    const r = connectionDiff(saved, { ...d, listen_port: "70000", listen_v4: "10.0.0" });
    expect(r.errors).toEqual({
      listen_port: "A port from 0 to 65535.",
      listen_v4: "An IPv4 address such as 0.0.0.0.",
    });
    expect(connectionDiff(saved, { ...d, listen_v4_on: false }).errors.listen_v4).toBe(
      "IPv4 and IPv6 cannot both be off.",
    );
    const p = randomPort(() => 0.5);
    expect(p).toBe(35_000);
  });
});

describe("the BitTorrent form", () => {
  it("sends the identity's routers as null and our own as a list", () => {
    const d = bitTorrentDraft(saved);
    expect(d.dht_bootstrap_custom).toBe(false);
    expect(bitTorrentDiff(saved, d).changed.size).toBe(0);
    const own = { ...d, dht_bootstrap_custom: true, dht_bootstrap_nodes: ["10.0.0.9:6881"] };
    expect(bitTorrentDiff(saved, own).patch).toEqual({ dht_bootstrap_nodes: ["10.0.0.9:6881"] });
    // An empty list of our own is no router at all, not the identity's.
    expect(bitTorrentDiff(saved, { ...own, dht_bootstrap_nodes: [] }).patch).toEqual({
      dht_bootstrap_nodes: [],
    });
    expect(
      bitTorrentDiff({ ...saved, dht_bootstrap_nodes: ["a:1"] } as Schemas["Settings"], d).patch,
    ).toEqual({ dht_bootstrap_nodes: null });
    expect(hostPortProblem("router.example.org:6881")).toBeNull();
    expect(hostPortProblem("[fd00::1]:6881")).toBeNull();
    expect(hostPortProblem("router.example.org")).not.toBeNull();
    expect(hostPortProblem("host:0")).not.toBeNull();
  });
});

describe("bans", () => {
  it("sorts what was typed into addresses and ranges, ports dropped", () => {
    expect(
      parseBans(
        "203.0.113.7:6881, [fd00::5]:1 10.0.0.0/8  1.2.3.0-1.2.4.255, fd00::/8 nope 5.6.7.8-1.1.1.1",
      ),
    ).toEqual({
      ips: ["203.0.113.7", "fd00::5"],
      ranges: ["10.0.0.0/8", "1.2.3.0-1.2.4.255", "fd00::/8"],
      bad: ["nope", "5.6.7.8-1.1.1.1"],
    });
    expect(banKind("10.0.0.0/8")).toBe("CIDR");
    expect(banKind("1.2.3.0-1.2.4.255")).toBe("range");
    expect(banKind("fd00::5")).toBe("single");
  });

  it("counts the IPv4 addresses covered once", () => {
    expect(
      coverage(
        ["10.0.0.1", "192.168.0.1", "fd00::1"],
        ["10.0.0.0/24", "10.0.0.128-10.0.1.9", "fd00::/8"],
      ),
    ).toEqual({
      v4: 256 + 10 + 1,
      v6Entries: 2,
    });
  });

  it("counts bans per day by who made them", () => {
    const now = new Date(2026, 8, 26, 12, 0);
    const at = (d: number, h: number) => new Date(2026, 8, d, h).getTime() / 1000;
    const e = (time: number, banned: boolean, source: "engine" | "settings") =>
      ({
        id: 0,
        time,
        ip: "1.2.3.4",
        banned,
        source,
        torrent: null,
        reason: "",
      }) as Schemas["PeerLogEntry"];
    const days = bansPerDay(
      [
        e(at(26, 8), true, "engine"),
        e(at(26, 9), true, "settings"),
        e(at(25, 1), true, "engine"),
        e(at(26, 10), false, "settings"),
        e(at(1, 1), true, "engine"),
      ],
      now,
      3,
    );
    expect(days.map((d) => [d.day.getDate(), d.engine, d.settings])).toEqual([
      [24, 0, 0],
      [25, 1, 0],
      [26, 1, 1],
    ]);
  });
});
