// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import type { Schemas } from "~/api/client";

import { isolated, roundUp, stacked, tickLabel } from "./chart";
import {
  bucketIndex,
  bucketWords,
  chartBucket,
  datesLabel,
  dayStart,
  localDayStarts,
  OVERVIEW_PRESETS,
  previousRange,
  rangeOf,
  reportBars,
  TRACKER_PRESETS,
} from "./range";
import {
  announceBars,
  defaultTrackers,
  failingHosts,
  hideUrls,
  hostKind,
  stackSeries,
  success,
  trackerKpis,
  trackerLines,
  withoutTracker,
} from "./trackers-view";
import { change, peakPeers, rateSeries, reclaimable, shares, totals, valueTone } from "./view";

const UTC = { timeZone: "UTC" };
const NY = { timeZone: "America/New_York" };
const HOUR = 3600;
const DAY = 86_400;
// Sat 26 Sep 2026, 10:41 UTC.
const NOW = Date.UTC(2026, 8, 26, 10, 41) / 1000;

describe("ranges", () => {
  it("reads a preset, or days picked, from the URL", () => {
    const week = rangeOf({ range: "7d" }, OVERVIEW_PRESETS, "7d", NOW, null, UTC);
    expect(week).toMatchObject({ from: NOW - 7 * DAY, to: NOW, preset: "7d", length: 7 * DAY });
    expect(week.words).toBe("last 7 days");
    expect(week.previous).toBe("previous 7 days");
    // Today starts at the viewer's midnight, and compares with yesterday by this time.
    const today = rangeOf({ range: "today" }, OVERVIEW_PRESETS, "7d", NOW, null, NY);
    expect(today.from).toBe(Date.UTC(2026, 8, 26, 4) / 1000);
    expect(previousRange(today)).toEqual({ from: today.from - DAY, to: NOW - DAY });
    // All starts at the oldest bucket kept, with nothing before it.
    const all = rangeOf({ range: "all" }, OVERVIEW_PRESETS, "7d", NOW, NOW - 40 * DAY, UTC);
    expect(all.from).toBe(NOW - 40 * DAY);
    expect(previousRange(all)).toBeNull();
    // A preset of the other page falls back.
    expect(rangeOf({ range: "today" }, TRACKER_PRESETS, "7d", NOW, null, UTC).preset).toBe("7d");
    // Days picked: whole days in the viewer's zone, today until now.
    const picked = rangeOf(
      { from: "2026-09-17", to: "2026-09-24" },
      OVERVIEW_PRESETS,
      "7d",
      NOW,
      null,
      NY,
    );
    expect(picked).toMatchObject({
      from: Date.UTC(2026, 8, 17, 4) / 1000,
      to: Date.UTC(2026, 8, 25, 4) / 1000 - 1,
      preset: null,
      words: "Sep 17 – Sep 24",
      length: 8 * DAY,
      previous: "previous 8 days",
    });
    expect(
      rangeOf({ from: "2026-09-25", to: "2026-09-30" }, OVERVIEW_PRESETS, "7d", NOW, null, UTC).to,
    ).toBe(NOW);
    // Nonsense falls back to the preset.
    expect(
      rangeOf({ from: "2026-02-31", to: "2026-03-02" }, OVERVIEW_PRESETS, "30d", NOW, null, UTC)
        .preset,
    ).toBe("30d");
  });

  it("finds days in a zone across a change of offset", () => {
    expect(dayStart("2026-11-01", NY)).toBe(Date.UTC(2026, 10, 1, 4) / 1000);
    expect(dayStart("2026-11-02", NY)).toBe(Date.UTC(2026, 10, 2, 5) / 1000);
    expect(dayStart("nope", NY)).toBeNull();
    const days = localDayStarts(Date.UTC(2026, 10, 1, 12) / 1000, Date.UTC(2026, 10, 3) / 1000, NY);
    expect(days).toEqual([Date.UTC(2026, 10, 1, 4) / 1000, Date.UTC(2026, 10, 2, 5) / 1000]);
    expect(datesLabel(NOW - 3 * DAY, NOW, UTC)).toBe("Sep 23 – Sep 26");
    expect(datesLabel(NOW - HOUR, NOW, UTC)).toBe("Sep 26");
  });

  it("picks chart buckets and bars", () => {
    expect(chartBucket(DAY, 60)).toBe(900);
    expect(chartBucket(7 * DAY, HOUR)).toBe(10_800);
    expect(chartBucket(90 * DAY, HOUR)).toBe(DAY);
    expect(bucketWords(900)).toBe("15 minutes");
    expect(bucketWords(10_800)).toBe("3 hours");
    expect(bucketWords(DAY)).toBe("day");
    const hours = reportBars("hour", NOW - DAY, NOW, UTC);
    expect(hours.unit).toBe("hour");
    expect(hours.starts).toHaveLength(24);
    const days = reportBars("hour", NOW - 7 * DAY, NOW, UTC);
    expect(days).toMatchObject({ unit: "day" });
    expect(days.starts).toHaveLength(8);
    expect(reportBars("day", NOW - 90 * DAY, NOW, UTC).starts).toHaveLength(90);
    expect(bucketIndex([10, 20, 30], 5)).toBe(-1);
    expect(bucketIndex([10, 20, 30], 20)).toBe(1);
    expect(bucketIndex([10, 20, 30], 99)).toBe(2);
  });
});

