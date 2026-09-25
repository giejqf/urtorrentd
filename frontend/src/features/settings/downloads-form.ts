// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Downloads page's form: the settings as the user edits them, what
// changed, and the `PATCH /settings` body that saves it. A setting that is
// either a value or `null` (off) is a switch and a text: the text is kept
// while the switch is off, so turning it back on brings it back. Pure and
// tested.

import type { Schemas } from "~/api/client";

import type { FormDiff } from "./form";

type Settings = Schemas["Settings"];
type SettingsPatch = Schemas["SettingsPatch"];

export interface DownloadsDraft {
  save_path: string;
  download_path_on: boolean;
  download_path: string;
  incomplete_file_suffix_on: boolean;
  incomplete_file_suffix: string;
  auto_management: boolean;
  category_paths_in_manual_mode: boolean;
  content_layout: Schemas["ContentLayout"];
  stop_condition: Schemas["StopCondition"];
  add_stopped: boolean;
  add_to_top_of_queue: boolean;
  merge_trackers: boolean;
  preallocate: boolean;
  recheck_on_completion: boolean;
  excluded_file_names: string[];
  export_dir_on: boolean;
  export_dir: string;
  export_dir_finished_on: boolean;
  export_dir_finished: string;
  add_trackers: string[];
  add_trackers_url_on: boolean;
  add_trackers_url: string;
}

export type DraftField = keyof DownloadsDraft;
export type Diff = FormDiff<DraftField>;

/** The suffix a field offers before one is set. */
export const SUFFIX_SUGGESTION = ".!ur";

/** At most this many file name patterns (the daemon's limit). */
export const MAX_PATTERNS = 256;

/**
 * The draft of saved settings. A setting that is off keeps the text it had
 * in `prev` (the draft being replaced, after a save), so it comes back.
 */
export function draftOf(s: Settings, prev?: DownloadsDraft): DownloadsDraft {
  return {
    save_path: s.save_path,
    download_path_on: s.download_path !== null,
    download_path: s.download_path ?? prev?.download_path ?? "",
    incomplete_file_suffix_on: s.incomplete_file_suffix !== null,
    incomplete_file_suffix:
      s.incomplete_file_suffix ?? prev?.incomplete_file_suffix ?? SUFFIX_SUGGESTION,
    auto_management: s.auto_management,
    category_paths_in_manual_mode: s.category_paths_in_manual_mode,
    content_layout: s.content_layout,
    stop_condition: s.stop_condition,
    add_stopped: s.add_stopped,
    add_to_top_of_queue: s.add_to_top_of_queue,
    merge_trackers: s.merge_trackers,
    preallocate: s.preallocate,
    recheck_on_completion: s.recheck_on_completion,
    excluded_file_names: [...s.excluded_file_names],
    export_dir_on: s.export_dir !== null,
    export_dir: s.export_dir ?? prev?.export_dir ?? "",
    export_dir_finished_on: s.export_dir_finished !== null,
    export_dir_finished: s.export_dir_finished ?? prev?.export_dir_finished ?? "",
    add_trackers: [...s.add_trackers],
    add_trackers_url_on: s.add_trackers_url !== null,
    add_trackers_url: s.add_trackers_url ?? prev?.add_trackers_url ?? "",
  };
}

/** Why a path is not one the daemon takes; `null` = it is. */
export function pathProblem(path: string): string | null {
  if (path === "") return "Choose a folder, or turn this off.";
  if (!path.startsWith("/") || path.includes("\u0000")) return "An absolute path, starting with /.";
  return null;
}

/** Why a suffix is not one the daemon takes; `null` = it is. */
export function suffixProblem(suffix: string): string | null {
  const bytes = new TextEncoder().encode(suffix).length;
  if (bytes === 0 || bytes > 32 || /[/\\]/.test(suffix) || suffix.includes("\u0000"))
    return "1 to 32 characters, without slashes.";
  return null;
}

/** Why a file name pattern is not one the daemon takes; `null` = it is. */
export function patternProblem(pattern: string): string | null {
  const bytes = new TextEncoder().encode(pattern).length;
  return bytes === 0 || bytes > 256 ? "A pattern is 1 to 256 characters." : null;
}

/** Why a tracker URL is not one the daemon takes; `null` = it is. */
export function trackerProblem(url: string): string | null {
  const lower = url.toLowerCase();
  const ok = ["http://", "https://", "udp://"].some(
    (p) => lower.startsWith(p) && lower.length > p.length,
  );
  return ok ? null : "An http, https or udp URL.";
}

function listUrlProblem(url: string): string | null {
  if (url === "") return "A URL, or turn this off.";
  return /^https?:\/\/./i.test(url) ? null : "An http or https URL.";
}

/** Settings the page takes as they are. */
type Flag =
  | "auto_management"
  | "category_paths_in_manual_mode"
  | "content_layout"
  | "stop_condition"
  | "add_stopped"
  | "add_to_top_of_queue"
  | "merge_trackers"
  | "preallocate"
  | "recheck_on_completion";

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export function diff(saved: Settings, d: DownloadsDraft): Diff {
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
  const flag = (f: Flag) => {
    if (d[f] !== saved[f]) note(f, d[f]);
  };
  const list = (f: "excluded_file_names" | "add_trackers") => {
    if (!sameList(d[f], saved[f])) note(f, [...d[f]]);
  };
  /** A value that is off (`null`), or a text `problem` accepts. */
  const optional = (
    field:
      | "download_path"
      | "incomplete_file_suffix"
      | "export_dir"
      | "export_dir_finished"
      | "add_trackers_url",
    on: boolean,
    text: string,
    problem: (t: string) => string | null,
  ) => {
    const value = on ? text : null;
    const p = value === null ? null : problem(value);
    if (p) fail(field, p);
    else if (value !== (saved[field] ?? null)) note(field, value);
  };

  // In the page's order, so the save bar reads like the page.
  const save = d.save_path.trim();
  const saveProblem = save === "" ? "The save path is needed." : pathProblem(save);
  if (saveProblem) fail("save_path", saveProblem);
  else if (save !== saved.save_path) note("save_path", save);
  optional("download_path", d.download_path_on, d.download_path.trim(), pathProblem);
  optional(
    "incomplete_file_suffix",
    d.incomplete_file_suffix_on,
    d.incomplete_file_suffix,
    suffixProblem,
  );
  flag("auto_management");
  flag("category_paths_in_manual_mode");
  flag("content_layout");
  flag("stop_condition");
  flag("add_stopped");
  flag("add_to_top_of_queue");
  flag("merge_trackers");
  flag("preallocate");
  flag("recheck_on_completion");
  list("excluded_file_names");
  if (d.excluded_file_names.length > MAX_PATTERNS) {
    fail("excluded_file_names", `${MAX_PATTERNS} patterns at most.`);
  }
  optional("export_dir", d.export_dir_on, d.export_dir.trim(), pathProblem);
  optional(
    "export_dir_finished",
    d.export_dir_finished_on,
    d.export_dir_finished.trim(),
    pathProblem,
  );
  list("add_trackers");
  optional("add_trackers_url", d.add_trackers_url_on, d.add_trackers_url.trim(), listUrlProblem);

  return { patch: patch as SettingsPatch, changed, names, errors };
}
