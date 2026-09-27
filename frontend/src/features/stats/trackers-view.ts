// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Trackers report: per host, the range's traffic and announces
// (`/stats/trackers`, by the tracker each torrent worked with) beside what
// stands now (`/torrents/trackers`: torrents on it, the ones failing).
// Hosts only, never URLs (AGENTS.md rule 6).

import type { Schemas } from "~/api/client";

import { bucketIndex } from "./range";

type TrackerRow = Schemas["TrackerRow"];
type TrackerPoint = Schemas["TrackerPoint"];
type TrackerHost = Schemas["TrackerHost"];
type TorrentSummary = Schemas["TorrentSummary"];

export type TrackerMetric = "uploaded" | "downloaded" | "announces";

export const METRICS = [
  { value: "uploaded", label: "By upload" },
  { value: "downloaded", label: "By download" },
  { value: "announces", label: "By announces" },
] as const satisfies readonly { value: TrackerMetric; label: string }[];

/** Hosts' colours in table order (CSS variables); the design's first four. */
const HOST_COLORS = ["--cat-1", "--cat-4", "--cat-3", "--cat-5", "--cat-2", "--cat-6"] as const;
/** Torrents with no working tracker. */
export const NONE_COLOR = "--subtle";
/** Hosts past the ones a chart names. */
export const OTHER_COLOR = "--faint";

export interface TrackerLine {
  /** `null`: no working tracker. */
  host: string | null;
  color: string;
  downloaded: number;
  uploaded: number;
  announces: number;
  errors: number;
  /** Torrents working with it that moved data in the range. */
  moved: number;
  /** As it stands now: torrents on the host (`null` row: running ones with no working tracker). */
  torrents: number;
  /** Of those, private. */
  private: number;
  /** Running torrents whose announces to it fail now. */
  failing: string[];
  /** How long it takes to answer an announce, seconds (its median now). */
  responseTime: number | null;
}

/** A host answering this slowly (seconds) or slower is called slow. */
export const SLOW_ANSWER = 2;

function metricOf(l: Pick<TrackerLine, TrackerMetric | "errors">, m: TrackerMetric): number {
  return m === "announces" ? l.announces + l.errors : l[m];
}

/**
 * One line per host: those with traffic or announces in the range first,
 * by the metric, then those with torrents but nothing in the range; the
 * torrents with no working tracker last.
 */
export function trackerLines(
  rows: readonly TrackerRow[],
  hosts: readonly TrackerHost[],
  metric: TrackerMetric,
  noTracker: { torrents: number; private: number },
): TrackerLine[] {
  const now = new Map(hosts.map((h) => [h.host, h]));
  const line = (r: TrackerRow | null, host: string | null): Omit<TrackerLine, "color"> => {
    const h = host === null ? undefined : now.get(host);
    return {
      host,
      downloaded: r?.downloaded ?? 0,
      uploaded: r?.uploaded ?? 0,
      announces: r?.announces ?? 0,
      errors: r?.announce_errors ?? 0,
      moved: r?.torrents ?? 0,
      torrents: host === null ? noTracker.torrents : (h?.torrents ?? 0),
      private: host === null ? noTracker.private : (h?.private ?? 0),
      failing: h?.failing ?? [],
      responseTime: h?.response_time ?? null,
    };
  };
  const ranged = rows
    .filter((r) => r.host !== null)
    .map((r) => line(r, r.host))
    .sort((a, b) => metricOf(b, metric) - metricOf(a, metric));
  const seen = new Set(ranged.map((l) => l.host));
  const idle = hosts
    .filter((h) => !seen.has(h.host))
    .map((h) => line(null, h.host))
    .sort((a, b) => b.torrents - a.torrents);
  const out: TrackerLine[] = [...ranged, ...idle].map((l, i) => ({
    ...l,
    color: HOST_COLORS[i % HOST_COLORS.length] ?? NONE_COLOR,
  }));
  const none = rows.find((r) => r.host === null);
  if (none || noTracker.torrents > 0) out.push({ ...line(none ?? null, null), color: NONE_COLOR });
  return out;
}

/** A host's success rate: answered of attempted; `null` without announces. */
export function success(l: Pick<TrackerLine, "announces" | "errors">): number | null {
  const all = l.announces + l.errors;
  return all > 0 ? l.announces / all : null;
}

export interface TrackerKpis {
  /** Hosts whose torrents moved data. */
  working: number;
  /** Torrents with no working tracker moved data too. */
  noneMoved: boolean;
  answered: number;
  failed: number;
  /** Failed of attempted; `null` without announces. */
  failedShare: number | null;
  /** Hosts with a failed announce. */
  failingHosts: number;
  /** The host with most of the metric's bytes (upload for announces), and its share. */
  top: { host: string | null; share: number; metric: "uploaded" | "downloaded" } | null;
}

