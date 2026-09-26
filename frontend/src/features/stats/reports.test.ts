// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import type { Schemas } from "~/api/client";

import {
  coverage,
  idleCsv,
  idleSummary,
  idleUnkept,
  logScale,
  logTicks,
  sizeRange,
  valueClass,
  windowOf,
} from "./idle-view";
import {
  arc,
  countryFlows,
  countryName,
  countryPoint,
  flowWidth,
  historyFlows,
  historySplit,
  liveConnections,
  peerIp,
  project,
  totals,
} from "./peers-view";
import {
  attention,
  contexts,
  describe as describeEvent,
  feedRows,
  hiddenKinds,
  kindCounts,
  lanes,
  medianDownload,
  timelineCsv,
} from "./timeline-view";
import { COUNTRY_POINTS, LAND } from "./world";

const DAY = 86_400;
const NOW = Date.UTC(2026, 8, 26, 10, 41) / 1000;

function seed(hash: string, size: number, value: number, extra: Partial<Schemas["IdleSeed"]> = {}) {
  return {
    hash,
    name: `T ${hash}`,
    size,
    uploaded: Math.round(size * value),
    value,
    seeding_time: 10 * DAY,
    last_upload: null,
    ratio: 1,
    added_on: NOW - 40 * DAY,
    state: "seeding",
    category: null,
    tracker: null,
    ...extra,
  } satisfies Schemas["IdleSeed"];
}

describe("idle seeds", () => {
  const SEEDS = [seed("a", 3e9, 0), seed("b", 5e8, 0.05), seed("c", 2e9, 0.5), seed("d", 1e10, 8)];

  it("classes, sums and picks the idle ones not kept", () => {
    expect([0, 0.099, 0.1, 0.99, 1].map(valueClass)).toEqual([
      "idle",
      "idle",
      "low",
      "low",
      "earning",
    ]);
    expect(idleSummary(SEEDS)).toEqual({
      size: 1.55e10,
      idle: { count: 2, size: 3.5e9 },
      others: { count: 2, uploaded: 1e9 + 8e10 },
    });
    const tags = (h: string) => (h === "b" ? ["keep"] : []);
    expect(idleUnkept(SEEDS, tags).map((s) => s.hash)).toEqual(["a"]);
    expect(windowOf("90")).toBe("90");
    expect(windowOf("12")).toBe("30");
  });

  it("says how much of the window was recorded", () => {
    expect(coverage(NOW - 30 * DAY, NOW - 40 * DAY, NOW)).toEqual({ kind: "full" });
    expect(coverage(NOW - 30 * DAY, NOW - 12 * DAY, NOW)).toEqual({
      kind: "partial",
      seconds: 12 * DAY,
    });
    expect(coverage(NOW - 30 * DAY, null, NOW)).toEqual({ kind: "none" });
  });

  it("lays out log axes", () => {
    expect(sizeRange(SEEDS)).toEqual([1e8, 1e10]);
    const x = logScale(1e8, 1e10, 0, 200);
    expect(x(1e9)).toBeCloseTo(100);
    expect(x(1)).toBe(0);
    expect(logTicks(1e8, 1e10)).toEqual([1e8, 2e8, 5e8, 1e9, 2e9, 5e9, 1e10]);
    expect(logTicks(0.001, 100)).toEqual([0.001, 0.01, 0.1, 1, 10, 100]);
  });

  it("exports CSV with quoting and UTC times", () => {
    const csv = idleCsv([seed("x", 10, 0.5, { name: 'a, "b"', last_upload: 0 })], 30);
    expect(csv.split("\n")[0]).toBe(
      "name,hash,size_bytes,uploaded_30d_bytes,value,seeding_30d_seconds,last_upload_utc,ratio,tracker,state,category",
    );
    expect(csv.split("\n")[1]).toBe(
      '"a, ""b""",x,10,5,0.5000,864000,1970-01-01T00:00:00.000Z,1.000,,seeding,',
    );
  });
});

function ev(
  t: number,
  kind: Schemas["TimelineKind"],
  hash = "h1",
  extra: Partial<Schemas["TimelineEvent"]> = {},
): Schemas["TimelineEvent"] {
  return { t, hash, name: `N ${hash}`, kind, state: null, detail: null, ...extra };
}

