// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import { crumbs, itemsLabel, parentOf } from "~/components/folder-paths";
import { torrent } from "~/test/fixtures";

import { bulk, statesLine } from "./bulk";
import { contentDir, locationProblem, movePlan } from "./move";
import { removal } from "./removal";

const global = {
  ratio: { mode: "global" },
  seeding_time: { mode: "global" },
  inactive_seeding_time: { mode: "global" },
  action: null,
} as const;

describe("bulk", () => {
  const a = torrent({
    hash: "a".repeat(40),
    name: "ubuntu",
    category: "linux",
    tags: ["iso"],
    completed: 100,
    size: 100,
    ratio: 4,
    upload_rate: 10,
    upload_limit: null,
    share_limits: global,
  });
  const b = torrent({
    hash: "b".repeat(40),
    name: "sintel",
    category: "movies",
    tags: ["keep", "iso"],
    completed: 50,
    size: 60,
    ratio: 2,
    upload_rate: 5,
    upload_limit: null,
    share_limits: global,
  });

  it("adds up and says what they share", () => {
    const x = bulk([a, b]);
    expect(x).toMatchObject({
      count: 2,
      size: 160,
      onDisk: 150,
      uploadRate: 15,
      avgRatio: 3,
      categories: ["linux", "movies"],
      tags: [
        ["iso", 2],
        ["keep", 1],
      ],
      category: undefined,
      uploadLimit: null,
      share: "global",
    });
    expect(statesLine(x.states)).toBe("All seeding");
  });

  it("does not make up a shared value", () => {
    const own = { ...global, ratio: { mode: "limit", value: 2 } } as const;
    const c = torrent({ hash: "c".repeat(40), share_limits: own, state: "stopped", ratio: null });
    const d = torrent({
      hash: "d".repeat(40),
      share_limits: { ...own, ratio: { mode: "limit", value: 3 } },
    });
    const x = bulk([c, d]);
    expect(x.share).toBeUndefined();
    expect(x.avgRatio).toBe(4.21);
    expect(statesLine(x.states)).toBe("1 seeding · 1 stopped");
    expect(bulk([c, { ...c, hash: "e".repeat(40) }]).share).toBe("own");
  });
});

describe("removal", () => {
  it("says what deleting the files deletes, and what was kept", () => {
    const rows = [
      { name: "a", completed: 10, content_path: "/data/linux/a.iso", tags: [] },
      { name: "b", completed: 5, content_path: "/data/movies/b", tags: ["keep"] },
      { name: "c", completed: 1, content_path: "/data/movies/c", tags: [] },
      { name: "d", completed: 0, content_path: null, tags: [] },
      { name: "e", completed: 2, content_path: "/mnt/e", tags: [] },
    ];
    expect(removal(rows, "keep")).toEqual({
      bytes: 18,
      places: ["/data/linux", "/data/movies"],
      morePlaces: 1,
      kept: ["b"],
    });
  });
});

describe("move", () => {
  const stagedRow = { save_path: "/data/linux", download_path: "/data/incoming", complete: false };
  const done = { save_path: "/data/linux", download_path: null, complete: true };

  it("says where the content is and goes", () => {
    expect(contentDir(stagedRow)).toBe("/data/incoming");
    expect(contentDir(done)).toBe("/data/linux");
    expect(movePlan(stagedRow, "save", "/mnt/fast/linux")).toEqual({
      now: "/data/incoming → /data/linux on completion",
      after: "/data/incoming → /mnt/fast/linux on completion",
    });
    expect(movePlan(done, "save", "/mnt/fast")).toEqual({ now: "/data/linux", after: "/mnt/fast" });
    expect(movePlan(stagedRow, "download", "")).toEqual({
      now: "/data/incoming → /data/linux on completion",
      after: "/data/linux",
    });
    expect(movePlan(stagedRow, "download", "/ssd").after).toBe("/ssd → /data/linux on completion");
  });

  it("wants absolute paths, or none for the download path", () => {
    expect(locationProblem("save", "")).not.toBeNull();
    expect(locationProblem("save", "data")).not.toBeNull();
    expect(locationProblem("download", "")).toBeNull();
    expect(locationProblem("save", "/data")).toBeNull();
  });
});

describe("folders", () => {
  it("walks paths", () => {
    expect(parentOf("/data/linux/")).toBe("/data");
    expect(parentOf("/data")).toBe("/");
    expect(crumbs("/data/linux").map((c) => c.path)).toEqual(["/", "/data", "/data/linux"]);
    expect(itemsLabel(0)).toBe("empty");
    expect(itemsLabel(1)).toBe("1 item");
    expect(itemsLabel(1000)).toBe("1,000+ items");
    expect(itemsLabel(null)).toBe("cannot read");
  });
});