export function trackerKpis(lines: readonly TrackerLine[], metric: TrackerMetric): TrackerKpis {
  const hosts = lines.filter((l) => l.host !== null);
  const bytes = metric === "downloaded" ? "downloaded" : "uploaded";
  const total = lines.reduce((n, l) => n + l[bytes], 0);
  let top: TrackerKpis["top"] = null;
  for (const l of lines) {
    if (l[bytes] > 0 && (top === null || l[bytes] / total > top.share)) {
      top = { host: l.host, share: l[bytes] / total, metric: bytes };
    }
  }
  const answered = hosts.reduce((n, l) => n + l.announces, 0);
  const failed = hosts.reduce((n, l) => n + l.errors, 0);
  const none = lines.find((l) => l.host === null);
  return {
    working: hosts.filter((l) => l.downloaded + l.uploaded > 0).length,
    noneMoved: none !== undefined && none.downloaded + none.uploaded > 0,
    answered,
    failed,
    failedShare: answered + failed > 0 ? failed / (answered + failed) : null,
    failingHosts: hosts.filter((l) => l.errors > 0).length,
    top,
  };
}

export interface AnnounceBar {
  t: number;
  ok: number;
  failed: number;
}

/** A host's announces per bar (the daemon's buckets grouped by `starts`; none recorded: 0). */
export function announceBars(
  points: readonly TrackerPoint[],
  host: string | null,
  starts: readonly number[],
): AnnounceBar[] {
  const bars = starts.map((t) => ({ t, ok: 0, failed: 0 }));
  for (const p of points) {
    const bar = p.host === host ? bars[bucketIndex(starts, p.t)] : undefined;
    if (!bar) continue;
    bar.ok += p.announces;
    bar.failed += p.announce_errors;
  }
  return bars;
}

export interface StackSeries {
  label: string;
  color: string;
  /** Per bucket; stacked by the chart. */
  values: number[];
}

/**
 * The metric per bucket, one series per host (the first `most` lines),
 * the rest summed as other trackers, and no working tracker on top.
 */
export function stackSeries(
  points: readonly TrackerPoint[],
  lines: readonly TrackerLine[],
  metric: TrackerMetric,
  starts: readonly number[],
  most = 6,
): StackSeries[] {
  const named = lines.filter((l) => l.host !== null).slice(0, most);
  const series = new Map<string | null, StackSeries>(
    named.map((l) => [
      l.host,
      { label: l.host ?? "", color: l.color, values: starts.map(() => 0) },
    ]),
  );
  const other: StackSeries = {
    label: "Other trackers",
    color: OTHER_COLOR,
    values: starts.map(() => 0),
  };
  const none: StackSeries = {
    label: "No working tracker",
    color: NONE_COLOR,
    values: starts.map(() => 0),
  };
  for (const p of points) {
    const i = bucketIndex(starts, p.t);
    if (i < 0) continue;
    const v = metric === "announces" ? p.announces + p.announce_errors : p[metric];
    const s = p.host === null ? none : (series.get(p.host) ?? other);
    s.values[i] = (s.values[i] ?? 0) + v;
  }
  const out = [...series.values()].filter((s) => s.values.some((v) => v > 0));
  if (other.values.some((v) => v > 0)) out.push(other);
  if (metric !== "announces" && none.values.some((v) => v > 0)) out.push(none);
  return out;
}

const RUNNING = new Set<TorrentSummary["state"]>(["metadata", "downloading", "seeding"]);

/** Running torrents that work with no tracker now, public and private. */
export function withoutTracker(rows: readonly TorrentSummary[]): {
  public: string[];
  private: string[];
} {
  const out = { public: [] as string[], private: [] as string[] };
  for (const r of rows) {
    if (RUNNING.has(r.state) && r.tracker === null) {
      (r.private ? out.private : out.public).push(r.hash);
    }
  }
  return out;
}

/** The announce interval trackers ask for: the middle host's; `null` before any reply. */
export function medianInterval(hosts: readonly TrackerHost[]): number | null {
  const all = hosts.flatMap((h) => (h.interval === null ? [] : [h.interval])).sort((a, b) => a - b);
  return all.length === 0 ? null : (all[Math.floor(all.length / 2)] ?? null);
}

/** Hosts failing now, most torrents first. */
export function failingHosts(hosts: readonly TrackerHost[]): TrackerHost[] {
  return hosts
    .filter((h) => h.failing.length > 0)
    .sort((a, b) => b.failing.length - a.failing.length || b.fails - a.fails);
}

/** A host's torrents now, as its line says it: `private · 4 torrents`. */
export function hostKind(l: Pick<TrackerLine, "torrents" | "private">): string {
  const n = `${l.torrents} ${l.torrents === 1 ? "torrent" : "torrents"}`;
  if (l.torrents === 0) return "no torrent now";
  if (l.private === l.torrents) return `private · ${n}`;
  if (l.private === 0) return `public · ${n}`;
  return `${l.private} private, ${l.torrents - l.private} public`;
}

/**
 * A tracker's error with any URL in it cut to its host: an HTTP error can
 * quote the announce URL, and with it a passkey (AGENTS.md rule 6).
 */
export function hideUrls(text: string): string {
  return text.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>)]+/gi, (url) => {
    try {
      const u = new URL(url);
      return u.host === "" ? url : `${u.host}/…`;
    } catch {
      return "(a URL)";
    }
  });
}

/** Trackers for new public torrents, from the settings and the fetched list, each once. */
export function defaultTrackers(
  addTrackers: readonly string[],
  fetched: readonly string[] | undefined,
): string[] {
  const out: string[] = [];
  for (const u of [...addTrackers, ...(fetched ?? [])]) {
    const url = u.trim();
    if (url !== "" && !out.includes(url)) out.push(url);
  }
  return out;
}