function point(t: number, down: number, up: number, peers = 0): Schemas["TransferPoint"] {
  return {
    t,
    downloaded: down,
    uploaded: up,
    peers_max: peers,
    connections_max: peers,
    dht_nodes_max: 0,
    torrents_max: 1,
  };
}

describe("the overview", () => {
  const T0 = Date.UTC(2026, 8, 26, 9) / 1000;
  const POINTS = [
    point(T0, 60_000, 6000, 3),
    point(T0 + 60, 120_000, 0, 9),
    point(T0 + 1800, 30_000, 30_000, 4),
    // The minute running now: 20 s of it.
    point(NOW - 20, 2000, 4000, 1),
  ];

  it("sums the range, compares, and finds the peak", () => {
    expect(totals(POINTS)).toEqual({ downloaded: 212_000, uploaded: 40_000 });
    expect(change(150, 100)).toBe(0.5);
    expect(change(5, 0)).toBeNull();
    expect(peakPeers(POINTS)).toEqual({ peers: 9, t: T0 + 60 });
    expect(peakPeers([point(T0, 1, 1)])).toBeNull();
  });

  it("turns buckets into average rates over the seconds recorded", () => {
    const rates = rateSeries(POINTS, 60, 1800, T0, NOW, NOW);
    expect(rates.map((r) => r.t)).toEqual([T0, T0 + 1800, T0 + 3600, T0 + 5400]);
    // Two minutes recorded: 180 kB over 120 s.
    expect(rates[0]).toEqual({ t: T0, down: 1500, up: 50 });
    expect(rates[1]).toEqual({ t: T0 + 1800, down: 500, up: 500 });
    // Not recorded: a gap.
    expect(rates[2]).toEqual({ t: T0 + 3600, down: null, up: null });
    // The running minute counts 20 s.
    expect(rates[3]).toEqual({ t: T0 + 5400, down: 100, up: 200 });
  });

  it("shares peer traffic, with the rest and the unattributed as one line", () => {
    const b = {
      hash: null,
      from: 0,
      to: 0,
      step: "hour",
      dim: "client",
      rows: [
        { key: "qBittorrent", downloaded: 0, uploaded: 500, peers_max: 3 },
        { key: "Transmission", downloaded: 0, uploaded: 200, peers_max: 2 },
        { key: null, downloaded: 0, uploaded: 100, peers_max: 1 },
        { key: "Deluge", downloaded: 0, uploaded: 50, peers_max: 1 },
      ],
      points: [],
      unattributed: { downloaded: 0, uploaded: 150 },
    } satisfies Schemas["PeerBreakdown"];
    expect(shares(b, "uploaded", 2)).toEqual([
      { label: "qBittorrent", bytes: 500, share: 0.5 },
      { label: "Transmission", bytes: 200, share: 0.2 },
      { label: "Other or unknown", bytes: 300, share: 0.3 },
    ]);
    expect(shares(b, "downloaded")).toEqual([]);
    const source = {
      ...b,
      dim: "source" as const,
      rows: [{ key: "pex", downloaded: 0, uploaded: 5, peers_max: 1 }],
    };
    expect(shares(source, "uploaded")[0]?.label).toBe("Peer exchange");
  });

  it("says which idle seeds to reclaim", () => {
    const seed = (hash: string, size: number, value: number) =>
      ({ hash, size, value }) as Schemas["IdleSeed"];
    expect(valueTone(0.05)).toBe("danger");
    expect(valueTone(0.3)).toBe("warn");
    expect(valueTone(0.9)).toBe("warn");
    expect(valueTone(2)).toBeNull();
    const tags = (h: string) => (h === "k" ? ["keep"] : []);
    expect(
      reclaimable(
        [seed("a", 100, 0), seed("b", 50, 0.09), seed("c", 70, 0.2), seed("k", 9, 0)],
        tags,
      ),
    ).toEqual({ hashes: ["a", "b"], bytes: 150 });
  });

  it("rounds axes up and stacks series", () => {
    expect(roundUp(0)).toBe(1);
    expect(roundUp(17)).toBe(20);
    expect(roundUp(2.1e6)).toBe(2.5e6);
    expect(isolated([null, 3, null, 4, 5, null, 6])).toEqual([1, 6]);
    expect(isolated([2])).toEqual([0]);
    expect(tickLabel(Date.UTC(2026, 8, 21) / 1000, UTC)).toBe("Sep 21");
    expect(tickLabel(Date.UTC(2026, 8, 21, 18) / 1000, UTC)).toBe("18:00");
    expect(
      stacked([
        [1, null, 2],
        [3, 4, null],
      ]),
    ).toEqual([
      [1, 0, 2],
      [4, 4, 2],
    ]);
  });
});

