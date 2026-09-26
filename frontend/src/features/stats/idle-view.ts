// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Idle seeds report: complete torrents by what they uploaded in the
// window against their size (`/stats/idle-seeds`), what they occupy, and a
// log-log picture of size against value.

import type { Schemas } from "~/api/client";

type IdleSeed = Schemas["IdleSeed"];

export const WINDOWS = [
  { value: "7", label: "7 d" },
  { value: "30", label: "30 d" },
  { value: "90", label: "90 d" },
  { value: "365", label: "365 d" },
] as const;

export type Window = (typeof WINDOWS)[number]["value"];

export function windowOf(param: string | undefined): Window {
  return WINDOWS.find((w) => w.value === param)?.value ?? "30";
}

/** Under 0.1× is idle (red), under 1× low (amber), from 1× it earns its keep. */
export type ValueClass = "idle" | "low" | "earning";

export function valueClass(value: number): ValueClass {
  if (value < 0.1) return "idle";
  if (value < 1) return "low";
  return "earning";
}

/** The tag that marks a torrent to keep whatever it shares. */
export const KEEP = "keep";

export interface IdleSummary {
  size: number;
  idle: { count: number; size: number };
  /** Uploaded in the window by the torrents that are not idle. */
  others: { count: number; uploaded: number };
}

export function idleSummary(seeds: readonly IdleSeed[]): IdleSummary {
  const out = { size: 0, idle: { count: 0, size: 0 }, others: { count: 0, uploaded: 0 } };
  for (const s of seeds) {
    out.size += s.size;
    if (valueClass(s.value) === "idle") {
      out.idle.count += 1;
      out.idle.size += s.size;
    } else {
      out.others.count += 1;
      out.others.uploaded += s.uploaded;
    }
  }
  return out;
}

/** The idle ones not tagged to keep: what "Select all under 0.1×" takes. */
export function idleUnkept(
  seeds: readonly IdleSeed[],
  tagsOf: (hash: string) => readonly string[],
) {
  return seeds.filter((s) => valueClass(s.value) === "idle" && !tagsOf(s.hash).includes(KEEP));
}

/**
 * How much of the window was recorded: `full`, the days covered, or
 * nothing. `recordedFrom` is when recording covers the window from.
 */
export function coverage(
  from: number,
  recordedFrom: number | null,
  now: number,
): { kind: "full" } | { kind: "partial"; seconds: number } | { kind: "none" } {
  if (recordedFrom === null) return { kind: "none" };
  if (recordedFrom <= from) return { kind: "full" };
  return { kind: "partial", seconds: Math.max(0, now - recordedFrom) };
}

/** A log scale from `lo` to `hi` onto `a`..`b` (values at or below `lo` sit at `a`). */
export function logScale(lo: number, hi: number, a: number, b: number): (v: number) => number {
  const l0 = Math.log10(lo);
  const l1 = Math.log10(hi);
  return (v) => {
    if (!(v > lo)) return a;
    return a + ((Math.min(Math.log10(v), l1) - l0) / (l1 - l0)) * (b - a);
  };
}

/** Round numbers from `lo` to `hi` for a log axis: 1, 2 and 5 × 10ⁿ (or powers of ten when many). */
export function logTicks(lo: number, hi: number, most = 7): number[] {
  const out: number[] = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e += 1) {
    for (const f of [1, 2, 5]) {
      const v = f * 10 ** e;
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
    }
  }
  const decade = (v: number) => Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9;
  return out.length > most ? out.filter((v) => decade(v) || v === lo) : out;
}

/** The size axis: from a power of ten below the smallest to one above the largest. */
export function sizeRange(seeds: readonly IdleSeed[]): [number, number] {
  const sizes = seeds.map((s) => s.size).filter((s) => s > 0);
  if (sizes.length === 0) return [1e6, 1e9];
  const lo = 10 ** Math.floor(Math.log10(Math.min(...sizes)));
  const hi = 10 ** Math.ceil(Math.log10(Math.max(...sizes)));
  return [lo, hi > lo ? hi : lo * 10];
}

/** The value axis: 0.001× to at least 100×. */
export function valueRange(seeds: readonly IdleSeed[]): [number, number] {
  const most = Math.max(100, ...seeds.map((s) => s.value));
  return [0.001, 10 ** Math.ceil(Math.log10(most))];
}

/** Big, for the "big and idle" corner: 1 GB and more. */
export const BIG = 1e9;

const csvCell = (v: string | number | null): string => {
  if (v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The report as CSV: one line per torrent, bytes and seconds, times in UTC. */
export function idleCsv(seeds: readonly IdleSeed[], days: number): string {
  const head = [
    "name",
    "hash",
    "size_bytes",
    `uploaded_${days}d_bytes`,
    "value",
    `seeding_${days}d_seconds`,
    "last_upload_utc",
    "ratio",
    "tracker",
    "state",
    "category",
  ];
  const iso = (t: number | null) => (t === null ? null : new Date(t * 1000).toISOString());
  const lines = seeds.map((s) =>
    [
      s.name,
      s.hash,
      s.size,
      s.uploaded,
      s.value.toFixed(4),
      s.seeding_time,
      iso(s.last_upload),
      s.ratio === null ? null : s.ratio.toFixed(3),
      s.tracker,
      s.state,
      s.category,
    ]
      .map(csvCell)
      .join(","),
  );
  return [head.join(","), ...lines].join("\n") + "\n";
}
