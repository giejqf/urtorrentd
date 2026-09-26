// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Timeline report: what happened to torrents (`/stats/timeline`), as a
// feed by day and as one lane per torrent. A lane's colour between events is
// what the events establish: a state change its state, finishing seeding,
// the metadata downloading; after the last event, the torrent's state now.
// What no event establishes is drawn as unknown, never guessed.

import type { Schemas } from "~/api/client";
import { dash, formatDayHeading, formatDuration, localDay, type TimeOptions } from "~/lib/format";
import { stateLook } from "~/lib/torrent";

type Ev = Schemas["TimelineEvent"];
type Kind = Schemas["TimelineKind"];
type TorrentState = Schemas["TorrentState"];

export const KINDS = [
  {
    kind: "added",
    label: "Added",
    glyph: "+",
    tone: "bg-muted-foreground",
    fill: "fill-muted-foreground",
  },
  { kind: "metadata", label: "Metadata", glyph: "…", tone: "bg-warn", fill: "fill-warn" },
  { kind: "finished", label: "Finished", glyph: "✓", tone: "bg-ok", fill: "fill-ok" },
  { kind: "moved", label: "Moved", glyph: "→", tone: "bg-cat-2", fill: "fill-cat-2" },
  { kind: "state", label: "State", glyph: "◦", tone: "bg-subtle", fill: "fill-subtle" },
  { kind: "error", label: "Error", glyph: "×", tone: "bg-danger", fill: "fill-danger" },
  { kind: "removed", label: "Removed", glyph: "−", tone: "bg-faint", fill: "fill-faint" },
] as const satisfies readonly {
  kind: Kind;
  label: string;
  glyph: string;
  tone: string;
  fill: string;
}[];

export const KIND_OF = Object.fromEntries(KINDS.map((k) => [k.kind, k])) as Record<
  Kind,
  (typeof KINDS)[number]
>;

/** Hidden kinds from the URL (`?hide=state,moved`). */
export function hiddenKinds(param: string | undefined): Set<Kind> {
  const known = new Set<string>(KINDS.map((k) => k.kind));
  return new Set((param ?? "").split(",").filter((k): k is Kind => known.has(k)));
}

export function kindCounts(events: readonly Ev[]): Record<Kind, number> {
  const out = Object.fromEntries(KINDS.map((k) => [k.kind, 0])) as Record<Kind, number>;
  for (const e of events) out[e.kind] += 1;
  return out;
}

export function stateLabel(s: TorrentState): string {
  return stateLook({ state: s, stalled: false }).label;
}

export type LaneState = "downloading" | "seeding" | "metadata" | "stopped" | "error" | "unknown";

export function laneState(s: TorrentState): LaneState {
  switch (s) {
    case "downloading":
      return "downloading";
    case "seeding":
      return "seeding";
    case "metadata":
      return "metadata";
    case "error":
      return "error";
    case "unknown":
      return "unknown";
    default:
      return "stopped";
  }
}

export interface Segment {
  from: number;
  to: number;
  state: LaneState;
}

export interface Lane {
  hash: string;
  name: string;
  segments: Segment[];
  marks: { t: number; kind: Kind }[];
  /** It existed before the range, or before anything was recorded of it. */
  before: boolean;
  /** When it was removed (its lane ends). */
  removed: number | null;
}

/** Events by torrent, oldest first. */
function byTorrent(events: readonly Ev[]): Map<string, Ev[]> {
  const out = new Map<string, Ev[]>();
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const list = out.get(e.hash) ?? [];
    list.push(e);
    out.set(e.hash, list);
  }
  return out;
}

/** The state an event leaves a torrent in; `undefined`: the one before goes on. */
function established(e: Ev, later: readonly Ev[]): LaneState | null | undefined {
  switch (e.kind) {
    case "state":
      return e.state ? laneState(e.state) : undefined;
    case "finished":
      return "seeding";
    case "metadata":
      return "downloading";
    case "added": {
      const next = later.find((x) => x.kind !== "moved" && x.kind !== "error");
      if (next?.kind === "metadata") return "metadata";
      if (next?.kind === "finished") return "downloading";
      return null;
    }
    default:
      return undefined;
  }
}

/**
 * One lane per torrent with an event in the range, the most recently
 * active first. `now(hash)` is its state now, `null` when it is not in the
 * session; it colours the time after its last event.
 */
export function lanes(
  events: readonly Ev[],
  from: number,
  to: number,
  current: (hash: string) => TorrentState | null,
  most = 40,
): Lane[] {
  const out: (Lane & { last: number })[] = [];
  for (const [hash, list] of byTorrent(events)) {
    const inRange = list.filter((e) => e.t >= from && e.t <= to);
    if (inRange.length === 0) continue;
    const first = list[0];
    const removed = list.find((e) => e.kind === "removed")?.t ?? null;
    const segments: Segment[] = [];
    let state: LaneState | null = null;
    list.forEach((e, i) => {
      const next = list[i + 1];
      const s = established(e, list.slice(i + 1));
      if (s !== undefined) state = s;
      if (e.kind === "removed") return;
      const now = current(hash);
      const end = next ? next.t : (removed ?? to);
      const shown: LaneState = next
        ? (state ?? "unknown")
        : now
          ? laneState(now)
          : (state ?? "unknown");
      const a = Math.max(e.t, from);
      const b = Math.min(end, to);
      if (b > a) segments.push({ from: a, to: b, state: shown });
    });
    // Merge neighbours of one state.
    const merged: Segment[] = [];
    for (const s of segments) {
      const last = merged[merged.length - 1];
      if (last && last.state === s.state && last.to >= s.from) last.to = s.to;
      else merged.push({ ...s });
    }
    out.push({
      hash,
      name: [...list].reverse().find((e) => e.name)?.name ?? hash.slice(0, 12),
      segments: merged,
      marks: inRange.map((e) => ({ t: e.t, kind: e.kind })),
      before: first?.kind !== "added" || (first?.t ?? 0) < from,
      removed,
      last: inRange[inRange.length - 1]?.t ?? 0,
    });
  }
  return out
    .sort((a, b) => b.last - a.last)
    .slice(0, most)
    .map(({ last: _, ...l }) => l);
}

