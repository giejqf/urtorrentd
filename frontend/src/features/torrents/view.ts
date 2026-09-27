// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The torrent list as the user sees it (AGENTS.md 4.3, 4.4): the sidebar's
// filters and their counts, sorting and grouping, all computed from the
// live store in single passes. Pure functions, tested without a DOM.

import type { Schemas } from "~/api/client";
import { dash, formatBytes, formatCount, formatEta, formatRatio } from "~/lib/format";
import { filterMatches, GROUPS, type Group, stateLook } from "~/lib/torrent";

type TorrentSummary = Schemas["TorrentSummary"];
type TorrentFilter = Schemas["TorrentFilter"];

/** A status filter: the daemon's filters, plus Queued (a state). */
export type StatusFilter = TorrentFilter | "queued";

/** The tracker filter's keys that are not hosts. */
export const NO_TRACKER = "~none";
export const TRACKER_DOWN = "~down";

export interface ListFilter {
  status: StatusFilter;
  /** A category; `""` for torrents without one; `null` for any. */
  category: string | null;
  tag: string | null;
  /** A tracker host, {@link NO_TRACKER} or {@link TRACKER_DOWN}; `null` for any. */
  tracker: string | null;
  /** The info-hashes the daemon's search matched; `null` without a search. */
  search: ReadonlySet<string> | null;
}

export const NO_FILTER: ListFilter = {
  status: "all",
  category: null,
  tag: null,
  tracker: null,
  search: null,
};

/**
 * The tracker entries a torrent is listed under: the host of each of its
 * trackers, {@link NO_TRACKER} without any, and {@link TRACKER_DOWN} too
 * while none of them works.
 */
export function trackerKeys(
  t: Pick<TorrentSummary, "tracker" | "trackers_count" | "tracker_hosts">,
): string[] {
  if (t.trackers_count === 0) return [NO_TRACKER];
  return t.tracker === null ? [...t.tracker_hosts, TRACKER_DOWN] : t.tracker_hosts;
}

function statusMatches(status: StatusFilter, t: TorrentSummary): boolean {
  return status === "queued" ? t.state === "queued" : filterMatches(status, t);
}

export function matches(t: TorrentSummary, f: ListFilter): boolean {
  if (!statusMatches(f.status, t)) return false;
  if (f.category !== null && (t.category ?? "") !== f.category) return false;
  if (f.tag !== null && !t.tags.includes(f.tag)) return false;
  if (f.tracker !== null && !trackerKeys(t).includes(f.tracker)) return false;
  if (f.search !== null && !f.search.has(t.hash)) return false;
  return true;
}

/**
 * The sidebar's status filters, in the design's order. The daemon's
 * `stalled` filter covers two different things, so the sidebar splits it:
 * Idle (`stalled_seeding`) and Stalled (`stalled_downloading`).
 */
export const STATUS_FILTERS: readonly StatusFilter[] = [
  "all",
  "downloading",
  "seeding",
  "completed",
  "active",
  "stalled_seeding",
  "stalled_downloading",
  "queued",
  "stopped",
  "checking",
  "moving",
  "errored",
];

export interface Counts {
  status: Record<StatusFilter, number>;
  /** By category name; `""` counts torrents without one. */
  categories: Map<string, number>;
  tags: Map<string, number>;
  /** By {@link trackerKeys}. */
  trackers: Map<string, number>;
}

const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);

/** Every sidebar count in one pass over the torrents. */
export function countAll(torrents: readonly TorrentSummary[]): Counts {
  const status = Object.fromEntries(STATUS_FILTERS.map((s) => [s, 0])) as Record<
    StatusFilter,
    number
  >;
  const categories = new Map<string, number>();
  const tags = new Map<string, number>();
  const trackers = new Map<string, number>();
  for (const t of torrents) {
    for (const s of STATUS_FILTERS) if (statusMatches(s, t)) status[s] += 1;
    bump(categories, t.category ?? "");
    for (const tag of t.tags) bump(tags, tag);
    for (const key of trackerKeys(t)) bump(trackers, key);
  }
  return { status, categories, tags, trackers };
}

export type SortKey =
  | "name"
  | "size"
  | "progress"
  | "download_rate"
  | "upload_rate"
  | "ratio"
  | "eta"
  | "added_on"
  | "queue_position";

