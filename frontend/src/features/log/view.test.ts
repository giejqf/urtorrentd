// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import type { Schemas } from "~/api/client";
import { formatDayHeading } from "~/lib/format";

import {
  byDay,
  counts,
  exportText,
  filterEntries,
  foldRepeats,
  perHour,
  recurring,
  sameMessage,
  textMatcher,
} from "./view";

const TZ = "UTC";
// Sat 26 Sep 2026, 10:41:02 UTC.
const NOW = Date.UTC(2026, 8, 26, 10, 41, 2) / 1000;

let id = 0;
function entry(
  ago: number,
  message: string,
  level: Schemas["LogLevel"] = "info",
  topic: Schemas["LogTopic"] = "torrents",
  torrent: string | null = null,
): Schemas["LogEntry"] {
  id += 1;
  return { id, time: NOW - ago, level, topic, torrent, message };
}

// Oldest first, as the daemon lists them.
const LOG = [
  entry(3 * 86_400, "urtorrentd 0.13.0 started", "info", "daemon"),
  entry(86_400 + 60, "added torrent debian.iso", "info", "torrents", "ab".repeat(20)),
  entry(7200, "RSS feed Fedora torrents: HTTP 503", "warning", "rss"),
  entry(3600, "RSS feed Fedora torrents: HTTP 503", "warning", "rss"),
  entry(3000, "RSS feed Fedora torrents: HTTP 503", "warning", "rss"),
  entry(600, 'webhook "arr": the finished delivery failed after 4 attempts', "error", "webhooks"),
  entry(30, "RSS feed Fedora torrents: HTTP 503", "warning", "rss"),
];

describe("the main log", () => {
  it("filters by level, topic and a regular expression (or plain text)", () => {
    expect(filterEntries(LOG, { level: "warning", topic: null, text: "" })).toHaveLength(4);
    expect(filterEntries(LOG, { level: null, topic: "daemon", text: "" })).toHaveLength(1);
    expect(filterEntries(LOG, { level: null, topic: null, text: "fedora|webhook" })).toHaveLength(
      5,
    );
    // Not a valid expression: looked for as it is.
    expect(textMatcher("HTTP (503")("feed: HTTP (503 x")).toBe(true);
    expect(textMatcher("")("anything")).toBe(true);
  });

  it("folds back-to-back repeats, newest first", () => {
    const rows = foldRepeats(LOG);
    expect(rows.map((r) => [r.entry.message.slice(0, 12), r.count])).toEqual([
      ["RSS feed Fed", 1],
      ['webhook "arr', 1],
      ["RSS feed Fed", 3],
      ["added torren", 1],
      ["urtorrentd 0", 1],
    ]);
    // The newest of a run stands for it.
    expect(rows[2]?.entry.time).toBe(NOW - 3000);
  });

  it("groups rows by the viewer's day", () => {
    const days = byDay(foldRepeats(LOG), NOW, TZ);
    expect(days.map((d) => [d.label, d.rows.length])).toEqual([
      ["Today · Sat 26 Sep", 3],
      ["Yesterday · Fri 25 Sep", 1],
      ["Wed 23 Sep", 1],
    ]);
    expect(formatDayHeading(Date.UTC(2025, 0, 2) / 1000, NOW, { timeZone: TZ })).toBe(
      "Thu 2 Jan 2025",
    );
  });

  it("counts levels within the topic, topics within the level", () => {
    const all = counts(LOG, { level: null, topic: null });
    expect(all.all).toBe(7);
    expect(all.levels).toEqual({ info: 2, warning: 4, error: 1 });
    expect(all.topics.get("rss")).toBe(4);
    const rss = counts(LOG, { level: null, topic: "rss" });
    expect(rss.levels).toEqual({ info: 0, warning: 4, error: 0 });
    expect(counts(LOG, { level: "error", topic: null }).topics).toEqual(new Map([["webhooks", 1]]));
  });

  it("says how often a message came and when it first did", () => {
    const last = LOG.at(-1);
    expect(last && sameMessage(LOG, last, NOW)).toEqual({ lastDay: 4, first: NOW - 7200 });
    const first = LOG[0];
    expect(first && sameMessage(LOG, first, NOW)).toEqual({ lastDay: 0, first: NOW - 3 * 86_400 });
  });

  it("counts the last day by hour and level", () => {
    const hours = perHour(LOG, NOW);
    expect(hours).toHaveLength(24);
    expect(hours.at(-1)).toMatchObject({ warning: 1, error: 1 });
    expect(hours.reduce((n, h) => n + h.info + h.warning + h.error, 0)).toBe(5);
    expect(hours[0]?.start).toBe(Math.floor(NOW / 3600) * 3600 - 23 * 3600);
  });

  it("finds what recurs today", () => {
    expect(recurring(LOG, NOW, 4, TZ)).toEqual([
      { level: "warning", message: "RSS feed Fedora torrents: HTTP 503", count: 4 },
    ]);
  });

  it("exports lines in UTC, oldest first", () => {
    const text = exportText(LOG.slice(0, 2));
    expect(text).toBe(
      "2026-09-23 10:41:02 info daemon urtorrentd 0.13.0 started\n" +
        `2026-09-25 10:40:02 info torrents ${"ab".repeat(20)} added torrent debian.iso\n`,
    );
    expect(exportText([])).toBe("");
  });
});
