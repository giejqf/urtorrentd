// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import type { Schemas } from "~/api/client";
import { torrent } from "~/test/fixtures";

import {
  chosenIndexes,
  fileRows,
  filesSummary,
  nameProblem,
  pieceRuns,
  renamedPath,
  runsPath,
  shownRows,
  toggleWanted,
} from "./files";
import { DAY, figures, lastDay, level, seedingCells, weekStarts } from "./history";
import { mergeDraft, optionsDiff, optionsDraft } from "./options";
import {
  missingTrackers,
  nextTier,
  trackerLine,
  trackerScheme,
  trackerUrlProblem,
  typedUrls,
} from "./trackers";

const file = (index: number, path: string, size: number, priority = 4, progress = 0) =>
  ({
    index,
    path,
    size,
    priority,
    progress,
    first_piece: 0,
    last_piece: 0,
    availability: 1,
  }) satisfies Schemas["FileInfo"];

describe("files", () => {
  const files = [
    file(0, "ED/movie.mkv", 800, 4, 0.5),
    file(1, "ED/subs/en.srt", 60, 7, 1),
    file(2, "ED/subs/nl.srt", 40, 7, 0),
    file(3, "ED/commentary.ogg", 20, 1),
    file(4, "ED/poster.png", 10, 0),
  ];

  it("builds the tree in the torrent's order, folders before their files", () => {
    const rows = fileRows(files);
    expect(rows.map((r) => `${"  ".repeat(r.depth)}${r.name}`)).toEqual([
      "ED",
      "  movie.mkv",
      "  subs",
      "    en.srt",
      "    nl.srt",
      "  commentary.ogg",
      "  poster.png",
    ]);
    const root = rows[0];
    expect(root).toMatchObject({ folder: true, size: 930, wanted: "some", priority: null });
    expect(root?.indexes).toEqual([0, 1, 2, 3, 4]);
    // Progress by size over the wanted files only.
    expect(root?.progress).toBeCloseTo((400 + 60) / 920);
    expect(rows[2]).toMatchObject({ name: "subs", priority: 7, wanted: "all", size: 100 });
    expect(rows[6]).toMatchObject({ wanted: "none", progress: null });
  });

  it("a single file is one row", () => {
    expect(fileRows([file(0, "debian.iso", 10)])).toMatchObject([
      { name: "debian.iso", depth: 0, folder: false },
    ]);
  });

  it("hides what a collapsed folder holds", () => {
    const rows = fileRows(files);
    expect(shownRows(rows, new Set(["ED/subs"])).map((r) => r.name)).toEqual([
      "ED",
      "movie.mkv",
      "subs",
      "commentary.ogg",
      "poster.png",
    ]);
    expect(shownRows(rows, new Set(["ED"])).map((r) => r.name)).toEqual(["ED"]);
  });

  it("a checkbox skips everything or wants the skipped ones back", () => {
    const rows = fileRows(files);
    const root = rows[0];
    const subs = rows[2];
    if (!root || !subs) throw new Error("rows");
    expect(toggleWanted(root, files)).toEqual({ indexes: [4], priority: 4 });
    expect(toggleWanted(subs, files)).toEqual({ indexes: [1, 2], priority: 0 });
  });

  it("chosen folders stand for their files", () => {
    const rows = fileRows(files);
    expect(chosenIndexes(rows, new Set(["ED/subs", "ED/subs/en.srt", "ED/poster.png"]))).toEqual([
      1, 2, 4,
    ]);
  });

  it("sums what is wanted", () => {
    expect(filesSummary(files)).toBe("5 files · 920 B wanted of 930 B");
    expect(filesSummary([file(0, "a", 10)])).toBe("1 file · 10 B");
  });

  it("renames in place and refuses paths", () => {
    expect(renamedPath("ED/subs/en.srt", "english.srt")).toBe("ED/subs/english.srt");
    expect(renamedPath("ED", "Elephants Dream")).toBe("Elephants Dream");
    expect(nameProblem("a/b")).not.toBeNull();
    expect(nameProblem("..")).not.toBeNull();
    expect(nameProblem(" ")).not.toBeNull();
    expect(nameProblem("fine.mkv")).toBeNull();
  });

  it("finds runs of pieces and draws at most a bar per pixel", () => {
    const s: Schemas["PieceState"][] = ["have", "have", "missing", "have", "downloading", "have"];
    expect(pieceRuns(s, 0, 5, (x) => x === "have")).toEqual([
      [0, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(pieceRuns(s, 2, 4, (x) => x === "have")).toEqual([[3, 4]]);
    // 6 pieces over 6px: three bars; over 1px they merge into one.
    expect(
      runsPath(
        pieceRuns(s, 0, 5, (x) => x === "have"),
        6,
        6,
        0,
        8,
      ).match(/M/g),
    ).toHaveLength(3);
    expect(
      runsPath(
        pieceRuns(s, 0, 5, (x) => x === "have"),
        6,
        1,
        0,
        8,
      ).match(/M/g),
    ).toHaveLength(1);
  });
});

const tracker = (over: Partial<Schemas["TrackerInfo"]>): Schemas["TrackerInfo"] => ({
  url: "udp://tracker.example:6969/announce",
  tier: 0,
  status: "working",
  message: null,
  fails: 0,
  seeders: null,
  leechers: null,
  downloaded: null,
  next_announce_in: null,
  updating: false,
  endpoints: [],
  ...over,
});

describe("trackers", () => {
  it("says how a tracker stands", () => {
    expect(trackerLine(tracker({ seeders: 186, leechers: 24, downloaded: 1204 }))).toEqual({
      text: "working · 186 seeds · 24 leechers · 1,204 completed",
      tone: "ok",
    });
    expect(trackerLine(tracker({ status: "not_working", message: "timed out", fails: 3 }))).toEqual(
      { text: "timed out · failed 3 times", tone: "danger" },
    );
    expect(trackerLine(tracker({ status: "not_contacted" })).text).toBe("not contacted yet");
  });

  it("reads typed URLs and where they go", () => {
    expect(typedUrls(" udp://a:1/announce\n\nhttp://b/announce udp://a:1/announce ")).toEqual([
      "udp://a:1/announce",
      "http://b/announce",
    ]);
    expect(nextTier([])).toBe(0);
    expect(nextTier([{ tier: 0 }, { tier: 2 }])).toBe(3);
    expect(trackerScheme("UDP://x:1")).toBe("udp");
    expect(trackerUrlProblem("udp://tracker.example:6969/announce")).toBeNull();
    expect(trackerUrlProblem("https://t.example/abc123/announce")).toBeNull();
    expect(trackerUrlProblem("ftp://t.example/")).not.toBeNull();
    expect(trackerUrlProblem("tracker.example")).not.toBeNull();
  });

  it("offers what new public torrents get and this one lacks", () => {
    expect(
      missingTrackers(
        [{ url: "udp://a/announce" }],
        [
          ["udp://a/announce", "udp://b/announce"],
          ["udp://b/announce", "udp://c/announce"],
        ],
      ),
    ).toEqual(["udp://b/announce", "udp://c/announce"]);
  });
});

const day = (t: number, over: Partial<Schemas["TorrentDay"]> = {}): Schemas["TorrentDay"] => ({
  t,
  downloaded: 0,
  uploaded: 0,
  peers_max: 0,
  seeds_max: 0,
  active_time: 0,
  seeding_time: 0,
  downloaded_total: 0,
  uploaded_total: 0,
  active_time_total: 0,
  seeding_time_total: 0,
  ratio: null,
  swarm_seeds_max: null,
  swarm_leechers_max: null,
  swarm_completed_max: null,
  ...over,
});

describe("history", () => {
  // Saturday 2026-09-26, 15:00 UTC.
  const now = Date.UTC(2026, 8, 26, 15) / 1000;
  const today = Date.UTC(2026, 8, 26) / 1000;

  it("shades a day by the copies uploaded", () => {
    expect(level(0, 100)).toBe(0);
    expect(level(5, 100)).toBe(1);
    expect(level(30, 100)).toBe(2);
    expect(level(90, 100)).toBe(3);
    expect(level(250, 100)).toBe(4);
  });

  it("lays days out by week, Monday first, from the first recorded one", () => {
    const days = [
      day(today - 2 * DAY, { seeding_time: 3600, uploaded: 50 }),
      day(today, { seeding_time: 60 }),
    ];
    const cells = seedingCells(days, 100, now, today - 3 * DAY);
    // Wednesday to Saturday of the last week: 4 cells in column 11.
    expect(cells.map((c) => [c.col, c.row, c.level])).toEqual([
      [11, 2, null],
      [11, 3, 3],
      [11, 4, null],
      [11, 5, 0],
    ]);
    expect(seedingCells(days, 100, now, null)).toEqual([]);
    const weeks = weekStarts(now);
    expect(weeks).toHaveLength(12);
    // Mondays.
    expect(new Date((weeks[11] ?? 0) * 1000).toISOString().slice(0, 10)).toBe("2026-09-21");
  });

  it("sums the last 30 days and finds the extremes", () => {
    const f = figures(
      [
        day(today - 40 * DAY, { uploaded: 900, seeding_time: 10, ratio: 0.5 }),
        day(today - 10 * DAY, { uploaded: 100, seeding_time: 10, ratio: 1.0 }),
        day(today - 8 * DAY, { swarm_completed_max: 1204, ratio: 1.2 }),
        day(today, { uploaded: 300, seeding_time: 10, ratio: 1.5 }),
      ],
      now,
    );
    expect(f).toEqual({
      uploaded30: 400,
      seeded30: 2,
      completed: 1204,
      since: today - 40 * DAY,
      best: { t: today - 40 * DAY, uploaded: 900 },
      ratioWeekAgo: 1.2,
    });
  });

  it("fills a day of hours with zeros", () => {
    const hour = Math.floor(now / 3600) * 3600;
    const b = lastDay([{ t: hour, downloaded: 5, uploaded: 7, peers_max: 1, seeds_max: 0 }], now);
    expect(b).toHaveLength(24);
    expect(b[23]).toEqual({ t: hour, downloaded: 5, uploaded: 7 });
    expect(b[0]).toEqual({ t: hour - 23 * 3600, downloaded: 0, uploaded: 0 });
  });
});

describe("options", () => {
  const t = torrent({
    name: "Sintel",
    comment: null,
    upload_limit: 5_000_000,
    download_limit: null,
    max_connections: 50,
    max_uploads: null,
    share_limits: {
      ratio: { mode: "limit", value: 2 },
      seeding_time: { mode: "global" },
      inactive_seeding_time: { mode: "unlimited" },
      action: null,
    },
    category: "movies",
    tags: ["keep"],
    save_path: "/data/movies",
    download_path: null,
    auto_management: true,
  });
  const base = optionsDraft(t);

  it("starts from the torrent's options", () => {
    expect(base).toMatchObject({
      upload_limit: "5 000",
      download_limit: "",
      max_connections: "50",
      max_uploads: "",
      ratio_mode: "limit",
      ratio: "2.0",
      seeding_mode: "global",
      inactive_mode: "unlimited",
      action: "global",
      category: "movies",
    });
    expect(optionsDiff(base, base).changed.size).toBe(0);
  });

  it("sends only what changed, and says so", () => {
    const c = optionsDiff(base, {
      ...base,
      upload_limit: "",
      max_connections: "200",
      seeding_mode: "limit",
      seeding: "14",
      seeding_unit: "days",
      action: "remove",
      tags: ["iso"],
      name: "",
    });
    expect(c.names).toEqual([
      "Display name",
      "Upload limit",
      "Peer connections",
      "Seeding time",
      "When reached",
      "Tags",
    ]);
    expect(c.patch).toEqual({ name: null });
    expect(c.limits).toEqual({ upload_limit: null, max_connections: 200 });
    expect(c.shareLimits).toEqual({
      ratio: { mode: "limit", value: 2 },
      seeding_time: { mode: "limit", value: 14 * 86_400 },
      inactive_seeding_time: { mode: "unlimited" },
      action: "remove",
    });
    expect(c.tagsAdd).toEqual(["iso"]);
    expect(c.tagsRemove).toEqual(["keep"]);
    expect(c.sequential).toBeNull();
  });

  it("refuses what cannot be sent", () => {
    const c = optionsDiff(base, {
      ...base,
      download_limit: "fast",
      ratio: "",
      auto_management: false,
      save_path: "relative/path",
    });
    expect(Object.keys(c.errors).sort()).toEqual(["download_limit", "ratio", "save_path"]);
    expect(c.shareLimits).toBeNull();
    expect(c.autoManagement).toBe(false);
  });

  it("moves only once automatic management is off", () => {
    expect(optionsDiff(base, { ...base, save_path: "/elsewhere" }).location).toBeNull();
    expect(
      optionsDiff(base, { ...base, save_path: "/elsewhere", auto_management: false }).location,
    ).toBe("/elsewhere");
  });

  it("follows the torrent where the draft was left alone", () => {
    const next = optionsDraft({ ...t, upload_limit: 1_000_000, sequential: true });
    const merged = mergeDraft({ ...base, comment: "mine" }, base, next);
    expect(merged).toMatchObject({ comment: "mine", upload_limit: "1 000", sequential: true });
  });
});
