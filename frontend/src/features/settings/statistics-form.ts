// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Statistics & GeoIP page's form (recording, retention in days, the
// opt-in scrape, the GeoIP files), what is on disk per resolution against
// where the draft's retention cuts it (the chart's geometry, log scale), and
// how much peer traffic GeoIP located. Pure and tested.

import type { Schemas } from "~/api/client";

import type { FormDiff } from "./form";
import { pathProblem } from "./downloads-form";

type Settings = Schemas["Settings"];
type SettingsPatch = Schemas["SettingsPatch"];

const DAY = 86_400;
const DECIMALS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, useGrouping: false });

export const RETENTIONS = [
  "stats_minute_retention",
  "stats_hour_retention",
  "stats_day_retention",
] as const;
export type Retention = (typeof RETENTIONS)[number];

export interface StatsDraft {
  stats_enabled: boolean;
  stats_minute_retention: string;
  stats_hour_retention: string;
  stats_day_retention: string;
  scrape: boolean;
  /** Minutes; kept while `scrape` is off. */
  stats_scrape_interval: string;
  geoip_database: string;
  geoip_asn_database: string;
}

export type StatsField = keyof StatsDraft;

/** Seconds as days (`7`, `0.5`); `null` (forever) is empty. */
export function daysText(seconds: number | null): string {
  return seconds === null ? "" : DECIMALS.format(seconds / DAY);
}

/** Days typed as seconds; empty is forever (`null`); `undefined` = not valid. */
export function parseDays(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "" || t === "∞") return null;
  if (!/^\d+(\.\d+)?$/.test(t) || Number(t) <= 0) return undefined;
  return Math.max(Math.round(Number(t) * DAY), 1);
}

/** The scrape interval the daemon allows at least, seconds. */
export const MIN_SCRAPE = 1800;

export function statsDraft(s: Settings, prev?: StatsDraft): StatsDraft {
  return {
    stats_enabled: s.stats_enabled,
    stats_minute_retention: daysText(s.stats_minute_retention),
    stats_hour_retention: daysText(s.stats_hour_retention),
    stats_day_retention: daysText(s.stats_day_retention),
    scrape: s.stats_scrape_interval !== null,
    stats_scrape_interval:
      s.stats_scrape_interval !== null
        ? DECIMALS.format(s.stats_scrape_interval / 60)
        : (prev?.stats_scrape_interval ?? "60"),
    geoip_database: s.geoip_database ?? "",
    geoip_asn_database: s.geoip_asn_database ?? "",
  };
}

export function statsDiff(saved: Settings, d: StatsDraft): FormDiff<StatsField> {
  const patch: Record<string, unknown> = {};
  const changed = new Set<StatsField>();
  const names: string[] = [];
  const errors: Partial<Record<StatsField, string>> = {};
  const note = (field: StatsField, name: string, value: unknown) => {
    patch[name] = value;
    changed.add(field);
    names.push(name);
  };
  const fail = (field: StatsField, problem: string) => {
    errors[field] = problem;
    changed.add(field);
  };

  if (d.stats_enabled !== saved.stats_enabled) {
    note("stats_enabled", "stats_enabled", d.stats_enabled);
  }
  for (const f of RETENTIONS) {
    const v = parseDays(d[f]);
    if (v === undefined) fail(f, "Days, such as 7 or 0.5; empty keeps them forever.");
    else if (v !== saved[f]) note(f, f, v);
  }
  if (d.scrape) {
    const t = d.stats_scrape_interval.trim();
    const secs = /^\d+(\.\d+)?$/.test(t) ? Math.round(Number(t) * 60) : NaN;
    if (!(secs >= MIN_SCRAPE)) fail("stats_scrape_interval", "Minutes, at least 30.");
    else if (secs !== saved.stats_scrape_interval) {
      note("stats_scrape_interval", "stats_scrape_interval", secs);
    }
  } else if (saved.stats_scrape_interval !== null) {
    note("scrape", "stats_scrape_interval", null);
  }
  for (const f of ["geoip_database", "geoip_asn_database"] as const) {
    const v = d[f].trim() === "" ? null : d[f].trim();
    const problem = v === null ? null : pathProblem(v);
    if (problem) fail(f, problem);
    else if (v !== saved[f]) note(f, f, v);
  }
  return { patch: patch as SettingsPatch, changed, names, errors };
}

