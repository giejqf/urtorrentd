// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import { torrent } from "~/test/fixtures";

import {
  countAll,
  listItems,
  matches,
  NO_FILTER,
  NO_TRACKER,
  sortTorrents,
  TRACKER_DOWN,
  trackerKey,
  viewTitle,
} from "./view";

const a = torrent({
  hash: "a".repeat(40),
  name: "debian-13.iso",
  state: "downloading",
  complete: false,
  download_rate: 8_100_000,
  upload_rate: 640_000,
  category: "linux",
  tags: ["iso", "keep"],
  tracker: "https://bttracker.debian.org:6969/announce",
  trackers_count: 1,
  added_on: 300,
  eta: 192,
  ratio: 0.31,
});
const b = torrent({
  hash: "b".repeat(40),
  name: "Sintel (2010) 1080p",
  state: "seeding",
  complete: true,
  upload_rate: 96_000,
  category: "movies",
  tags: [],
  tracker: null,
  trackers_count: 0,
  added_on: 100,
  eta: null,
  ratio: 6.02,
});
const c = torrent({
  hash: "c".repeat(40),
  name: "archlinux.iso",
  state: "queued",
  complete: false,
  upload_rate: 0,
  category: null,
  tags: ["iso"],
  tracker: null,
  trackers_count: 2,
  added_on: 200,
  eta: null,
  ratio: null,
});
const d = torrent({
  hash: "d".repeat(40),
  name: "Tears of Steel",
  state: "seeding",
  stalled: true,
  complete: true,
  upload_rate: 0,
  category: "movies",
  tags: [],
  tracker: "udp://tracker.example.org:1337",
  trackers_count: 1,
  added_on: 400,
});
const all = [a, b, c, d];

describe("filters", () => {
  it("files torrents by tracker host, trackerless or not working", () => {
    expect(trackerKey(a)).toBe("bttracker.debian.org");
    expect(trackerKey(b)).toBe(NO_TRACKER);
    expect(trackerKey(c)).toBe(TRACKER_DOWN);
    expect(trackerKey(d)).toBe("tracker.example.org");
  });

  it("combines status, category, tag, tracker and search", () => {
    const pick = (f: Partial<typeof NO_FILTER>) =>
      all.filter((t) => matches(t, { ...NO_FILTER, ...f })).map((t) => t.name);
    expect(pick({})).toHaveLength(4);
    expect(pick({ status: "downloading" })).toEqual(["debian-13.iso", "archlinux.iso"]);
    expect(pick({ status: "queued" })).toEqual(["archlinux.iso"]);
    expect(pick({ status: "stalled" })).toEqual(["Tears of Steel"]);
    expect(pick({ category: "movies" })).toEqual(["Sintel (2010) 1080p", "Tears of Steel"]);
    expect(pick({ category: "" })).toEqual(["archlinux.iso"]);
    expect(pick({ tag: "iso", status: "downloading" })).toEqual(["debian-13.iso", "archlinux.iso"]);
    expect(pick({ tracker: NO_TRACKER })).toEqual(["Sintel (2010) 1080p"]);
    expect(pick({ search: new Set([b.hash, c.hash]), tag: "iso" })).toEqual(["archlinux.iso"]);
  });

  it("counts every facet in one pass", () => {
    const n = countAll(all);
    expect(n.status.all).toBe(4);
    expect(n.status.downloading).toBe(2);
    expect(n.status.seeding).toBe(2);
    expect(n.status.completed).toBe(2);
    expect(n.status.active).toBe(2);
    expect(n.status.stalled).toBe(1);
    expect(n.status.queued).toBe(1);
    expect(n.status.errored).toBe(0);
    expect(n.categories.get("movies")).toBe(2);
    expect(n.categories.get("")).toBe(1);
    expect(n.tags.get("iso")).toBe(2);
    expect(n.trackers.get(TRACKER_DOWN)).toBe(1);
  });
});

describe("order and groups", () => {
  it("sorts with unknown values last either way", () => {
    const names = (key: Parameters<typeof sortTorrents>[1]) =>
      sortTorrents(all, key).map((t) => t.name);
    expect(names({ sort: "added_on", reverse: true })[0]).toBe("Tears of Steel");
    expect(names({ sort: "name", reverse: false })).toEqual([
      "archlinux.iso",
      "debian-13.iso",
      "Sintel (2010) 1080p",
      "Tears of Steel",
    ]);
    expect(names({ sort: "ratio", reverse: true }).at(-1)).toBe("archlinux.iso");
    expect(names({ sort: "ratio", reverse: false }).at(-1)).toBe("archlinux.iso");
  });

  it("groups by state in the design's order, with summed rates", () => {
    const items = listItems(sortTorrents(all, { sort: "name", reverse: false }), true);
    const heads = items.flatMap((i) => (i.kind === "group" ? [i.group.key] : []));
    expect(heads).toEqual(["downloading", "queued", "seeding", "stalled"]);
    const first = items[0];
    expect(first?.kind === "group" && [first.count, first.down, first.up]).toEqual([
      1, 8_100_000, 640_000,
    ]);
    expect(listItems(all, false)).toHaveLength(4);
  });

  it("titles the view", () => {
    const labels = { seeding: "Seeding" } as Parameters<typeof viewTitle>[1];
    expect(viewTitle(NO_FILTER, labels)).toBe("All torrents");
    expect(viewTitle({ ...NO_FILTER, status: "seeding", category: "linux" }, labels)).toBe(
      "Seeding · linux",
    );
    expect(viewTitle({ ...NO_FILTER, tag: "iso", tracker: NO_TRACKER }, labels)).toBe(
      "All torrents · #iso · No tracker",
    );
  });
});
