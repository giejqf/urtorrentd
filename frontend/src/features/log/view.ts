// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Log screen's arithmetic over the main log as the daemon keeps it
// (`GET /log`, oldest first): the filters (level, topic, text), repeated
// messages folded into one row, rows by day, counts for the sidebar, the
// same message over the last day, entries per hour, what recurs today, and
// the text an export writes. Messages are compared whole, never parsed.
// Pure and tested.

import type { Schemas } from "~/api/client";
import { formatDayHeading, localDay } from "~/lib/format";

type Entry = Schemas["LogEntry"];
type Level = Schemas["LogLevel"];
type Topic = Schemas["LogTopic"];

export const LEVELS: readonly Level[] = ["info", "warning", "error"];

export const LEVEL_LABELS: Record<Level, string> = {
  info: "Info",
  warning: "Warning",
  error: "Error",
};

/** The topics in the sidebar's order. */
export const TOPICS: readonly Topic[] = [
  "torrents",
  "trackers",
  "rss",
  "watch_folders",
  "webhooks",
  "settings",
  "security",
  "network",
  "statistics",
  "daemon",
];

export const TOPIC_LABELS: Record<Topic, string> = {
  torrents: "Torrents",
  trackers: "Trackers",
  rss: "RSS",
  watch_folders: "Watch folders",
  webhooks: "Webhooks",
  settings: "Settings",
  security: "Sign-in",
  network: "Network",
  statistics: "Statistics",
  daemon: "Daemon",
};

export function isLevel(s: string | undefined): s is Level {
  return s !== undefined && (LEVELS as readonly string[]).includes(s);
}

export function isTopic(s: string | undefined): s is Topic {
  return s !== undefined && (TOPICS as readonly string[]).includes(s);
}

export interface LogFilter {
  level: Level | null;
  topic: Topic | null;
  /** A regular expression, case ignored; text that is not one is looked for as it is. */
  text: string;
}

/** Whether a message matches the typed text. */
export function textMatcher(text: string): (message: string) => boolean {
  const t = text.trim();
  if (t === "") return () => true;
  try {
    const re = new RegExp(t, "i");
    return (m) => re.test(m);
  } catch {
    const lower = t.toLowerCase();
    return (m) => m.toLowerCase().includes(lower);
  }
}

export function filterEntries(entries: readonly Entry[], f: LogFilter): Entry[] {
  const matches = textMatcher(f.text);
  return entries.filter(
    (e) =>
      (f.level === null || e.level === f.level) &&
      (f.topic === null || e.topic === f.topic) &&
      matches(e.message),
  );
}

/** One row of the list: an entry, and how many times in a row it came. */
export interface Row {
  /** The newest of the run. */
  entry: Entry;
  /** Entries in the run (1 = no repeat). */
  count: number;
}

const same = (a: Entry, b: Entry) =>
  a.level === b.level && a.topic === b.topic && a.torrent === b.torrent && a.message === b.message;

/** Newest first; an entry repeated back to back is one row with its count. */
export function foldRepeats(entries: readonly Entry[]): Row[] {
  const rows: Row[] = [];
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e === undefined) continue;
    const last = rows.at(-1);
    if (last && same(last.entry, e)) last.count += 1;
    else rows.push({ entry: e, count: 1 });
  }
  return rows;
}

export interface DayGroup {
  key: string;
  label: string;
  rows: Row[];
}

/** Rows (newest first) by the viewer's day. */
export function byDay(rows: readonly Row[], now: number, timeZone?: string): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const r of rows) {
    const key = localDay(r.entry.time, { timeZone });
    const last = groups.at(-1);
    if (last?.key === key) last.rows.push(r);
    else groups.push({ key, label: formatDayHeading(r.entry.time, now, { timeZone }), rows: [r] });
  }
  return groups;
}

export interface Counts {
  all: number;
  levels: Record<Level, number>;
  topics: Map<Topic, number>;
}

/** Entries by level (within the topic chosen) and by topic (within the level chosen). */
export function counts(entries: readonly Entry[], f: Pick<LogFilter, "level" | "topic">): Counts {
  const out: Counts = { all: 0, levels: { info: 0, warning: 0, error: 0 }, topics: new Map() };
  for (const e of entries) {
    if (f.topic === null || e.topic === f.topic) {
      out.levels[e.level] += 1;
      out.all += 1;
    }
    if (f.level === null || e.level === f.level) {
      out.topics.set(e.topic, (out.topics.get(e.topic) ?? 0) + 1);
    }
  }
  return out;
}

/** How often the same message came in the last day, and when it first came (of what is kept). */
export function sameMessage(
  entries: readonly Entry[],
  e: Entry,
  now: number,
): { lastDay: number; first: number } {
  let lastDay = 0;
  let first = e.time;
  for (const x of entries) {
    if (x.message !== e.message) continue;
    if (x.time > now - 86_400) lastDay += 1;
    if (x.time < first) first = x.time;
  }
  return { lastDay, first };
}

export interface Hour {
  /** When the hour starts, unix seconds. */
  start: number;
  info: number;
  warning: number;
  error: number;
}

/** Entries per hour over the last 24 hours, by level, oldest hour first. */
export function perHour(entries: readonly Entry[], now: number): Hour[] {
  const top = Math.floor(now / 3600) * 3600;
  const hours: Hour[] = Array.from({ length: 24 }, (_, i) => ({
    start: top - (23 - i) * 3600,
    info: 0,
    warning: 0,
    error: 0,
  }));
  for (const e of entries) {
    const i = 23 - Math.floor((top - Math.floor(e.time / 3600) * 3600) / 3600);
    const h = hours[i];
    if (h && e.time <= now) h[e.level] += 1;
  }
  return hours;
}

/** The messages that came most often today (more than once), most first. */
export function recurring(
  entries: readonly Entry[],
  now: number,
  n = 4,
  timeZone?: string,
): { level: Level; message: string; count: number }[] {
  const today = localDay(now, { timeZone });
  const seen = new Map<string, { level: Level; message: string; count: number }>();
  for (const e of entries) {
    if (localDay(e.time, { timeZone }) !== today) continue;
    const key = `${e.level} ${e.message}`;
    const x = seen.get(key);
    if (x) x.count += 1;
    else seen.set(key, { level: e.level, message: e.message, count: 1 });
  }
  return [...seen.values()]
    .filter((x) => x.count > 1)
    .sort((a, b) => b.count - a.count || a.message.localeCompare(b.message))
    .slice(0, n);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** An entry as a line of text: `2026-09-26 10:41:02 warning torrents message`, in UTC. */
export function entryLine(e: Entry): string {
  const d = new Date(e.time * 1000);
  const when = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  return `${when} ${e.level} ${e.topic}${e.torrent ? ` ${e.torrent}` : ""} ${e.message}`;
}

/** What an export writes: every entry shown, oldest first, one a line (UTC). */
export function exportText(entries: readonly Entry[]): string {
  return entries.map(entryLine).join("\n") + (entries.length > 0 ? "\n" : "");
}