// ---------------------------------------------------------------------------
// What is on disk, and where retention cuts it

export interface Tier {
  name: string;
  /** Days of it on disk (from its oldest bucket to now); `null` = none yet. */
  have: number | null;
  /** Days kept; `null` = forever. */
  keep: number | null;
}

export function tiers(
  info: Pick<Schemas["StatsInfo"], "oldest_minute" | "oldest_hour" | "oldest_day">,
  keep: Record<Retention, number | null>,
  now: number,
): Tier[] {
  const age = (t: number | null) => (t === null ? null : Math.max(now - t, 0) / DAY);
  // Days are whole buckets: today's counts as one.
  const wholeDays = (t: number | null) =>
    t === null ? null : Math.floor(Math.max(now - t, 0) / DAY) + 1;
  const days = (s: number | null) => (s === null ? null : s / DAY);
  return [
    { name: "Per minute", have: age(info.oldest_minute), keep: days(keep.stats_minute_retention) },
    { name: "Per hour", have: age(info.oldest_hour), keep: days(keep.stats_hour_retention) },
    {
      name: "Days · timeline",
      have: wholeDays(info.oldest_day),
      keep: days(keep.stats_day_retention),
    },
  ];
}

/** The chart's time axis: an hour to a year or more ago, log scale, right to left. */
export interface Axis {
  /** Days at the left end. */
  max: number;
  /** Where `days` ago lands between `x0` (oldest) and `x1` (now). */
  x: (days: number) => number;
  ticks: { days: number; label: string }[];
}

const MIN_DAYS = 1 / 24;

export function axis(tiersShown: readonly Tier[], x0: number, x1: number): Axis {
  const longest = Math.max(
    365,
    ...tiersShown.flatMap((t) => [t.have ?? 0, t.keep ?? 0]).map((d) => d * 1.05),
  );
  const years = Math.ceil(longest / 365);
  const max = years * 365;
  const lo = Math.log10(MIN_DAYS);
  const span = Math.log10(max) - lo;
  const x = (days: number) =>
    x1 - ((Math.log10(Math.min(Math.max(days, MIN_DAYS), max)) - lo) / span) * (x1 - x0);
  const ticks = [
    { days: MIN_DAYS, label: "1 h" },
    { days: 1, label: "1 d" },
    { days: 7, label: "7 d" },
    { days: 30, label: "30 d" },
    { days: 90, label: "90 d" },
    { days: 365, label: "1 y" },
  ];
  if (years > 1) ticks.push({ days: max, label: `${years} y` });
  return { max, x, ticks };
}

/** `6.2 d`, `89 d`, `5 h`, `12 min`: an amount of days, short. */
export function daysLabel(days: number): string {
  if (days < 1 / 24) return `${Math.max(Math.round(days * 1440), 1)} min`;
  if (days < 1) return `${Math.round(days * 24)} h`;
  return days < 10 ? `${DECIMALS.format(Math.round(days * 10) / 10)} d` : `${Math.round(days)} d`;
}

/** A tier's line under its bar. */
export function tierLabel(t: Tier): string {
  const have = t.have === null ? "nothing on disk yet" : `${daysLabel(t.have)} on disk`;
  const keep = t.keep === null ? "kept forever" : `cut at ${daysLabel(t.keep)}`;
  return `${have} · ${keep}`;
}

// ---------------------------------------------------------------------------
// GeoIP

/**
 * The share of peer traffic GeoIP put somewhere (`GET /stats/geo` rows: a
 * `null` place is not located); `null` when no peer traffic was recorded.
 */
export function locatedShare(
  rows: readonly Pick<Schemas["GeoRow"], "country" | "asn" | "downloaded" | "uploaded">[],
  dim: "country" | "asn",
): number | null {
  let total = 0;
  let located = 0;
  for (const r of rows) {
    const bytes = r.downloaded + r.uploaded;
    total += bytes;
    if ((dim === "country" ? r.country : r.asn) !== null) located += bytes;
  }
  return total === 0 ? null : located / total;
}