function row(
  host: string | null,
  up: number,
  down: number,
  announces = 0,
  errors = 0,
): Schemas["TrackerRow"] {
  return {
    host,
    uploaded: up,
    downloaded: down,
    torrents: 1,
    announces,
    announce_errors: errors,
  };
}

function hostNow(
  host: string,
  torrents: number,
  extra: Partial<Schemas["TrackerHost"]> = {},
): Schemas["TrackerHost"] {
  return {
    host,
    torrents,
    private: 0,
    working: torrents,
    failing: [],
    fails: 0,
    error: null,
    failing_since: null,
    last_failure: null,
    ...extra,
  };
}

describe("trackers", () => {
  const ROWS = [
    row("tracker.example.org", 400, 20, 800, 60),
    row(null, 120, 3),
    row("torrent.ubuntu.com", 70, 9, 200),
  ];
  const HOSTS = [
    hostNow("tracker.example.org", 4, {
      private: 4,
      failing: ["aa"],
      fails: 7,
      error: "timed out",
    }),
    hostNow("torrent.ubuntu.com", 3),
    hostNow("idle.example.net", 2, { private: 1 }),
  ];

  it("lines up the range and what stands now, no tracker last", () => {
    const lines = trackerLines(ROWS, HOSTS, "uploaded", { torrents: 6, private: 0 });
    expect(lines.map((l) => [l.host, l.color, l.torrents])).toEqual([
      ["tracker.example.org", "--cat-1", 4],
      ["torrent.ubuntu.com", "--cat-4", 3],
      ["idle.example.net", "--cat-3", 2],
      [null, "--subtle", 6],
    ]);
    expect(lines[0]).toMatchObject({ failing: ["aa"], errors: 60, private: 4 });
    const byAnnounces = trackerLines(ROWS, HOSTS, "announces", { torrents: 0, private: 0 });
    expect(byAnnounces.map((l) => l.host)).toEqual([
      "tracker.example.org",
      "torrent.ubuntu.com",
      "idle.example.net",
      null,
    ]);
    // Nothing without a tracker now or in the range: no such line.
    expect(
      trackerLines([row("a", 1, 1)], [], "uploaded", { torrents: 0, private: 0 }).map(
        (l) => l.host,
      ),
    ).toEqual(["a"]);
    expect(hostKind(lines[0] ?? { torrents: 0, private: 0 })).toBe("private · 4 torrents");
    expect(hostKind({ torrents: 1, private: 0 })).toBe("public · 1 torrent");
    expect(hostKind({ torrents: 2, private: 1 })).toBe("1 private, 1 public");
    expect(hostKind({ torrents: 0, private: 0 })).toBe("no torrent now");
    expect(success({ announces: 990, errors: 10 })).toBe(0.99);
    expect(success({ announces: 0, errors: 0 })).toBeNull();
  });

  it("sums up the range", () => {
    const lines = trackerLines(ROWS, HOSTS, "uploaded", { torrents: 6, private: 0 });
    expect(trackerKpis(lines, "uploaded")).toEqual({
      working: 2,
      noneMoved: true,
      answered: 1000,
      failed: 60,
      failedShare: 60 / 1060,
      failingHosts: 1,
      top: { host: "tracker.example.org", share: 400 / 590, metric: "uploaded" },
    });
    expect(trackerKpis(lines, "downloaded").top).toEqual({
      host: "tracker.example.org",
      share: 20 / 32,
      metric: "downloaded",
    });
  });

  it("groups announces into bars and traffic into stacked series", () => {
    const P = (t: number, host: string | null, up: number, ok = 0, failed = 0) => ({
      t,
      host,
      uploaded: up,
      downloaded: 0,
      announces: ok,
      announce_errors: failed,
    });
    const points = [
      P(0, "tracker.example.org", 10, 5, 1),
      P(HOUR, "tracker.example.org", 20, 5),
      P(DAY, "tracker.example.org", 5, 4, 2),
      P(DAY, null, 7),
      P(DAY, "small.example", 3, 1),
    ];
    expect(announceBars(points, "tracker.example.org", [0, DAY])).toEqual([
      { t: 0, ok: 10, failed: 1 },
      { t: DAY, ok: 4, failed: 2 },
    ]);
    const lines = trackerLines(
      [row("tracker.example.org", 35, 0), row("small.example", 3, 0), row(null, 7, 0)],
      [],
      "uploaded",
      { torrents: 0, private: 0 },
    );
    expect(stackSeries(points, lines, "uploaded", [0, DAY], 1)).toEqual([
      { label: "tracker.example.org", color: "--cat-1", values: [30, 5] },
      { label: "Other trackers", color: "--faint", values: [0, 3] },
      { label: "No working tracker", color: "--subtle", values: [0, 7] },
    ]);
    expect(stackSeries(points, lines, "announces", [0, DAY]).map((s) => s.values)).toEqual([
      [11, 6],
      [0, 1],
    ]);
  });

  it("finds problems: hosts failing, torrents without a working tracker", () => {
    expect(failingHosts(HOSTS).map((h) => h.host)).toEqual(["tracker.example.org"]);
    const t = (
      hash: string,
      state: Schemas["TorrentState"],
      tracker: string | null,
      priv = false,
    ) => ({ hash, state, tracker, private: priv }) as Schemas["TorrentSummary"];
    expect(
      withoutTracker([
        t("a", "seeding", null),
        t("b", "downloading", null, true),
        t("c", "stopped", null),
        t("d", "seeding", "udp://t.example:1/announce"),
        t("e", "metadata", null),
      ]),
    ).toEqual({ public: ["a", "e"], private: ["b"] });
    expect(
      defaultTrackers(["udp://a.example:1/announce", " "], ["udp://a.example:1/announce", "x"]),
    ).toEqual(["udp://a.example:1/announce", "x"]);
    expect(
      hideUrls(
        "error sending request for url (https://t.example.org:443/a/SECRET/announce?passkey=x): timed out",
      ),
    ).toBe("error sending request for url (t.example.org/…): timed out");
    expect(hideUrls("connect 127.0.0.1:1: Connection refused")).toBe(
      "connect 127.0.0.1:1: Connection refused",
    );
  });
});
