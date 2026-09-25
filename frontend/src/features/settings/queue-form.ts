// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Queue & share limits page's form: the settings as the user edits them
// (counts and a ratio as text, times as a number and a unit where the API
// has seconds), what changed, and the `PATCH /settings` body. Pure and
// tested.

import type { Schemas } from "~/api/client";

import type { FormDiff } from "./form";
import { countText, parseCount } from "./speed-form";

type Settings = Schemas["Settings"];
type SettingsPatch = Schemas["SettingsPatch"];

export type TimeUnit = "minutes" | "hours" | "days";

export const UNIT_SECONDS: Record<TimeUnit, number> = {
  minutes: 60,
  hours: 3600,
  days: 86_400,
};

export interface QueueDraft {
  queueing_enabled: boolean;
  max_active_downloads: string;
  max_active_uploads: string;
  max_active_torrents: string;
  count_slow_torrents: boolean;
  max_ratio: string;
  max_seeding_time: string;
  max_seeding_time_unit: TimeUnit;
  max_inactive_seeding_time: string;
  max_inactive_seeding_time_unit: TimeUnit;
  share_limit_action: Schemas["ShareLimitAction"];
}

export type DraftField = keyof QueueDraft;
export type Diff = FormDiff<DraftField>;

const DECIMALS = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2, useGrouping: false });

/** Seconds as a number of the largest unit that holds them whole (days by default). */
export function timeText(seconds: number | null): { text: string; unit: TimeUnit } {
  if (seconds === null) return { text: "", unit: "days" };
  const unit: TimeUnit =
    seconds % UNIT_SECONDS.days === 0
      ? "days"
      : seconds % UNIT_SECONDS.hours === 0
        ? "hours"
        : "minutes";
  return { text: DECIMALS.format(seconds / UNIT_SECONDS[unit]), unit };
}

/** A time typed in `unit` as seconds; empty is no limit (`null`); `undefined` = not valid. */
export function parseTime(text: string, unit: TimeUnit): number | null | undefined {
  const t = text.trim();
  if (t === "" || t === "∞") return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  return Math.round(Number(t) * UNIT_SECONDS[unit]);
}

/** A ratio as text: `5.0`, `1.25`. */
export function ratioText(ratio: number | null): string {
  if (ratio === null) return "";
  return Number.isInteger(ratio) ? ratio.toFixed(1) : DECIMALS.format(ratio);
}

/** A typed ratio; empty is no limit (`null`); `undefined` = not valid. */
export function parseRatio(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "" || t === "∞") return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  return Number(t);
}

export function draftOf(s: Settings): QueueDraft {
  const seeding = timeText(s.max_seeding_time);
  const inactive = timeText(s.max_inactive_seeding_time);
  return {
    queueing_enabled: s.queueing_enabled,
    max_active_downloads: countText(s.max_active_downloads),
    max_active_uploads: countText(s.max_active_uploads),
    max_active_torrents: countText(s.max_active_torrents),
    count_slow_torrents: s.count_slow_torrents,
    max_ratio: ratioText(s.max_ratio),
    max_seeding_time: seeding.text,
    max_seeding_time_unit: seeding.unit,
    max_inactive_seeding_time: inactive.text,
    max_inactive_seeding_time_unit: inactive.unit,
    share_limit_action: s.share_limit_action,
  };
}

export function diff(saved: Settings, d: QueueDraft): Diff {
  const patch: Record<string, unknown> = {};
  const changed = new Set<DraftField>();
  const names: string[] = [];
  const errors: Partial<Record<DraftField, string>> = {};
  const note = (field: DraftField, value: unknown) => {
    patch[field] = value;
    changed.add(field);
    names.push(field);
  };
  const fail = (field: DraftField, problem: string) => {
    errors[field] = problem;
    changed.add(field);
  };

  if (d.queueing_enabled !== saved.queueing_enabled) note("queueing_enabled", d.queueing_enabled);
  for (const f of ["max_active_downloads", "max_active_uploads", "max_active_torrents"] as const) {
    const v = parseCount(d[f], true);
    if (v === undefined) fail(f, "A whole number, or empty for unlimited.");
    else if (v !== saved[f]) note(f, v);
  }
  if (d.count_slow_torrents !== saved.count_slow_torrents) {
    note("count_slow_torrents", d.count_slow_torrents);
  }

  const ratio = parseRatio(d.max_ratio);
  if (ratio === undefined) fail("max_ratio", "A ratio such as 2 or 1.5, or empty for none.");
  else if (ratio !== saved.max_ratio) note("max_ratio", ratio);
  for (const f of ["max_seeding_time", "max_inactive_seeding_time"] as const) {
    const v = parseTime(d[f], d[`${f}_unit`]);
    if (v === undefined) fail(f, "A number, or empty for none.");
    else if (v !== saved[f]) note(f, v);
  }
  if (d.share_limit_action !== saved.share_limit_action) {
    note("share_limit_action", d.share_limit_action);
  }
  return { patch: patch as SettingsPatch, changed, names, errors };
}
