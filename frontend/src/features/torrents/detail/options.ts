// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Options tab's model: a draft of one torrent's options as text and
// switches, what differs from the options it started from, and the calls
// that save it (name and comment, limits, share limits, behaviour, category,
// tags, location). Units as in the settings: kB/s, ratios, times in days,
// hours or minutes. Pure and tested.

import type { Schemas } from "~/api/client";
import {
  parseRatio,
  parseTime,
  ratioText,
  type TimeUnit,
  timeText,
} from "~/features/settings/queue-form";
import { countText, kbText, parseCount, parseKb } from "~/features/settings/speed-form";

type Row = Schemas["TorrentSummary"];
type Action = Schemas["ShareLimitAction"];
export type Mode = "global" | "unlimited" | "limit";
export type ActionChoice = "global" | Action;

export interface OptionsDraft {
  name: string;
  comment: string;
  download_limit: string;
  upload_limit: string;
  max_connections: string;
  max_uploads: string;
  ratio_mode: Mode;
  ratio: string;
  seeding_mode: Mode;
  seeding: string;
  seeding_unit: TimeUnit;
  inactive_mode: Mode;
  inactive: string;
  inactive_unit: TimeUnit;
  action: ActionChoice;
  sequential: boolean;
  first_last: boolean;
  auto_management: boolean;
  forced: boolean;
  /** `""`: none. */
  category: string;
  tags: string[];
  save_path: string;
  /** `""`: none. */
  download_path: string;
}

/** A row of the tab, as the footer names what changed. */
export type OptionsRow =
  | "name"
  | "comment"
  | "download_limit"
  | "upload_limit"
  | "max_connections"
  | "max_uploads"
  | "ratio"
  | "seeding"
  | "inactive"
  | "action"
  | "sequential"
  | "first_last"
  | "auto_management"
  | "forced"
  | "category"
  | "tags"
  | "save_path"
  | "download_path";

export const ROW_NAMES: Record<OptionsRow, string> = {
  name: "Display name",
  comment: "Comment",
  download_limit: "Download limit",
  upload_limit: "Upload limit",
  max_connections: "Peer connections",
  max_uploads: "Upload slots",
  ratio: "Ratio",
  seeding: "Seeding time",
  inactive: "Inactive seeding",
  action: "When reached",
  sequential: "Sequential download",
  first_last: "First and last pieces first",
  auto_management: "Automatic management",
  forced: "Force start",
  category: "Category",
  tags: "Tags",
  save_path: "Save path",
  download_path: "Download path",
};

const ORDER = Object.keys(ROW_NAMES) as OptionsRow[];

function timeDraft(l: Schemas["TimeLimit"]): { mode: Mode; text: string; unit: TimeUnit } {
  if (l.mode !== "limit") return { mode: l.mode, text: "", unit: "days" };
  const t = timeText(l.value);
  return { mode: "limit", text: t.text, unit: t.unit };
}

