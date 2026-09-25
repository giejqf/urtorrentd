// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import type { Schemas } from "~/api/client";

import { diff, draftOf, parseTime, timeText } from "./queue-form";
import { moved, queueNow } from "./queue-now";
import { closeness, effectiveLimits, outlook } from "./share";

const GLOBAL = { mode: "global" } as const;
const allGlobal: Schemas["ShareLimits"] = {
  ratio: GLOBAL,
  seeding_time: GLOBAL,
  inactive_seeding_time: GLOBAL,
  action: null,
};

describe("the queue form", () => {
  const saved = {
    queueing_enabled: true,
    max_active_downloads: 2,
    max_active_uploads: 5,
    max_active_torrents: null,
    count_slow_torrents: false,
    max_ratio: 5,
    max_seeding_time: 14 * 86_400,
    max_inactive_seeding_time: 90 * 60,
    share_limit_action: "stop",
  } as unknown as Schemas["Settings"];

  it("shows times in the largest whole unit", () => {
    expect(timeText(14 * 86_400)).toEqual({ text: "14", unit: "days" });
    expect(timeText(36 * 3600)).toEqual({ text: "36", unit: "hours" });
    expect(timeText(90)).toEqual({ text: "1.5", unit: "minutes" });
    expect(timeText(null)).toEqual({ text: "", unit: "days" });
    expect(parseTime("1.5", "days")).toBe(129_600);
    expect(parseTime("", "days")).toBeNull();
    expect(parseTime("-1", "days")).toBeUndefined();
  });

  it("starts unchanged, then sends what changed in the API's units", () => {
    const d = draftOf(saved);
    expect(d.max_ratio).toBe("5.0");
    expect(d.max_inactive_seeding_time).toBe("90");
    expect(d.max_inactive_seeding_time_unit).toBe("minutes");
    expect(diff(saved, d).changed.size).toBe(0);
    const r = diff(saved, {
      ...d,
      max_active_downloads: "",
      max_ratio: "2.5",
      max_seeding_time_unit: "hours",
      share_limit_action: "remove",
    });
    expect(r.patch).toEqual({
      max_active_downloads: null,
      max_ratio: 2.5,
      max_seeding_time: 14 * 3600,
      share_limit_action: "remove",
    });
    expect(r.names).toEqual([
      "max_active_downloads",
      "max_ratio",
      "max_seeding_time",
      "share_limit_action",
    ]);
  });

  it("says what is wrong", () => {
    const r = diff(saved, { ...draftOf(saved), max_active_uploads: "x", max_ratio: "1,5" });
    expect(Object.keys(r.errors)).toEqual(["max_active_uploads", "max_ratio"]);
    expect(r.patch).toEqual({});
  });
});

const row = (over: Partial<Schemas["TorrentSummary"]>) =>
  ({
    hash: "h",
    name: "t",
    state: "downloading",
    stalled: false,
    slow: false,
    forced: false,
    complete: false,
    queue_position: 0,
    download_rate: 100_000,
    upload_rate: 0,
    last_activity: null,
    ...over,
  }) as Schemas["TorrentSummary"];

describe("the queue now", () => {
  const rows = [
    row({ hash: "c", queue_position: 2, state: "queued" }),
    row({ hash: "a", queue_position: 0 }),
    row({ hash: "s", queue_position: 3, state: "seeding", complete: true, slow: true }),
    row({
      hash: "u",
      queue_position: 1,
      state: "seeding",
      complete: true,
      upload_rate: 9000,
      download_rate: 0,
    }),
    row({ hash: "x", queue_position: 4, state: "stopped" }),
  ];

  it("hands out slots by kind, and none to slow torrents unless they count", () => {
    const q = queueNow(rows, false);
    expect(q.entries.map((e) => e.row.hash)).toEqual(["a", "u", "c", "s"]);
    expect(q.downloads.map((e) => e.row.hash)).toEqual(["a"]);
    expect(q.uploads.map((e) => e.row.hash)).toEqual(["u"]);
    expect(q.entries.find((e) => e.row.hash === "s")).toMatchObject({ slow: true, holds: null });
    expect(q.waiting).toEqual({ download: 1, upload: 0 });
    expect(queueNow(rows, true).uploads.map((e) => e.row.hash)).toEqual(["u", "s"]);
  });

  it("previews a drag", () => {
    expect(moved(["a", "b", "c", "d"], 3, 1)).toEqual(["a", "d", "b", "c"]);
    expect(moved(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moved(["a", "b"], 1, 1)).toEqual(["a", "b"]);
  });
});

describe("share limits", () => {
  const g = { ratio: 2, seeding: 86_400, inactive: null, action: "stop" as const };

  it("resolve as the daemon does: own, then category, then settings", () => {
    expect(effectiveLimits(allGlobal, undefined, g)).toEqual({
      ratio: 2,
      seeding: 86_400,
      inactive: null,
      action: "stop",
      own: false,
      category: false,
    });
    const cat: Schemas["ShareLimits"] = {
      ...allGlobal,
      ratio: { mode: "unlimited" },
      action: "remove",
    };
    const own: Schemas["ShareLimits"] = {
      ...allGlobal,
      seeding_time: { mode: "limit", value: 60 },
    };
    expect(effectiveLimits(own, cat, g)).toEqual({
      ratio: null,
      seeding: 60,
      inactive: null,
      action: "remove",
      own: true,
      category: true,
    });
  });

  const seed = {
    ratio: 1,
    uploaded: 1000,
    downloaded: 1000,
    completed: 1000,
    upload_rate: 10,
    download_rate: 0,
    seeding_time: 3600,
    last_activity: 900,
    completed_on: 100,
    added_on: 0,
  };

  it("says which limit comes first at the current rate", () => {
    const l = effectiveLimits(allGlobal, undefined, g);
    const o = outlook(seed, l, 1000);
    expect(o.ratioShare).toBe(0.5);
    expect(o.seedingShare).toBeCloseTo(1 / 24);
    // 1000 more bytes at 10 B/s: 100 s, before a day of seeding.
    expect(o.next).toEqual({ kind: "ratio", in: 100 });
    // Nothing uploading: no ratio estimate; seeding time is certain.
    expect(outlook({ ...seed, upload_rate: 0 }, l, 1000).next).toEqual({
      kind: "seeding time",
      in: 82_800,
    });
    const idle = effectiveLimits(allGlobal, undefined, { ...g, inactive: 600 });
    expect(outlook({ ...seed, upload_rate: 0 }, idle, 1000).next).toEqual({
      kind: "inactive time",
      in: 500,
    });
    expect(outlook({ ...seed, ratio: 2.5 }, l, 1000).reached).toBe("ratio");
    const none = effectiveLimits(allGlobal, undefined, { ...g, ratio: null, seeding: null });
    expect(closeness(outlook(seed, none, 1000))).toBe(Number.MAX_SAFE_INTEGER);
  });
});