export interface Described {
  verb: string;
  object: string;
  detail: string;
}

/** An event in words. `previous`: the state before (a state change); `added`: when it was added (finishing). */
export function describe(e: Ev, previous: TorrentState | null, added: number | null): Described {
  switch (e.kind) {
    case "added":
      return { verb: "was added", object: "", detail: "" };
    case "metadata":
      return { verb: "got its metadata", object: "", detail: "" };
    case "finished":
      return {
        verb: "finished downloading",
        object: "",
        detail:
          added !== null && e.t >= added ? `in ${formatDuration(e.t - added)} from adding` : "",
      };
    case "moved":
      return { verb: "was moved to", object: e.detail ?? dash, detail: "" };
    case "state": {
      const to = e.state ? stateLabel(e.state) : dash;
      return {
        verb: "changed state",
        object: previous ? `${stateLabel(previous)} → ${to}` : `→ ${to}`,
        detail: "",
      };
    }
    case "error":
      return { verb: "hit an error", object: "", detail: e.detail ?? "" };
    case "removed":
      return { verb: "was removed", object: "", detail: "" };
  }
}

/**
 * For each event: the state before it (the torrent's last recorded state
 * change; finishing is followed by one of its own) and when it was added.
 */
export function contexts(
  events: readonly Ev[],
): Map<Ev, { previous: TorrentState | null; added: number | null }> {
  const out = new Map<Ev, { previous: TorrentState | null; added: number | null }>();
  for (const list of byTorrent(events).values()) {
    let previous: TorrentState | null = null;
    let added: number | null = null;
    for (const e of list) {
      out.set(e, { previous, added });
      if (e.kind === "added") added = e.t;
      if (e.kind === "state" && e.state) previous = e.state;
    }
  }
  return out;
}

export type FeedRow =
  | { kind: "day"; key: string; label: string; count: number }
  | { kind: "event"; key: string; event: Ev };

/** Events newest first, under a heading per day of the viewer. */
export function feedRows(events: readonly Ev[], now: number, opts: TimeOptions = {}): FeedRow[] {
  const sorted = [...events].sort((a, b) => b.t - a.t);
  const out: FeedRow[] = [];
  let day = "";
  let heading: Extract<FeedRow, { kind: "day" }> | null = null;
  sorted.forEach((e, i) => {
    const d = localDay(e.t, opts);
    if (d !== day || heading === null) {
      day = d;
      heading = { kind: "day", key: `day-${d}`, label: formatDayHeading(e.t, now, opts), count: 0 };
      out.push(heading);
    }
    heading.count += 1;
    out.push({ kind: "event", key: `${e.t}-${e.hash}-${e.kind}-${i}`, event: e });
  });
  return out;
}

/** The middle time from adding to finishing, over the downloads that finished in the range. */
export function medianDownload(events: readonly Ev[], from: number, to: number): number | null {
  const times: number[] = [];
  for (const list of byTorrent(events).values()) {
    let added: number | null = null;
    for (const e of list) {
      if (e.kind === "added") added = e.t;
      if (e.kind === "finished" && added !== null && e.t >= from && e.t <= to) {
        times.push(e.t - added);
        added = null;
      }
    }
  }
  if (times.length === 0) return null;
  times.sort((a, b) => a - b);
  const mid = Math.floor(times.length / 2);
  return times.length % 2 ? (times[mid] ?? 0) : ((times[mid - 1] ?? 0) + (times[mid] ?? 0)) / 2;
}

/** Torrents to look at now: in error, or waiting for metadata over an hour. */
export function attention(
  rows: readonly Schemas["TorrentSummary"][],
  now: number,
): { errors: Schemas["TorrentSummary"][]; waiting: Schemas["TorrentSummary"][] } {
  return {
    errors: rows.filter((r) => r.state === "error"),
    waiting: rows.filter((r) => r.state === "metadata" && now - r.added_on > 3600),
  };
}

const csvCell = (v: string | number | null): string => {
  if (v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Events as CSV, newest first, times in UTC. */
export function timelineCsv(events: readonly Ev[]): string {
  const lines = [...events]
    .sort((a, b) => b.t - a.t)
    .map((e) =>
      [new Date(e.t * 1000).toISOString(), e.kind, e.hash, e.name, e.state, e.detail]
        .map(csvCell)
        .join(","),
    );
  return ["time_utc,kind,hash,name,state,detail", ...lines].join("\n") + "\n";
}
