// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The RSS settings page's arithmetic, by the daemon's rules (rss/mod.rs): a
// feed is due its interval (its own, else the setting) after its last
// refresh, successful or not, and at once when it was never refreshed. How
// many requests a day that makes, when the next hour's refreshes come, and
// a rule in a line. Pure and tested.

import type { Schemas } from "~/api/client";

import type { FormDiff } from "./form";
import { parseCount } from "./speed-form";

type Settings = Schemas["Settings"];
type Feed = Pick<Schemas["RssFeed"], "refresh_interval" | "last_refresh">;

/** Refreshes a day, with `every` seconds for feeds without their own interval. */
export function requestsPerDay(feeds: readonly Feed[], every: number): number {
  return Math.round(
    feeds.reduce((n, f) => n + 86_400 / Math.max(60, f.refresh_interval ?? every), 0),
  );
}

/** When a feed refreshes between `now` and `now + horizon` (unix seconds). */
export function refreshesWithin(f: Feed, every: number, now: number, horizon: number): number[] {
  const step = Math.max(60, f.refresh_interval ?? every);
  let at = f.last_refresh === null ? now : Math.max(now, f.last_refresh + step);
  const out: number[] = [];
  while (at <= now + horizon && out.length < 200) {
    out.push(at);
    at += step;
  }
  return out;
}

/** A rule's filter in a line: `ubuntu-2*  ·  not: beta  ·  smart filter`. */
export function ruleFilter(
  r: Pick<
    Schemas["RssRule"],
    | "must_contain"
    | "must_not_contain"
    | "use_regex"
    | "episode_filter"
    | "smart_filter"
    | "ignore_days"
  >,
): string {
  const parts = [
    r.must_contain === "" ? "anything" : r.use_regex ? `/${r.must_contain}/` : r.must_contain,
  ];
  if (r.must_not_contain !== "") parts.push(`not: ${r.must_not_contain}`);
  if (r.episode_filter !== "") parts.push(`episodes ${r.episode_filter}`);
  if (r.smart_filter) parts.push("smart filter");
  if (r.ignore_days > 0) parts.push(`ignore ${r.ignore_days} d`);
  return parts.join("  ·  ");
}

/** The request that saves a rule as it is, switched on or off. */
export function ruleWith(r: Schemas["RssRule"], enabled: boolean): Schemas["RssRuleRequest"] {
  return {
    enabled,
    must_contain: r.must_contain,
    must_not_contain: r.must_not_contain,
    use_regex: r.use_regex,
    episode_filter: r.episode_filter,
    smart_filter: r.smart_filter,
    feeds: [...r.feeds],
    ignore_days: r.ignore_days,
    add_options: r.add_options,
    reset_history: false,
  };
}

// ---------------------------------------------------------------------------
// The page's settings

export interface RssDraft {
  rss_enabled: boolean;
  /** Minutes. */
  rss_refresh_interval: string;
  /** Seconds. */
  rss_fetch_delay: string;
  rss_max_articles: string;
  rss_auto_download: boolean;
  rss_download_repacks: boolean;
}

export type RssField = keyof RssDraft;

export function rssDraft(s: Settings): RssDraft {
  const minutes = s.rss_refresh_interval / 60;
  return {
    rss_enabled: s.rss_enabled,
    rss_refresh_interval: Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1),
    rss_fetch_delay: String(s.rss_fetch_delay),
    rss_max_articles: String(s.rss_max_articles),
    rss_auto_download: s.rss_auto_download,
    rss_download_repacks: s.rss_download_repacks,
  };
}

/** The interval typed, in seconds; `undefined` = not valid. */
export function intervalSeconds(text: string): number | undefined {
  const t = text.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  const s = Math.round(Number(t) * 60);
  return s >= 60 ? s : undefined;
}

export function rssDiff(saved: Settings, d: RssDraft): FormDiff<RssField> {
  const patch: Record<string, unknown> = {};
  const changed = new Set<RssField>();
  const names: string[] = [];
  const errors: Partial<Record<RssField, string>> = {};
  const note = (field: RssField, value: unknown) => {
    patch[field] = value;
    changed.add(field);
    names.push(field);
  };
  const fail = (field: RssField, problem: string) => {
    errors[field] = problem;
    changed.add(field);
  };
  if (d.rss_enabled !== saved.rss_enabled) note("rss_enabled", d.rss_enabled);
  const every = intervalSeconds(d.rss_refresh_interval);
  if (every === undefined) fail("rss_refresh_interval", "Minutes, at least 1.");
  else if (every !== saved.rss_refresh_interval) note("rss_refresh_interval", every);
  const delay = parseCount(d.rss_fetch_delay, false);
  if (delay === undefined || delay === null || delay > 3600) {
    fail("rss_fetch_delay", "Seconds, 0 to 3600.");
  } else if (delay !== saved.rss_fetch_delay) note("rss_fetch_delay", delay);
  const max = parseCount(d.rss_max_articles, false);
  if (max === undefined || max === null || max < 1 || max > 5000) {
    fail("rss_max_articles", "1 to 5000.");
  } else if (max !== saved.rss_max_articles) note("rss_max_articles", max);
  if (d.rss_auto_download !== saved.rss_auto_download) {
    note("rss_auto_download", d.rss_auto_download);
  }
  if (d.rss_download_repacks !== saved.rss_download_repacks) {
    note("rss_download_repacks", d.rss_download_repacks);
  }
  return { patch: patch as Schemas["SettingsPatch"], changed, names, errors };
}