/** The sort keys, each with the direction it starts in when picked. */
export const SORT_KEYS: readonly { key: SortKey; label: string; reverse: boolean }[] = [
  { key: "added_on", label: "Added", reverse: true },
  { key: "name", label: "Name", reverse: false },
  { key: "size", label: "Size", reverse: true },
  { key: "progress", label: "Progress", reverse: true },
  { key: "download_rate", label: "Download rate", reverse: true },
  { key: "upload_rate", label: "Upload rate", reverse: true },
  { key: "ratio", label: "Ratio", reverse: true },
  { key: "eta", label: "Time left", reverse: false },
  { key: "queue_position", label: "Queue position", reverse: false },
];

export interface Display {
  /** Group the list by state (the design's layout). */
  group: boolean;
  sort: SortKey;
  /** Descending. */
  reverse: boolean;
}

export const DEFAULT_DISPLAY: Display = { group: true, sort: "added_on", reverse: true };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** Compare by `key`; unknown values (`null`) sort last in both directions. */
function compare(a: TorrentSummary, b: TorrentSummary, key: SortKey, reverse: boolean): number {
  if (key === "name") {
    const c = collator.compare(a.name, b.name);
    return reverse ? -c : c;
  }
  const x = a[key];
  const y = b[key];
  if (x === null && y === null) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  return reverse ? y - x : x - y;
}

export function sortTorrents(
  torrents: readonly TorrentSummary[],
  display: Pick<Display, "sort" | "reverse">,
): TorrentSummary[] {
  return [...torrents].sort(
    (a, b) =>
      compare(a, b, display.sort, display.reverse) ||
      collator.compare(a.name, b.name) ||
      a.hash.localeCompare(b.hash),
  );
}

export type ListItem =
  | { kind: "group"; group: Group; count: number; down: number; up: number }
  | { kind: "torrent"; hash: string };

/**
 * The list's rows: torrents in order, under a header per state group (in
 * the design's order) when grouping. A header sums its torrents' reported
 * rates.
 */
export function listItems(sorted: readonly TorrentSummary[], group: boolean): ListItem[] {
  if (!group) return sorted.map((t) => ({ kind: "torrent", hash: t.hash }));
  const buckets = new Map<string, TorrentSummary[]>();
  for (const t of sorted) {
    const key = stateLook(t).group;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(t);
    else buckets.set(key, [t]);
  }
  const items: ListItem[] = [];
  for (const g of GROUPS) {
    const ts = buckets.get(g.key);
    if (!ts) continue;
    let down = 0;
    let up = 0;
    for (const t of ts) {
      down += t.download_rate;
      up += t.upload_rate;
    }
    items.push({ kind: "group", group: g, count: ts.length, down, up });
    for (const t of ts) items.push({ kind: "torrent", hash: t.hash });
  }
  return items;
}

/** The list's title: "All torrents", "Seeding · linux". */
export function viewTitle(
  f: Pick<ListFilter, "status" | "category" | "tag" | "tracker">,
  labels: Record<StatusFilter, string>,
  search = "",
): string {
  const parts = [f.status === "all" ? "All torrents" : labels[f.status]];
  if (f.category !== null) parts.push(f.category === "" ? "No category" : f.category);
  if (f.tag !== null) parts.push(`#${f.tag}`);
  if (f.tracker !== null) parts.push(trackerLabel(f.tracker));
  if (search !== "") parts.push(`“${search}”`);
  return parts.join(" · ");
}

export function trackerLabel(key: string): string {
  if (key === NO_TRACKER) return "No tracker";
  if (key === TRACKER_DOWN) return "Not working";
  return key;
}

/** "3.7 GB · ratio 0.31 · 3m 12s": what a phone's row says under the name. */
export function phoneMeta(
  t: Pick<
    Schemas["TorrentSummary"],
    "has_metadata" | "size" | "ratio" | "complete" | "eta" | "state" | "peers" | "error_kind"
  >,
  label: string,
): string {
  const parts = [t.has_metadata ? formatBytes(t.size) : dash];
  if (t.ratio !== null) parts.push(`ratio ${formatRatio(t.ratio)}`);
  if (t.state === "metadata") parts.push(`${formatCount(t.peers)} peers`);
  else if (t.state === "error" || t.state === "checking") parts.push(label.toLowerCase());
  else if (!t.complete && t.eta !== null) parts.push(formatEta(t.eta));
  return parts.join(" · ");
}