describe("the timeline", () => {
  const T0 = NOW - 10 * DAY;
  const EVENTS = [
    ev(T0, "added"),
    ev(T0 + 3600, "finished"),
    ev(T0 + 5 * DAY, "state", "h1", { state: "stopped" }),
    ev(T0 + 2 * DAY, "added", "h2"),
    ev(T0 + 2 * DAY + 60, "metadata", "h2"),
    ev(T0 + 3 * DAY, "error", "h2", { detail: "disk full" }),
    ev(T0 - 20 * DAY, "added", "h3"),
    ev(T0 + 4 * DAY, "removed", "h3"),
  ];

  it("counts kinds and reads hidden ones from the URL", () => {
    expect(kindCounts(EVENTS)).toMatchObject({ added: 3, finished: 1, state: 1, removed: 1 });
    expect([...hiddenKinds("state,nope,moved")]).toEqual(["state", "moved"]);
  });

  it("draws a lane per torrent from what events establish", () => {
    const current = (h: string) =>
      h === "h2" ? ("downloading" as const) : h === "h1" ? ("stopped" as const) : null;
    const l = lanes(EVENTS, T0 - DAY, NOW, current);
    expect(l.map((x) => x.hash)).toEqual(["h1", "h3", "h2"]);
    const h1 = l[0];
    expect(h1?.segments).toEqual([
      { from: T0, to: T0 + 3600, state: "downloading" },
      { from: T0 + 3600, to: T0 + 5 * DAY, state: "seeding" },
      { from: T0 + 5 * DAY, to: NOW, state: "stopped" },
    ]);
    expect(h1?.before).toBe(false);
    // Added before the range: the lane starts at the range; removed: it ends.
    const h3 = l[1];
    expect(h3).toMatchObject({ before: true, removed: T0 + 4 * DAY });
    expect(h3?.segments).toEqual([{ from: T0 - DAY, to: T0 + 4 * DAY, state: "unknown" }]);
    // After its last event, the state now.
    expect(l[2]?.segments.at(-1)).toEqual({
      from: T0 + 2 * DAY + 60,
      to: NOW,
      state: "downloading",
    });
  });

  it("says what happened, with the state before and the time from adding", () => {
    const ctx = contexts(EVENTS);
    const finished = EVENTS[1];
    const stopped = EVENTS[2];
    if (!finished || !stopped) throw new Error("fixture");
    const f = ctx.get(finished) ?? { previous: null, added: null };
    expect(describeEvent(finished, f.previous, f.added)).toEqual({
      verb: "finished downloading",
      object: "",
      detail: "in 1h from adding",
    });
    const s = ctx.get(stopped) ?? { previous: null, added: null };
    // Finishing is not a state change: the one after it says what came.
    expect(describeEvent(stopped, s.previous, s.added).object).toBe("→ Stopped");
    const two = [
      ev(1, "state", "x", { state: "seeding" }),
      ev(2, "state", "x", { state: "stopped" }),
    ];
    const second = two[1];
    if (!second) throw new Error("fixture");
    const c = contexts(two).get(second) ?? { previous: null, added: null };
    expect(describeEvent(second, c.previous, c.added).object).toBe("Seeding → Stopped");
    expect(describeEvent(ev(0, "moved", "x", { detail: "/data/movies" }), null, null)).toEqual({
      verb: "was moved to",
      object: "/data/movies",
      detail: "",
    });
  });

  it("groups the feed by day and sums the range", () => {
    const rows = feedRows(EVENTS.slice(0, 3), NOW, { timeZone: "UTC" });
    expect(rows.map((r) => (r.kind === "day" ? `${r.label} ${r.count}` : r.event.kind))).toEqual([
      "Mon 21 Sep 1",
      "state",
      "Wed 16 Sep 2",
      "finished",
      "added",
    ]);
    expect(medianDownload(EVENTS, T0 - DAY, NOW)).toBe(3600);
    expect(medianDownload(EVENTS, NOW - DAY, NOW)).toBeNull();
    expect(timelineCsv([ev(0, "error", "h", { detail: "a,b" })])).toBe(
      'time_utc,kind,hash,name,state,detail\n1970-01-01T00:00:00.000Z,error,h,N h,,"a,b"\n',
    );
  });

  it("finds what needs attention now", () => {
    const t = (hash: string, state: Schemas["TorrentState"], added: number) =>
      ({ hash, state, added_on: added }) as Schemas["TorrentSummary"];
    const a = attention(
      [t("e", "error", 0), t("m", "metadata", NOW - 7200), t("n", "metadata", NOW - 60)],
      NOW,
    );
    expect(a.errors.map((x) => x.hash)).toEqual(["e"]);
    expect(a.waiting.map((x) => x.hash)).toEqual(["m"]);
  });
});

