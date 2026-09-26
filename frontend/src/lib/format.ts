// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The only place where the API's units (bytes, bytes per second, seconds,
// unix seconds) become text, and where typed text becomes them again
// (AGENTS.md 4.1, 8). Formatting never changes a value: `null` (unknown or
// unlimited) is the caller's to show, as `dash` or `unlimited`.

/** Shown for an unknown value. */
export const dash = "—";
/** Shown for an unlimited limit (`null` in a limit field). */
export const unlimited = "∞";

export interface UnitOptions {
  /** Binary units (KiB, MiB: powers of 1024) instead of decimal (kB, MB). */
  binary?: boolean;
}

const DECIMAL = ["B", "kB", "MB", "GB", "TB", "PB", "EB"] as const;
const BINARY = ["B", "KiB", "MiB", "GiB", "TiB", "PiB", "EiB"] as const;

/**
 * A byte count: `0 B`, `640 kB`, `6.3 GB`, `11.2 GB`, `318 MB`. One decimal
 * below 100 of a unit, none from 100 on.
 */
export function formatBytes(bytes: number, opts: UnitOptions = {}): string {
  const units = opts.binary ? BINARY : DECIMAL;
  const base = opts.binary ? 1024 : 1000;
  if (!Number.isFinite(bytes) || bytes < 0) return dash;
  if (bytes < base) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= base && unit < units.length - 1) {
    value /= base;
    unit += 1;
  }
  let digits = value >= 100 ? 0 : 1;
  let text = value.toFixed(digits);
  // 999.96 MB rounds to "1000 MB": that is 1.0 GB.
  if (Number(text) >= base && unit < units.length - 1) {
    value /= base;
    unit += 1;
    digits = 1;
    text = value.toFixed(digits);
  }
  return `${text} ${units[unit]}`;
}

/** A rate in bytes per second: `8.1 MB/s`, `640 kB/s`, `0 B/s`. */
export function formatRate(bytesPerSecond: number, opts: UnitOptions = {}): string {
  return `${formatBytes(bytesPerSecond, opts)}/s`;
}

/** A limit in bytes per second, `null` being unlimited: `∞`, `5.0 MB/s`. */
export function formatLimit(bytesPerSecond: number | null, opts: UnitOptions = {}): string {
  return bytesPerSecond === null ? unlimited : formatRate(bytesPerSecond, opts);
}

/**
 * The unit an axis of byte values up to `max` is written in, and its size:
 * `{ unit: "GB", size: 1e9 }`. Values are divided by `size` for their labels.
 */
export function byteUnit(max: number, opts: UnitOptions = {}): { unit: string; size: number } {
  const units = opts.binary ? BINARY : DECIMAL;
  const base = opts.binary ? 1024 : 1000;
  let unit = 0;
  let size = 1;
  while (max >= size * base && unit < units.length - 1) {
    size *= base;
    unit += 1;
  }
  return { unit: units[unit] ?? "B", size };
}

/** A number on an axis: at most one decimal, none from 10 on (`2.5`, `40`). */
export function formatAxis(value: number): string {
  if (!Number.isFinite(value)) return dash;
  return value >= 10 || Number.isInteger(value) ? String(Math.round(value)) : value.toFixed(1);
}

/**
 * A piece size, always binary (pieces are powers of two): `4 MiB`, `16 KiB`.
 */
export function formatPieceSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return dash;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BINARY.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1);
  return `${text} ${BINARY[unit]}`;
}

const SPANS = [
  ["d", 86_400],
  ["h", 3_600],
  ["m", 60],
  ["s", 1],
] as const;

/**
 * A duration in seconds, by its two largest units: `3m 12s`, `12d 4h`,
 * `11m`, `83d`, `0s`.
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return dash;
  let rest = Math.floor(seconds);
  if (rest === 0) return "0s";
  const parts: string[] = [];
  for (const [label, size] of SPANS) {
    const n = Math.floor(rest / size);
    rest -= n * size;
    if (parts.length > 0) {
      if (n > 0) parts.push(`${n}${label}`);
      break;
    }
    if (n > 0) parts.push(`${n}${label}`);
  }
  return parts.join(" ");
}

/** An ETA in seconds; `null` (unknown, or nothing left) is a dash. */
export function formatEta(seconds: number | null): string {
  return seconds === null ? dash : formatDuration(seconds);
}