/** The draft a torrent's options give. */
export function optionsDraft(t: Row): OptionsDraft {
  const seeding = timeDraft(t.share_limits.seeding_time);
  const inactive = timeDraft(t.share_limits.inactive_seeding_time);
  const r = t.share_limits.ratio;
  return {
    name: t.name,
    comment: t.comment ?? "",
    download_limit: kbText(t.download_limit),
    upload_limit: kbText(t.upload_limit),
    max_connections: countText(t.max_connections),
    max_uploads: countText(t.max_uploads),
    ratio_mode: r.mode,
    ratio: r.mode === "limit" ? ratioText(r.value) : "",
    seeding_mode: seeding.mode,
    seeding: seeding.text,
    seeding_unit: seeding.unit,
    inactive_mode: inactive.mode,
    inactive: inactive.text,
    inactive_unit: inactive.unit,
    action: t.share_limits.action ?? "global",
    sequential: t.sequential,
    first_last: t.first_last_piece_priority,
    auto_management: t.auto_management,
    forced: t.forced,
    category: t.category ?? "",
    tags: [...t.tags],
    save_path: t.save_path,
    download_path: t.download_path ?? "",
  };
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The draft once the options it started from became `next`: fields left as
 * they were follow, fields edited stay.
 */
export function mergeDraft(
  draft: OptionsDraft,
  base: OptionsDraft,
  next: OptionsDraft,
): OptionsDraft {
  const out = { ...draft };
  for (const k of Object.keys(next) as (keyof OptionsDraft)[]) {
    if (same(draft[k], base[k])) (out as Record<string, unknown>)[k] = next[k];
  }
  return out;
}

export interface OptionsChange {
  changed: Set<OptionsRow>;
  /** What changed, in the tab's order, for the footer. */
  names: string[];
  errors: Partial<Record<OptionsRow, string>>;
  patch: Schemas["TorrentPatch"] | null;
  limits: Omit<Schemas["LimitsRequest"], "hashes"> | null;
  shareLimits: Schemas["ShareLimits"] | null;
  sequential: boolean | null;
  firstLast: boolean | null;
  forced: boolean | null;
  autoManagement: boolean | null;
  category: { value: string | null } | null;
  tagsAdd: string[];
  tagsRemove: string[];
  location: string | null;
  downloadPath: { value: string | null } | null;
}

function ratioLimit(mode: Mode, text: string): Schemas["RatioLimit"] | undefined {
  if (mode !== "limit") return { mode };
  const v = parseRatio(text);
  return v === null || v === undefined ? undefined : { mode, value: v };
}

function timeLimit(mode: Mode, text: string, unit: TimeUnit): Schemas["TimeLimit"] | undefined {
  if (mode !== "limit") return { mode };
  const v = parseTime(text, unit);
  return v === null || v === undefined ? undefined : { mode, value: v };
}

const isAbsolute = (p: string) => p.startsWith("/");

/** What the draft changes against `base`, and the calls that save it. */
export function optionsDiff(base: OptionsDraft, d: OptionsDraft): OptionsChange {
  const changed = new Set<OptionsRow>();
  const errors: OptionsChange["errors"] = {};
  const out: OptionsChange = {
    changed,
    names: [],
    errors,
    patch: null,
    limits: null,
    shareLimits: null,
    sequential: null,
    firstLast: null,
    forced: null,
    autoManagement: null,
    category: null,
    tagsAdd: [],
    tagsRemove: [],
    location: null,
    downloadPath: null,
  };

  // Name and comment: an empty name gives the torrent back its own.
  const patch: Schemas["TorrentPatch"] = {};
  const name = d.name.trim();
  if (name !== base.name.trim()) {
    changed.add("name");
    patch.name = name === "" ? null : name;
  }
  if (d.comment.trim() !== base.comment.trim()) {
    changed.add("comment");
    patch.comment = d.comment.trim();
  }
  if (Object.keys(patch).length > 0) out.patch = patch;

  // Limits: text left as it was is not re-read (kB/s rounds).
  const limits: Omit<Schemas["LimitsRequest"], "hashes"> = {};
  for (const f of ["download_limit", "upload_limit"] as const) {
    if (d[f] === base[f]) continue;
    const v = parseKb(d[f]);
    if (v === undefined) errors[f] = "A number of kB/s, or empty for none.";
    else if (v !== parseKb(base[f])) {
      changed.add(f);
      limits[f] = v;
    }
  }
  for (const f of ["max_connections", "max_uploads"] as const) {
    if (d[f] === base[f]) continue;
    const v = parseCount(d[f], true);
    if (v === undefined || v === 0) errors[f] = "A whole number, or empty for the global one.";
    else if (v !== parseCount(base[f], true)) {
      changed.add(f);
      limits[f] = v;
    }
  }
  if (Object.keys(limits).length > 0) out.limits = limits;

  // Share limits: sent whole when any part changed.
  const ratio = ratioLimit(d.ratio_mode, d.ratio);
  const seeding = timeLimit(d.seeding_mode, d.seeding, d.seeding_unit);
  const inactive = timeLimit(d.inactive_mode, d.inactive, d.inactive_unit);
  const was = {
    ratio: ratioLimit(base.ratio_mode, base.ratio),
    seeding: timeLimit(base.seeding_mode, base.seeding, base.seeding_unit),
    inactive: timeLimit(base.inactive_mode, base.inactive, base.inactive_unit),
  };
  if (ratio === undefined) errors.ratio = "A ratio such as 2 or 1.5.";
  else if (!same(ratio, was.ratio)) changed.add("ratio");
  if (seeding === undefined) errors.seeding = "A time such as 14 days.";
  else if (!same(seeding, was.seeding)) changed.add("seeding");
  if (inactive === undefined) errors.inactive = "A time such as 2 days.";
  else if (!same(inactive, was.inactive)) changed.add("inactive");
  if (d.action !== base.action) changed.add("action");
  if (
    ratio &&
    seeding &&
    inactive &&
    (["ratio", "seeding", "inactive", "action"] as const).some((r) => changed.has(r))
  ) {
    out.shareLimits = {
      ratio,
      seeding_time: seeding,
      inactive_seeding_time: inactive,
      action: d.action === "global" ? null : d.action,
    };
  }

  // Behaviour.
  if (d.sequential !== base.sequential) {
    changed.add("sequential");
    out.sequential = d.sequential;
  }
  if (d.first_last !== base.first_last) {
    changed.add("first_last");
    out.firstLast = d.first_last;
  }
  if (d.forced !== base.forced) {
    changed.add("forced");
    out.forced = d.forced;
  }
  if (d.auto_management !== base.auto_management) {
    changed.add("auto_management");
    out.autoManagement = d.auto_management;
  }

  // Location.
  if (d.category !== base.category) {
    changed.add("category");
    out.category = { value: d.category === "" ? null : d.category };
  }
  out.tagsAdd = d.tags.filter((t) => !base.tags.includes(t));
  out.tagsRemove = base.tags.filter((t) => !d.tags.includes(t));
  if (out.tagsAdd.length > 0 || out.tagsRemove.length > 0) changed.add("tags");
  // The save path follows the category while automatic management is on.
  const path = d.save_path.trim();
  if (!d.auto_management && path !== base.save_path.trim()) {
    if (!isAbsolute(path)) errors.save_path = "An absolute path.";
    else {
      changed.add("save_path");
      out.location = path;
    }
  }
  const dl = d.download_path.trim();
  if (dl !== base.download_path.trim()) {
    if (dl !== "" && !isAbsolute(dl)) errors.download_path = "An absolute path, or empty for none.";
    else {
      changed.add("download_path");
      out.downloadPath = { value: dl === "" ? null : dl };
    }
  }

  out.names = ORDER.filter((r) => changed.has(r)).map((r) => ROW_NAMES[r]);
  return out;
}
