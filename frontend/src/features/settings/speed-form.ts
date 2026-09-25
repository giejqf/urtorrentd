// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Speed page's form: the settings as the user edits them (text for the
// numbers, in kB/s where the API has bytes per second), what changed, and
// the `PATCH /settings` body that saves it. Pure and tested.

import type { Schemas } from "~/api/client";

import { minutes, type Weekday } from "./schedule";

type Settings = Schemas["Settings"];
type SettingsPatch = Schemas["SettingsPatch"];

export interface SpeedDraft {
  download_limit: string;
  upload_limit: string;
  alt_download_limit: string;
  alt_upload_limit: string;
  schedule: boolean;
  from: string;
  to: string;
  time_zone: string | null;
  days: Weekday[];
  max_connections: string;
  max_connections_per_torrent: string;
  max_uploads: string;
  max_uploads_per_torrent: string;
}

export type DraftField = keyof SpeedDraft;

const GROUP = new Intl.NumberFormat("en-US", { useGrouping: true, maximumFractionDigits: 2 });

/** Bytes per second as kB/s for an input: `12 000`; unlimited is empty. */
export function kbText(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || bytes === 0) return "";
  return GROUP.format(bytes / 1000).replace(/,/g, " ");
}

/** kB/s typed as bytes per second: empty or 0 is unlimited (`null`); `undefined` = not a number. */
export function parseKb(text: string): number | null | undefined {
  const t = text.replace(/\s/g, "");
  if (t === "" || t === "∞") return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return undefined;
  const n = Math.round(Number(t) * 1000);
  return n === 0 ? null : n;
}

/** A whole number; empty is `null` when allowed. `undefined` = not valid. */
export function parseCount(text: string, nullable: boolean): number | null | undefined {
  const t = text.replace(/\s/g, "");
  if (t === "") return nullable ? null : undefined;
  if (!/^\d+$/.test(t)) return undefined;
  return Number(t);
}

export function countText(n: number | null | undefined): string {
  return n === null || n === undefined ? "" : String(n);
}

/** The window a new schedule starts with. */
const DEFAULT_FROM = "01:00";
const DEFAULT_TO = "07:00";

export function draftOf(s: Settings): SpeedDraft {
  const sched = s.alt_speed_schedule ?? null;
  return {
    download_limit: kbText(s.download_limit),
    upload_limit: kbText(s.upload_limit),
    alt_download_limit: kbText(s.alt_download_limit),
    alt_upload_limit: kbText(s.alt_upload_limit),
    schedule: sched !== null,
    from: sched?.from ?? DEFAULT_FROM,
    to: sched?.to ?? DEFAULT_TO,
    time_zone: sched?.time_zone ?? null,
    days: [...(sched?.days ?? [])],
    max_connections: countText(s.max_connections),
    max_connections_per_torrent: countText(s.max_connections_per_torrent),
    max_uploads: countText(s.max_uploads),
    max_uploads_per_torrent: countText(s.max_uploads_per_torrent),
  };
}

export interface Diff {
  /** What to send (only what changed). */
  patch: SettingsPatch;
  /** The fields that differ from the saved settings. */
  changed: Set<DraftField>;
  /** Setting names that change, for the save bar (`alt_speed_schedule.days`). */
  names: string[];
  /** What is not valid, by field. */
  errors: Partial<Record<DraftField, string>>;
}

const sameDays = (a: readonly Weekday[], b: readonly Weekday[]) =>
  a.length === b.length && a.every((d) => b.includes(d));

export function diff(saved: Settings, d: SpeedDraft): Diff {
  const patch: SettingsPatch = {};
  const changed = new Set<DraftField>();
  const names: string[] = [];
  const errors: Partial<Record<DraftField, string>> = {};

  const limit = (
    field: "download_limit" | "upload_limit" | "alt_download_limit" | "alt_upload_limit",
  ) => {
    const v = parseKb(d[field]);
    if (v === undefined) {
      errors[field] = "A number of kB/s, or empty for unlimited.";
      changed.add(field);
    } else if (v !== (saved[field] ?? null)) {
      patch[field] = v;
      changed.add(field);
      names.push(field);
    }
  };
  limit("download_limit");
  limit("upload_limit");
  limit("alt_download_limit");
  limit("alt_upload_limit");

  const count = (
    field:
      "max_connections" | "max_connections_per_torrent" | "max_uploads" | "max_uploads_per_torrent",
    nullable: boolean,
  ) => {
    const v = parseCount(d[field], nullable);
    if (v === undefined) {
      errors[field] = nullable ? "A whole number, or empty." : "A whole number.";
      changed.add(field);
    } else if (v !== (saved[field] ?? null)) {
      (patch as Record<string, unknown>)[field] = v;
      changed.add(field);
      names.push(field);
    }
  };
  count("max_connections", false);
  count("max_connections_per_torrent", false);
  count("max_uploads", false);
  count("max_uploads_per_torrent", true);

  const s = saved.alt_speed_schedule ?? null;
  const sched: string[] = [];
  if (d.schedule !== (s !== null)) {
    changed.add("schedule");
    sched.push("alt_speed_schedule");
  }
  if (d.schedule) {
    const from = minutes(d.from);
    const to = minutes(d.to);
    if (from === null) errors.from = "HH:MM, 24-hour.";
    if (to === null) errors.to = "HH:MM, 24-hour.";
    if (from !== null && from === to)
      errors.to = "The window cannot start and end at the same time.";
    const fields: [DraftField, string, boolean][] = [
      ["from", "alt_speed_schedule.from", d.from !== s?.from],
      ["to", "alt_speed_schedule.to", d.to !== s?.to],
      ["time_zone", "alt_speed_schedule.time_zone", d.time_zone !== (s?.time_zone ?? null)],
      ["days", "alt_speed_schedule.days", !sameDays(d.days, s?.days ?? [])],
    ];
    for (const [field, name, differs] of fields) {
      if (s !== null && differs) {
        changed.add(field);
        sched.push(name);
      }
      if (errors[field]) changed.add(field);
    }
    if (sched.length > 0) {
      patch.alt_speed_schedule = { from: d.from, to: d.to, days: d.days, time_zone: d.time_zone };
    }
  } else if (s !== null) {
    patch.alt_speed_schedule = null;
  }
  names.push(...sched);
  return { patch, changed, names, errors };
}
