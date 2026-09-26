// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Watch folders page's form: the `watch_folders` setting as the user
// edits it (the fields the page shows; a folder's other add options, set
// through the API or the add dialog, are kept as they are), what changed,
// and the `PATCH /settings` body. Pure and tested.

import type { Schemas } from "~/api/client";

import type { FormDiff } from "./form";

type Settings = Schemas["Settings"];
type WatchFolder = Schemas["WatchFolder"];

/** Folders at most (the daemon's limit). */
export const MAX_FOLDERS = 32;

export interface FolderDraft {
  /** Stable across edits, for the page (not saved). */
  key: string;
  path: string;
  recursive: boolean;
  after_add: Schemas["AfterAdd"];
  category: string | null;
  tags: string[];
  /** `null` = the `add_stopped` setting. */
  stopped: boolean | null;
  /** Empty = the category's (or the default) save path. */
  save_path: string;
  /** Every other add option, as saved. */
  options: Schemas["AddOptions"];
}

export interface WatchDraft {
  folders: FolderDraft[];
}

export type WatchField = "folders";

let keys = 0;
export function folderKey(): string {
  keys += 1;
  return `f${keys}`;
}

export function folderDraft(w: WatchFolder): FolderDraft {
  const o = w.options ?? {};
  return {
    key: folderKey(),
    path: w.path,
    recursive: w.recursive ?? false,
    after_add: w.after_add ?? "rename",
    category: o.category ?? null,
    tags: [...(o.tags ?? [])],
    stopped: o.stopped ?? null,
    save_path: o.save_path ?? "",
    options: o,
  };
}

export function emptyFolder(): FolderDraft {
  return {
    key: folderKey(),
    path: "",
    recursive: false,
    after_add: "rename",
    category: null,
    tags: [],
    stopped: null,
    save_path: "",
    options: {},
  };
}

/** The draft of saved settings; folders keep their keys from `prev` (by path). */
export function watchDraft(s: Settings, prev?: WatchDraft): WatchDraft {
  return {
    folders: s.watch_folders.map((w) => {
      const f = folderDraft(w);
      const old = prev?.folders.find((p) => p.path.trim() === w.path);
      return old ? { ...f, key: old.key } : f;
    }),
  };
}

/** The setting a folder draft saves as. */
export function folderSetting(f: FolderDraft): WatchFolder {
  const options: Schemas["AddOptions"] = { ...f.options };
  const set = <K extends keyof Schemas["AddOptions"]>(k: K, v: Schemas["AddOptions"][K] | null) => {
    if (v === null || v === undefined) delete options[k];
    else options[k] = v;
  };
  set("category", f.category);
  set("tags", f.tags.length > 0 ? f.tags : null);
  set("stopped", f.stopped);
  set("save_path", f.save_path.trim() === "" ? null : f.save_path.trim());
  return { path: f.path.trim(), recursive: f.recursive, after_add: f.after_add, options };
}

/** Why a folder's paths are not ones the daemon takes. */
export function folderProblem(f: FolderDraft, all: readonly FolderDraft[]): string | null {
  const path = f.path.trim();
  if (path === "") return "The folder is needed.";
  if (!path.startsWith("/")) return "An absolute path, starting with /.";
  if (all.some((o) => o !== f && o.path.trim() === path)) return "This folder is listed twice.";
  const save = f.save_path.trim();
  if (save !== "" && !save.startsWith("/")) return "The save path is an absolute path.";
  return null;
}

/** The same setting, whatever the key order and default fields. */
function same(a: WatchFolder, b: WatchFolder): boolean {
  const norm = (w: WatchFolder) =>
    JSON.stringify({
      path: w.path,
      recursive: w.recursive ?? false,
      after_add: w.after_add ?? "rename",
      options: Object.fromEntries(
        Object.entries(w.options ?? {})
          .filter(([, v]) => v !== null && v !== undefined && !(Array.isArray(v) && v.length === 0))
          .sort(([x], [y]) => x.localeCompare(y)),
      ),
    });
  return norm(a) === norm(b);
}

export function watchDiff(saved: Settings, d: WatchDraft): FormDiff<WatchField> {
  const now = d.folders.map(folderSetting);
  const was = saved.watch_folders;
  const names: string[] = [];
  now.forEach((w, i) => {
    const old = was.find((o) => o.path === w.path);
    if (!old) names.push(`watch_folders: + ${w.path || "(new folder)"}`);
    else if (!same(old, w) || was.indexOf(old) !== i) names.push(`watch_folders: ${w.path}`);
  });
  for (const o of was) {
    if (!now.some((w) => w.path === o.path)) names.push(`watch_folders: − ${o.path}`);
  }
  const problems = d.folders.map((f) => folderProblem(f, d.folders)).filter((p) => p !== null);
  const errors: Partial<Record<WatchField, string>> = {};
  if (problems[0]) errors.folders = problems[0];
  else if (d.folders.length > MAX_FOLDERS) errors.folders = `${MAX_FOLDERS} folders at most.`;
  const changed = new Set<WatchField>(names.length > 0 || errors.folders ? ["folders"] : []);
  return {
    patch: names.length > 0 ? { watch_folders: now } : {},
    changed,
    names,
    errors,
  };
}
