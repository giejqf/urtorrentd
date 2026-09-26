// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The History tab's model: one torrent's recorded days
// (`/stats/torrents/{hash}/days`, UTC days) as a grid of the last weeks
// shaded by upload, the last 30 days in figures, and its last day of
// traffic by hour (`.../traffic`). A day with no row is a day the torrent
// neither ran nor moved data; days before its first row are left blank,
// not called idle. Pure and tested.

import type { Schemas } from "~/api/client";

type Day = Schemas["TorrentDay"];
type Point = Schemas["TrafficPoint"];

export const DAY = 86_400;
const HOUR = 3600;

/** A day's upload in copies of the torrent: 0 is none, 4 a whole copy or more. */
export type Level = 0 | 1 | 2 | 3 | 4;

export interface Cell {
  /** The day's start (00:00 UTC). */
  t: number;
  /** Week (0 = the oldest shown) and day of the week (0 = Monday). */
  col: number;
  row: number;
  /** `null`: it neither seeded nor uploaded that day. */
  level: Level | null;
  uploaded: number;
  seeding: number;
}

/** Copies uploaded in a day, from 0.1 of the torrent to a whole one. */
export const LEVEL_EDGES = [0.1, 0.5, 1] as const;

export function level(uploaded: number, size: number): Level {
  if (uploaded <= 0) return 0;
  if (size <= 0) return 2;
  const copies = uploaded / size;
  return copies < LEVEL_EDGES[0]
    ? 1
    : copies < LEVEL_EDGES[1]
      ? 2
      : copies < LEVEL_EDGES[2]
        ? 3
        : 4;
}

export const dayStart = (t: number) => Math.floor(t / DAY) * DAY;
/** Monday = 0 (1970-01-01 was a Thursday). */
const weekday = (t: number) => (Math.floor(t / DAY) + 3) % 7;

/**
 * The last `weeks` weeks to today, Monday to Sunday, one cell per day from
 * `since` (the first recorded day) on.
 */
export function seedingCells(
  days: readonly Day[],
  size: number,
  now: number,
  since: number | null,
  weeks = 12,
): Cell[] {
  const today = dayStart(now);
  const first = today - weekday(today) * DAY - (weeks - 1) * 7 * DAY;
  const by = new Map(days.map((d) => [d.t, d]));
  const cells: Cell[] = [];
  if (since === null) return cells;
  for (let t = Math.max(first, dayStart(since)); t <= today; t += DAY) {
    const d = by.get(t);
    const uploaded = d?.uploaded ?? 0;
    const seeding = d?.seeding_time ?? 0;
    cells.push({
      t,
      col: Math.floor((t - first) / (7 * DAY)),
      row: weekday(t),
      level: seeding > 0 || uploaded > 0 ? level(uploaded, size) : null,
      uploaded,
      seeding,
    });
  }
  return cells;
}

/** The first day of each week shown, for the axis. */
export function weekStarts(now: number, weeks = 12): number[] {
  const today = dayStart(now);
  const first = today - weekday(today) * DAY - (weeks - 1) * 7 * DAY;
  return Array.from({ length: weeks }, (_, i) => first + i * 7 * DAY);
}

export interface Figures {
  /** Bytes uploaded in the last 30 days (today included). */
  uploaded30: number;
  /** Of the last 30 days, those it seeded on. */
  seeded30: number;
  /** The most completed downloads a scrape reported (newest day that has one). */
  completed: number | null;
  /** The first recorded day. */
  since: number | null;
  best: { t: number; uploaded: number } | null;
  /** The ratio a week ago (end of that day), to compare with now. */
  ratioWeekAgo: number | null;
}

export function figures(days: readonly Day[], now: number): Figures {
  const today = dayStart(now);
  const from30 = today - 29 * DAY;
  const sorted = [...days].sort((a, b) => a.t - b.t);
  let uploaded30 = 0;
  let seeded30 = 0;
  let best: Figures["best"] = null;
  let completed: number | null = null;
  let ratioWeekAgo: number | null = null;
  for (const d of sorted) {
    if (d.t >= from30 && d.t <= today) {
      uploaded30 += d.uploaded;
      if (d.seeding_time > 0) seeded30 += 1;
    }
    if (d.uploaded > 0 && (best === null || d.uploaded > best.uploaded)) {
      best = { t: d.t, uploaded: d.uploaded };
    }
    if (d.swarm_completed_max !== null) completed = d.swarm_completed_max;
    if (d.t <= today - 7 * DAY) ratioWeekAgo = d.ratio;
  }
  return {
    uploaded30,
    seeded30,
    completed,
    since: sorted[0]?.t ?? null,
    best,
    ratioWeekAgo,
  };
}

export interface HourBucket {
  t: number;
  downloaded: number;
  uploaded: number;
}

/** The last 24 hours by hour (the current one running), hours with nothing as zeros. */
export function lastDay(points: readonly Point[], now: number): HourBucket[] {
  const last = Math.floor(now / HOUR) * HOUR;
  const by = new Map(points.map((p) => [p.t, p]));
  return Array.from({ length: 24 }, (_, i) => {
    const t = last - (23 - i) * HOUR;
    const p = by.get(t);
    return { t, downloaded: p?.downloaded ?? 0, uploaded: p?.uploaded ?? 0 };
  });
}

/** A line through the buckets' values, `w` × `h` with 0 at the bottom. */
export function linePath(values: readonly number[], max: number, w: number, h: number): string {
  if (values.length === 0) return "";
  const step = values.length > 1 ? w / (values.length - 1) : w;
  const y = (v: number) => (max > 0 ? h - (v / max) * (h - 2) : h);
  return values
    .map((v, i) => `${i === 0 ? "M" : "L"}${(i * step).toFixed(1)} ${y(v).toFixed(1)}`)
    .join(" ");
}