function peer(
  address: string,
  country: string | null,
  down: number,
  up: number,
  extra: Partial<Schemas["TorrentPeer"]> = {},
): Schemas["TorrentPeer"] {
  return {
    hash: "h1",
    address,
    source: "tracker",
    incoming: false,
    transport: "tcp",
    encrypted: false,
    client: "qBittorrent",
    peer_id: null,
    progress: 0.5,
    is_seed: false,
    upload_only: false,
    downloaded: 0,
    uploaded: 0,
    download_rate: down,
    upload_rate: up,
    peer_choking: false,
    am_choking: false,
    peer_interested: false,
    am_interested: false,
    outstanding_requests: 0,
    connected_for: 10,
    country,
    asn: null,
    as_org: null,
    ...extra,
  };
}

describe("peers and places", () => {
  const PEERS = [
    peer("1.1.1.1:1", "DE", 100, 0),
    peer("2.2.2.2:2", "DE", 50, 300, {
      transport: "utp",
      encrypted: true,
      incoming: true,
      source: "dht",
    }),
    peer("3.3.3.3:3", "JP", 0, 10, { hash: "h2" }),
    peer("4.4.4.4:4", null, 5, 5),
  ];

  it("has a land grid and a point for each country", () => {
    expect(LAND).toHaveLength(71);
    expect(LAND.every((row) => row.length === 45)).toBe(true);
    expect(COUNTRY_POINTS.DE).toEqual([10.4, 51.1]);
    // Berlin-ish sits in the right place on a 360 × 142 map.
    const [x, y] = countryPoint("DE", 360, 142) ?? [0, 0];
    expect(x).toBeCloseTo(190.4);
    expect(y).toBeCloseTo(32.9);
    expect(countryPoint("ZZ", 360, 142)).toBeNull();
    expect(project(-180, 84, 1140, 450)).toEqual([0, 0]);
    expect(countryName("DE")).toBe("Germany");
    expect(countryName(null)).toBe("Not located");
  });

  it("sums peers by country, the unlocated apart", () => {
    expect(countryFlows(PEERS)).toEqual({
      flows: [
        { key: "DE", country: "DE", label: "DE", down: 150, up: 300, peers: 2 },
        { key: "JP", country: "JP", label: "JP", down: 0, up: 10, peers: 1 },
      ],
      unlocated: 1,
    });
    expect(totals(PEERS)).toEqual({
      down: 155,
      up: 315,
      sending: 3,
      receiving: 3,
      countries: 2,
      torrents: 2,
    });
    const rows = [
      { country: "FR", asn: null, as_org: null, downloaded: 5, uploaded: 20, peers_max: 3 },
      { country: null, asn: null, as_org: null, downloaded: 1, uploaded: 1, peers_max: 1 },
    ];
    expect(historyFlows(rows)).toEqual({
      flows: [{ key: "FR", country: "FR", label: "FR", down: 5, up: 20, peers: 3 }],
      unlocated: 2,
    });
  });

  it("draws curves and splits connections", () => {
    expect(arc([0, 0], [100, 0], 0.2)).toBe("M0.0 0.0Q50.0 20.0 100.0 0.0");
    expect(flowWidth(0, 10)).toBe(0);
    expect(flowWidth(10, 10)).toBe(6);
    const c = liveConnections(PEERS);
    expect(c.transport).toEqual([
      { label: "TCP", share: 0.75 },
      { label: "µTP", share: 0.25 },
    ]);
    expect(c.source[0]).toEqual({ label: "tracker", share: 0.75 });
    expect(
      historySplit({
        hash: null,
        from: 0,
        to: 0,
        step: "hour",
        dim: "encryption",
        rows: [
          { key: "rc4", downloaded: 30, uploaded: 10, peers_max: 1 },
          { key: "plaintext", downloaded: 60, uploaded: 0, peers_max: 1 },
        ],
        points: [],
        unattributed: { downloaded: 0, uploaded: 0 },
      }),
    ).toEqual([
      { label: "encrypted", share: 0.4 },
      { label: "plaintext", share: 0.6 },
    ]);
    const plain = liveConnections([peer("5.5.5.5:5", null, 0, 0)]);
    expect(plain.encryption).toEqual([
      { label: "encrypted", share: 0 },
      { label: "plaintext", share: 1 },
    ]);
    expect(peerIp("1.2.3.4:51413")).toBe("1.2.3.4");
    expect(peerIp("[2001:db8::1]:6881")).toBe("2001:db8::1");
  });
});
