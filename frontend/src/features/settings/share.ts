// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Share limits as the daemon applies them (daemon/tick.rs): a torrent's own
// limits, where they say `global` its category's, where those say `global`
// the settings; and how far a seeding torrent is from each, with when it
// gets there if things go on as they are. Pure and tested.

import type { Schemas } from "~/api/client";

type ShareLimits = Schemas["ShareLimits"];
type Action = Schemas["ShareLimitAction"];

/** The settings' limits (the page's draft). */
export interface GlobalLimits {
  ratio: number | null;
  seeding: number | null;
  inactive: number | null;
  action: Action;
}

/** The limits in force for one torrent, and where they come from. */
export interface Effective {
  ratio: number | null;
  seeding: number | null;
  inactive: number | null;
  action: Action;
  /** Some limit is the torrent's own. */
  own: boolean;
  /** Some limit is its category's. */
  category: boolean;
}

type Limit = ShareLimits["ratio"] | ShareLimits["seeding_time"];

export function effectiveLimits(
  own: ShareLimits,
  category: ShareLimits | undefined,
  g: GlobalLimits,
): Effective {
  let fromOwn = own.action !== null;
  let fromCategory = false;
  const pick = (mine: Limit, theirs: Limit | undefined, global: number | null): number | null => {
    let l = mine;
    if (l.mode === "global") {
      if (theirs && theirs.mode !== "global") {
        fromCategory = true;
        l = theirs;
      }
    } else fromOwn = true;
    if (l.mode === "limit") return l.value;
    return l.mode === "unlimited" ? null : global;
  };
  const ratio = pick(own.ratio, category?.ratio, g.ratio);
  const seeding = pick(own.seeding_time, category?.seeding_time, g.seeding);
  const inactive = pick(own.inactive_seeding_time, category?.inactive_seeding_time, g.inactive);
  const categoryAction = own.action === null ? (category?.action ?? null) : null;
  if (categoryAction !== null) fromCategory = true;
  return {
    ratio,
    seeding,
    inactive,
    action: own.action ?? categoryAction ?? g.action,
    own: fromOwn,
    category: fromCategory,
  };
}

type Row = Pick<
  Schemas["TorrentSummary"],
  | "ratio"
  | "uploaded"
  | "downloaded"
  | "completed"
  | "upload_rate"
  | "download_rate"
  | "seeding_time"
  | "last_activity"
  | "completed_on"
  | "added_on"
>;

export type LimitKind = "ratio" | "seeding time" | "inactive time";

export interface Outlook {
  /** How far along the ratio limit, 0..=1; `null` without one. */
  ratioShare: number | null;
  /** How far along the seeding time limit, 0..=1; `null` without one. */
  seedingShare: number | null;
  /** A limit already reached (the daemon acts within a second). */
  reached: LimitKind | null;
  /** The limit reached first if things go on as they are, and in how many seconds. */
  next: { kind: LimitKind; in: number } | null;
  /** Some limit applies. */
  limited: boolean;
}

const share = (value: number, limit: number) => (limit <= 0 ? 1 : Math.min(1, value / limit));

export function outlook(t: Row, l: Effective, now: number): Outlook {
  const soon: { kind: LimitKind; in: number }[] = [];
  let reached: LimitKind | null = null;

  if (l.ratio !== null) {
    if (t.ratio !== null && t.ratio >= l.ratio) reached ??= "ratio";
    else if (t.upload_rate > 0) {
      // The daemon's ratio base (daemon/view.rs `ratio`).
      const base = t.downloaded < t.completed / 100 ? t.completed : t.downloaded;
      if (base > 0) {
        soon.push({
          kind: "ratio",
          in: Math.max(0, (l.ratio * base - t.uploaded) / t.upload_rate),
        });
      }
    }
  }
  if (l.seeding !== null) {
    if (t.seeding_time >= l.seeding) reached ??= "seeding time";
    else soon.push({ kind: "seeding time", in: l.seeding - t.seeding_time });
  }
  if (l.inactive !== null) {
    const since = t.last_activity ?? t.completed_on ?? t.added_on;
    const idle = Math.max(0, now - since);
    if (idle >= l.inactive) reached ??= "inactive time";
    else if (t.upload_rate === 0 && t.download_rate === 0) {
      soon.push({ kind: "inactive time", in: l.inactive - idle });
    }
  }
  soon.sort((a, b) => a.in - b.in);
  return {
    ratioShare: l.ratio === null ? null : t.ratio === null ? 0 : share(t.ratio, l.ratio),
    seedingShare: l.seeding === null ? null : share(t.seeding_time, l.seeding),
    reached,
    next: soon[0] ?? null,
    limited: l.ratio !== null || l.seeding !== null || l.inactive !== null,
  };
}

/** Closest first: reached, then by when, then limited without a when, then unlimited. */
export function closeness(o: Outlook): number {
  if (o.reached) return -1;
  if (o.next) return o.next.in;
  return o.limited ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER;
}
