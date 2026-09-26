// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Engine page's form (the settings read once, at start), and what
// waits for a restart: each setting saved otherwise than the engine runs
// it (`GET /app` → `running`), and the patch that puts the running values
// back. Pure and tested.

import type { Schemas } from "~/api/client";

import type { FormDiff } from "./form";
import { countText, parseCount } from "./speed-form";

type Settings = Schemas["Settings"];
type SettingsPatch = Schemas["SettingsPatch"];
type Running = Schemas["RestartSettings"];

export const ENGINE_COUNTS = [
  "hash_threads",
  "max_checking",
  "max_open_files",
  "max_concurrent_announces",
] as const;
export const ENGINE_SWITCHES = ["disk_thread", "piece_extent_affinity", "zero_copy_send"] as const;

export type EngineCount = (typeof ENGINE_COUNTS)[number];
export type EngineSwitch = (typeof ENGINE_SWITCHES)[number];

export type EngineDraft = Record<EngineCount, string> & Record<EngineSwitch, boolean>;
export type EngineField = keyof EngineDraft;

export function engineDraft(s: Settings): EngineDraft {
  return {
    hash_threads: countText(s.hash_threads),
    max_checking: countText(s.max_checking),
    max_open_files: countText(s.max_open_files),
    max_concurrent_announces: countText(s.max_concurrent_announces),
    disk_thread: s.disk_thread,
    piece_extent_affinity: s.piece_extent_affinity,
    zero_copy_send: s.zero_copy_send,
  };
}

/** The largest count the daemon stores (a `u32`). */
const MAX_COUNT = 4_294_967_295;

export function engineDiff(saved: Settings, d: EngineDraft): FormDiff<EngineField> {
  const patch: Record<string, unknown> = {};
  const changed = new Set<EngineField>();
  const names: string[] = [];
  const errors: Partial<Record<EngineField, string>> = {};
  for (const f of ENGINE_COUNTS) {
    const v = parseCount(d[f], false);
    if (v === undefined || v === null || v < 1 || v > MAX_COUNT) {
      errors[f] = "A whole number, at least 1.";
      changed.add(f);
    } else if (v !== saved[f]) {
      patch[f] = v;
      changed.add(f);
      names.push(f);
    }
  }
  for (const f of ENGINE_SWITCHES) {
    if (d[f] !== saved[f]) {
      patch[f] = d[f];
      changed.add(f);
      names.push(f);
    }
  }
  return { patch: patch as SettingsPatch, changed, names, errors };
}

export interface Pending {
  setting: keyof Running;
  /** As the engine runs it. */
  running: string;
  /** As saved, for the next start. */
  saved: string;
}

function show(v: Running[keyof Running]): string {
  if (typeof v === "boolean") return v ? "on" : "off";
  if (v === null) return "the identity's";
  if (Array.isArray(v)) return v.length === 1 ? "1 router" : `${v.length} routers`;
  return String(v);
}

const same = (a: Running[keyof Running], b: Running[keyof Running]) =>
  JSON.stringify(a) === JSON.stringify(b);

/** What waits for a restart, in `restart_required`'s order. */
export function pendingChanges(
  saved: Settings,
  running: Running,
  required: readonly string[],
): Pending[] {
  const out: Pending[] = [];
  for (const name of required) {
    if (!(name in running)) continue;
    const setting = name as keyof Running;
    const now = running[setting];
    const next = saved[setting];
    if (same(now, next)) continue;
    out.push({ setting, running: show(now), saved: show(next) });
  }
  return out;
}

/** The patch that saves the running values back ("Revert to running"). */
export function revertPatch(pending: readonly Pending[], running: Running): SettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const p of pending) patch[p.setting] = running[p.setting];
  return patch as SettingsPatch;
}
