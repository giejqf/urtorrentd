// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Several torrents chosen at once: what they add up to, what they share and
// where they differ (a value they share is shown; a mixed one is not
// invented), for the panel that acts on all of them. Pure and tested.

import type { Schemas } from "~/api/client";
import { formatCount } from "~/lib/format";
import { stateLook } from "~/lib/torrent";

type Row = Schemas["TorrentSummary"];

export type ShareKind = "global" | "unlimited" | "own";

export interface Bulk {
  count: number;
  /** Wanted bytes. */
  size: number;
  /** Verified bytes. */
  onDisk: number;
  uploadRate: number;
  downloadRate: number;
  /** The mean of the ratios known; `null` when none is. */
  avgRatio: number | null;
  /** By shown state, most first: `[["Seeding", 2], ["Stopped", 1]]`. */
  states: [string, number][];
  /** Categories, `null` for none, each once in order of first use. */
  categories: (string | null)[];
  /** Each tag with how many of them carry it, by name. */
  tags: [string, number][];
  /** The category they share; `undefined` when they differ. */
  category: string | null | undefined;
  uploadLimit: number | null | undefined;
  autoManagement: boolean | undefined;
  /** How their share limits are set, when alike. */
  share: ShareKind | undefined;
}

function shared<T>(rows: readonly Row[], pick: (t: Row) => T): T | undefined {
  const first = rows[0];
  if (!first) return undefined;
  const v = pick(first);
  const key = JSON.stringify(v);
  return rows.every((t) => JSON.stringify(pick(t)) === key) ? v : undefined;
}

function shareKind(t: Row): ShareKind {
  const l = t.share_limits;
  const modes = [l.ratio.mode, l.seeding_time.mode, l.inactive_seeding_time.mode];
  if (modes.every((m) => m === "global") && l.action === null) return "global";
  if (modes.every((m) => m === "unlimited") && l.action === null) return "unlimited";
  return "own";
}

export function bulk(rows: readonly Row[]): Bulk {
  const ratios = rows.flatMap((t) => (t.ratio === null ? [] : [t.ratio]));
  const states = new Map<string, number>();
  const tags = new Map<string, number>();
  for (const t of rows) {
    const label = stateLook(t).label;
    states.set(label, (states.get(label) ?? 0) + 1);
    for (const tag of t.tags) tags.set(tag, (tags.get(tag) ?? 0) + 1);
  }
  const own = shared(rows, (t) => t.share_limits);
  const kind = shared(rows, shareKind);
  return {
    count: rows.length,
    size: rows.reduce((n, t) => n + t.size, 0),
    onDisk: rows.reduce((n, t) => n + t.completed, 0),
    uploadRate: rows.reduce((n, t) => n + t.upload_rate, 0),
    downloadRate: rows.reduce((n, t) => n + t.download_rate, 0),
    avgRatio: ratios.length > 0 ? ratios.reduce((a, b) => a + b, 0) / ratios.length : null,
    states: [...states].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])),
    categories: [...new Set(rows.map((t) => t.category))],
    tags: [...tags].sort((a, b) => a[0].localeCompare(b[0])),
    category: shared(rows, (t) => t.category),
    uploadLimit: shared(rows, (t) => t.upload_limit),
    autoManagement: shared(rows, (t) => t.auto_management),
    // Own limits count as alike only when they are the same limits.
    share: kind === "own" && own === undefined ? undefined : kind,
  };
}

/** "All seeding", or "2 seeding · 1 stopped". */
export function statesLine(states: readonly [string, number][]): string {
  if (states.length === 1) return `All ${(states[0]?.[0] ?? "").toLowerCase()}`;
  return states.map(([label, n]) => `${formatCount(n)} ${label.toLowerCase()}`).join(" · ");
}
