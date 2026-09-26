// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The range a report covers, from the URL: a preset (`?range=7d`), or days
// picked in the viewer's zone (`?from=2026-09-17&to=2026-09-24`, both
// included). The daemon names buckets by their UTC start; charts group its
// buckets into fewer, wider ones.

import { formatShortDate, localDay } from "~/lib/format";

export type Preset = "today" | "24h" | "7d" | "30d" | "90d" | "all";

export const OVERVIEW_PRESETS = [
  { value: "today", label: "Today" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
  { value: "90d", label: "90 days" },
  { value: "all", label: "All" },
] as const satisfies readonly { value: Preset; label: string }[];

export const TRACKER_PRESETS = [
  { value: "24h", label: "24 h" },
  { value: "7d", label: "7 d" },
  { value: "30d", label: "30 d" },
  { value: "90d", label: "90 d" },
] as const satisfies readonly { value: Preset; label: string }[];

const DAY = 86_400;

const SPANS: Record<Exclude<Preset, "today" | "all">, number> = {
  "24h": DAY,
  "7d": 7 * DAY,
  "30d": 30 * DAY,
  "90d": 90 * DAY,
};

const WORDS: Record<Preset, string> = {
  today: "today",
  "24h": "last 24 hours",
  "7d": "last 7 days",
  "30d": "last 30 days",
  "90d": "last 90 days",
  all: "everything recorded",
};

export interface RangeParams {
  range?: string;
  from?: string;
  to?: string;
  [key: string]: string | undefined;
}

export interface Range {
  /** Unix seconds. */
  from: number;
  /** Unix seconds (now for a preset). */
  to: number;
  /** `null`: days picked. */
  preset: Preset | null;
  /** For subtitles: `last 7 days`, `today`, `Sep 17 – Sep 24`. */
  words: string;
  /** How long the range is meant to be (today: a day); `null` for all. */
  length: number | null;
  /** For comparisons: `previous 7 days`; `null` when there is nothing to compare with. */
  previous: string | null;
}

export interface ZoneOptions {
  /** An IANA time zone; the viewer's by default. */
  timeZone?: string;
}

/** Seconds a zone is ahead of UTC at an instant. */
function zoneOffset(unix: number, tz?: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
  }).formatToParts(new Date(unix * 1000));
  const n = (t: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === t)?.value);
  const wall = Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second"));
  return wall / 1000 - unix;
}

/** When a calendar day (`2026-09-17`) starts in a zone; `null` for no such day. */
export function dayStart(day: string, opts: ZoneOptions = {}): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
  if (!Number.isFinite(guess)) return null;
  // Twice: the offset at the guess may differ from the one at midnight.
  let t = guess - zoneOffset(guess, opts.timeZone);
  t = guess - zoneOffset(t, opts.timeZone);
  return localDay(t, opts) === day ? t : null;
}

/** When the day after the one `unix` falls on starts. */
function nextDayStart(unix: number, opts: ZoneOptions): number {
  const next = dayStart(localDay(unix + 36 * 3600, opts), opts);
  return next ?? unix + DAY;
}

/**
 * The range the URL asks for. `oldest` is the oldest bucket kept (for
 * `all`); days picked end at their last second, or now for today.
 */
export function rangeOf(
  params: RangeParams,
  presets: readonly { value: Preset }[],
  fallback: Preset,
  now: number,
  oldest: number | null,
  opts: ZoneOptions = {},
): Range {
  const first = params.from ? dayStart(params.from, opts) : null;
  const last = params.to ? dayStart(params.to, opts) : null;
  if (first !== null && last !== null && last >= first && first <= now) {
    const to = Math.min(nextDayStart(last, opts) - 1, now);
    const days = Math.round((nextDayStart(last, opts) - first) / DAY);
    return {
      from: first,
      to,
      preset: null,
      words: datesLabel(first, to, opts),
      length: days * DAY,
      previous: `previous ${days === 1 ? "day" : `${days} days`}`,
    };
  }
  const preset = presets.some((p) => p.value === params.range)
    ? (params.range as Preset)
    : fallback;
  let from: number;
  let length: number | null;
  let previous: string | null;
  switch (preset) {
    case "today":
      from = dayStart(localDay(now, opts), opts) ?? now - DAY;
      length = DAY;
      previous = "yesterday by this time";
      break;
    case "all":
      from = Math.min(oldest ?? now - DAY, now - 60);
      length = null;
      previous = null;
      break;
    default:
      from = now - SPANS[preset];
      length = SPANS[preset];
      previous = WORDS[preset].replace("last", "previous");
  }
  return { from, to: now, preset, words: WORDS[preset], length, previous };
}

/** The same range one length earlier (yesterday by this time, the 7 days before); `null` for all. */
export function previousRange(r: Range): { from: number; to: number } | null {
  if (r.length === null) return null;
  return { from: r.from - r.length, to: Math.min(r.to - r.length, r.from - 1) };
}

/** The dates of a range, for its button: `Sep 17 – Sep 24`, or one date. */
export function datesLabel(from: number, to: number, opts: ZoneOptions = {}): string {
  const a = formatShortDate(from, opts);
  const b = formatShortDate(to, opts);
  return a === b ? a : `${a} – ${b}`;
}

/** Bucket sizes a chart groups the daemon's buckets into. */
const BUCKETS = [60, 300, 900, 1800, 3600, 10_800, 21_600, 43_200, 86_400, 604_800] as const;

/** Seconds per bucket of the daemon's steps. */
export const STEP_SECONDS = { minute: 60, hour: 3600, day: 86_400 } as const;

/** The narrowest chart bucket, at least the daemon's step, with at most `most` over the span. */
export function chartBucket(span: number, step: number, most = 100): number {
  return BUCKETS.find((b) => b >= step && span / b <= most) ?? 604_800;
}

/** A bucket size in words: `15 minutes`, `3 hours`, `day`, `week`. */
export function bucketWords(secs: number): string {
  if (secs >= 604_800) return "week";
  if (secs >= 86_400) return "day";
  if (secs === 3600) return "hour";
  if (secs > 3600) return `${secs / 3600} hours`;
  if (secs === 60) return "minute";
  return `${secs / 60} minutes`;
}

/** The starts of the daemon's buckets in a range: at or after `from`, at or before `to`. */
export function bucketStarts(from: number, to: number, step: number): number[] {
  const out: number[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) out.push(t);
  return out;
}

/** The starts of the viewer's days from the one `from` falls on to `to`. */
export function localDayStarts(from: number, to: number, opts: ZoneOptions = {}): number[] {
  const out: number[] = [];
  let t = dayStart(localDay(from, opts), opts) ?? from;
  while (t <= to) {
    out.push(t);
    t = nextDayStart(t, opts);
  }
  return out;
}

/** The bucket (by sorted starts) a time falls in; -1 before the first. */
export function bucketIndex(starts: readonly number[], t: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((starts[mid] ?? Infinity) <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export type BarUnit = "hour" | "day" | "utc-day";

/**
 * The bars of a per-tracker report: hours over a day or two, else the
 * viewer's days (hours grouped), or UTC days when the daemon kept only
 * days for the range.
 */
export function reportBars(
  step: "minute" | "hour" | "day",
  from: number,
  to: number,
  opts: ZoneOptions = {},
): { starts: number[]; unit: BarUnit } {
  if (step === "day") return { starts: bucketStarts(from, to, 86_400), unit: "utc-day" };
  if (to - from <= 2 * DAY) return { starts: bucketStarts(from, to, 3600), unit: "hour" };
  return { starts: localDayStarts(from, to, opts), unit: "day" };
}