/** A share ratio with two decimals; `null` (nothing downloaded yet) is a dash. */
export function formatRatio(ratio: number | null): string {
  if (ratio === null || !Number.isFinite(ratio)) return dash;
  return ratio.toFixed(2);
}

/**
 * Progress (0 to 1) as a percentage, rounded down so that an incomplete
 * torrent never shows 100%: `62%`, `99.9%` with one decimal.
 */
export function formatPercent(progress: number, decimals = 0): string {
  if (!Number.isFinite(progress)) return dash;
  const p = Math.min(Math.max(progress, 0), 1);
  if (p >= 1) return "100%";
  const scale = 10 ** decimals;
  const value = Math.floor(p * 100 * scale) / scale;
  return `${value.toFixed(decimals)}%`;
}

const COUNT = new Intl.NumberFormat("en-US");

/** A count with thousands separators: `3,072`. */
export function formatCount(n: number): string {
  return COUNT.format(n);
}

export interface TimeOptions {
  /** A BCP 47 locale; the browser's by default. */
  locale?: string;
  /** An IANA time zone; the viewer's by default. */
  timeZone?: string;
}

/** A unix time as a short date and time in the viewer's zone: `Sep 24, 10:02`. */
export function formatDateTime(unix: number | null, opts: TimeOptions = {}): string {
  if (unix === null || !Number.isFinite(unix)) return dash;
  return new Intl.DateTimeFormat(opts.locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: opts.timeZone,
  }).format(new Date(unix * 1000));
}

/** A unix time as a time of day with seconds: `10:41:02`. */
export function formatTime(unix: number, opts: TimeOptions = {}): string {
  return new Intl.DateTimeFormat(opts.locale ?? "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: opts.timeZone,
  }).format(new Date(unix * 1000));
}

/** A unix time as a time of day: `18:30`. */
export function formatClock(unix: number, opts: TimeOptions = {}): string {
  return new Intl.DateTimeFormat(opts.locale ?? "en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: opts.timeZone,
  }).format(new Date(unix * 1000));
}

