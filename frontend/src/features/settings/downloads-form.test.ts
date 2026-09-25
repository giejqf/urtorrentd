// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import type { Schemas } from "~/api/client";

import {
  diff,
  draftOf,
  pathProblem,
  suffixProblem,
  SUFFIX_SUGGESTION,
  trackerProblem,
} from "./downloads-form";

const saved = {
  save_path: "/data",
  download_path: null,
  incomplete_file_suffix: null,
  auto_management: true,
  category_paths_in_manual_mode: false,
  content_layout: "original",
  stop_condition: "none",
  add_stopped: false,
  add_to_top_of_queue: false,
  merge_trackers: true,
  preallocate: true,
  recheck_on_completion: false,
  excluded_file_names: ["*.nfo"],
  export_dir: "/data/torrents",
  export_dir_finished: null,
  add_trackers: ["udp://tracker.lan:6969/announce"],
  add_trackers_url: null,
} as unknown as Schemas["Settings"];

describe("the downloads draft", () => {
  it("starts from the saved settings with nothing changed", () => {
    const d = draftOf(saved);
    expect(d.download_path_on).toBe(false);
    expect(d.incomplete_file_suffix).toBe(SUFFIX_SUGGESTION);
    const r = diff(saved, d);
    expect(r.changed.size).toBe(0);
    expect(r.patch).toEqual({});
  });

  it("sends an optional path when on, null when off, and keeps the text", () => {
    const d = { ...draftOf(saved), download_path_on: true, download_path: " /data/incoming " };
    expect(diff(saved, d).patch).toEqual({ download_path: "/data/incoming" });
    const off = { ...draftOf(saved), export_dir_on: false };
    expect(off.export_dir).toBe("/data/torrents");
    expect(diff(saved, off).patch).toEqual({ export_dir: null });
    expect(diff(saved, off).names).toEqual(["export_dir"]);
    // Saved off, the text stays for next time.
    const after = draftOf({ ...saved, export_dir: null }, off);
    expect(after.export_dir_on).toBe(false);
    expect(after.export_dir).toBe("/data/torrents");
  });

  it("says what is wrong and sends nothing for it", () => {
    const d = {
      ...draftOf(saved),
      save_path: "data",
      download_path_on: true,
      incomplete_file_suffix_on: true,
      incomplete_file_suffix: "a/b",
      add_trackers_url_on: true,
      add_trackers_url: "ftp://x/list",
    };
    const r = diff(saved, d);
    expect(r.errors).toEqual({
      save_path: "An absolute path, starting with /.",
      download_path: "Choose a folder, or turn this off.",
      incomplete_file_suffix: "1 to 32 characters, without slashes.",
      add_trackers_url: "An http or https URL.",
    });
    expect(r.patch).toEqual({});
    expect(r.changed.has("save_path")).toBe(true);
  });

  it("lists changes in the page's order", () => {
    const d = {
      ...draftOf(saved),
      add_trackers: [],
      excluded_file_names: ["*.nfo", "sample*"],
      content_layout: "subfolder" as const,
      incomplete_file_suffix_on: true,
    };
    const r = diff(saved, d);
    expect(r.names).toEqual([
      "incomplete_file_suffix",
      "content_layout",
      "excluded_file_names",
      "add_trackers",
    ]);
    expect(r.patch).toEqual({
      incomplete_file_suffix: ".!ur",
      content_layout: "subfolder",
      excluded_file_names: ["*.nfo", "sample*"],
      add_trackers: [],
    });
  });

  it("checks values as the daemon does", () => {
    expect(pathProblem("/srv")).toBeNull();
    expect(pathProblem("srv")).not.toBeNull();
    expect(suffixProblem(".part")).toBeNull();
    expect(suffixProblem("x".repeat(33))).not.toBeNull();
    expect(trackerProblem("UDP://t:1/announce")).toBeNull();
    expect(trackerProblem("udp://")).not.toBeNull();
    expect(trackerProblem("wss://t/announce")).not.toBeNull();
  });
});