/** A span as days, or hours and minutes under a day: `30 d`, `5 h`, `12 min`. */
export function formatDays(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return dash;
  if (seconds >= 86_400) return `${Math.round(seconds / 86_400)} d`;
  if (seconds >= 3600) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 60)} min`;
}

/** A change as a fraction, with its direction: `▲ 12%`, `▼ 8%`, `± 0%`. */
export function formatChange(fraction: number): string {
  const pct = Math.round(Math.abs(fraction) * 100);
  if (pct === 0) return "± 0%";
  return `${fraction > 0 ? "▲" : "▼"} ${formatCount(pct)}%`;
}

/** The viewer's calendar day of a unix time, as `2026-09-26`. */
export function localDay(unix: number, opts: TimeOptions = {}): string {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: opts.timeZone,
  }).format(new Date(unix * 1000));
}

/**
 * A day as a list heading: `Today · Sat 26 Sep`, `Yesterday · Fri 25 Sep`,
 * else `Wed 23 Sep` (with the year when it is not this one).
 */
export function formatDayHeading(unix: number, now: number, opts: TimeOptions = {}): string {
  const day = localDay(unix, opts);
  const sameYear = day.slice(0, 4) === localDay(now, opts).slice(0, 4);
  const parts = new Intl.DateTimeFormat(opts.locale ?? "en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: opts.timeZone,
  }).formatToParts(new Date(unix * 1000));
  const part = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "";
  const date = [part("weekday"), part("day"), part("month"), sameYear ? "" : part("year")]
    .filter((x) => x !== "")
    .join(" ");
  if (day === localDay(now, opts)) return `Today · ${date}`;
  if (day === localDay(now - 86_400, opts)) return `Yesterday · ${date}`;
  return date;
}

/** A unix time as a month and year: `Mar 2027` (expiries, far dates). */
export function formatMonth(unix: number | null, opts: TimeOptions = {}): string {
  if (unix === null || !Number.isFinite(unix)) return dash;
  return new Intl.DateTimeFormat(opts.locale, {
    year: "numeric",
    month: "short",
    timeZone: opts.timeZone,
  }).format(new Date(unix * 1000));
}

/** A unix time as a month and day: `Mar 02` (recent dates, the year implied). */
export function formatShortDate(unix: number | null, opts: TimeOptions = {}): string {
  if (unix === null || !Number.isFinite(unix)) return dash;
  return new Intl.DateTimeFormat(opts.locale, {
    month: "short",
    day: "2-digit",
    timeZone: opts.timeZone,
  }).format(new Date(unix * 1000));
}

/** A unix time as a date: `Sep 16, 2026`. */
export function formatDate(unix: number | null, opts: TimeOptions = {}): string {
  if (unix === null || !Number.isFinite(unix)) return dash;
  return new Intl.DateTimeFormat(opts.locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: opts.timeZone,
  }).format(new Date(unix * 1000));
}

/** A unix time as a full date and time: `Sep 24, 2026, 10:02:05`. */
export function formatFullDateTime(unix: number | null, opts: TimeOptions = {}): string {
  if (unix === null || !Number.isFinite(unix)) return dash;
  return new Intl.DateTimeFormat(opts.locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
    timeZone: opts.timeZone,
  }).format(new Date(unix * 1000));
}

/**
 * How long ago a unix time was, by its largest unit: `just now`, `12s ago`,
 * `5m ago`, `3h ago`, `2d ago`; a week or more shows the date.
 */
export function formatAgo(unix: number | null, now: number, opts: TimeOptions = {}): string {
  if (unix === null || !Number.isFinite(unix)) return dash;
  const age = Math.floor(now - unix);
  if (age < 5) return "just now";
  if (age >= 7 * 86_400) return formatDateTime(unix, opts);
  for (const [label, size] of SPANS) {
    if (age >= size) return `${Math.floor(age / size)}${label} ago`;
  }
  return "just now";
}

const UNIT_FACTORS: Record<string, [number, number]> = {
  // unit: [decimal factor, binary factor] (the bare letters follow the preference)
  "": [1, 1],
  b: [1, 1],
  k: [1e3, 1024],
  m: [1e6, 1024 ** 2],
  g: [1e9, 1024 ** 3],
  t: [1e12, 1024 ** 4],
};

/**
 * Typed text as bytes: `5`, `500k`, `5 MB`, `5.5 GiB`, `8 MB/s`. Explicit
 * units win (`kB` = 1000, `KiB` = 1024); bare `k`, `m`, `g`, `t` follow the
 * unit preference. `undefined` when the text is not a size.
 */
export function parseBytes(text: string, opts: UnitOptions = {}): number | undefined {
  const m = /^\s*(\d+(?:\.\d+)?|\.\d+)\s*([kmgt]?)(i?)(b?)\s*(?:\/\s*s)?\s*$/i.exec(text);
  if (!m) return undefined;
  const [, num, prefix = "", iec = "", byte = ""] = m;
  const value = Number(num);
  const p = prefix.toLowerCase();
  if (iec && !p) return undefined; // "5 ib"
  const factors = UNIT_FACTORS[p];
  if (!factors) return undefined;
  let factor: number;
  if (!p) factor = 1;
  else if (iec) factor = factors[1];
  else if (byte) factor = factors[0];
  else factor = opts.binary ? factors[1] : factors[0];
  const bytes = Math.round(value * factor);
  return Number.isSafeInteger(bytes) ? bytes : undefined;
}

/**
 * Typed text as a limit: empty, `∞` or `unlimited` is `null` (no limit);
 * otherwise as [`parseBytes`]. `undefined` when the text is neither.
 */
export function parseLimit(text: string, opts: UnitOptions = {}): number | null | undefined {
  const t = text.trim().toLowerCase();
  if (t === "" || t === unlimited || t === "unlimited" || t === "none") return null;
  return parseBytes(text, opts);
}
