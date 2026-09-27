// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import {
  type AddForm,
  addOptions,
  categoryPath,
  filePriorities,
  parseSources,
  selectedSize,
  shortHash,
} from "./form";

const form = (more: Partial<AddForm> = {}): AddForm => ({
  savePath: "/data/linux",
  category: "linux",
  tags: ["iso"],
  layout: "original",
  stop: "none",
  start: true,
  autoManagement: false,
  sequential: false,
  firstLast: false,
  inheritLimits: true,
  downloadLimit: "",
  uploadLimit: "",
  ratio: "",
  download: { touched: false, on: false, path: "" },
  ...more,
});

describe("sources", () => {
  it("sorts lines into magnets, hashes and URLs, each once", () => {
    const { sources, invalid } = parseSources(
      [
        "magnet:?xt=urn:btih:9c2b7e41f0d3a8c6b5e2d1f4a7c9b8e6d5f3a2c1&dn=debian-13.1.0-amd64-DVD-1.iso&tr=x",
        "  https://cdimage.debian.org/debian-cd/current/amd64/bt-dvd/debian-13.1.0-amd64-DVD-2.iso.torrent  ",
        "",
        "C0FFEE00112233445566778899AABBCCDDEEFF00",
        "https://cdimage.debian.org/debian-cd/current/amd64/bt-dvd/debian-13.1.0-amd64-DVD-2.iso.torrent",
        "not a source",
      ].join("\n"),
    );
    expect(sources.map((s) => [s.kind, s.label])).toEqual([
      ["magnet", "debian-13.1.0-amd64-DVD-1.iso"],
      ["url", "debian-13.1.0-amd64-DVD-2.iso.torrent"],
      ["hash", "c0ffee00112233445566778899aabbccddeeff00"],
    ]);
    expect(invalid).toEqual(["not a source"]);
    expect(parseSources("magnet:?xt=urn:btih:ab&dn=Big+Buck%20Bunny").sources[0]?.label).toBe(
      "Big Buck Bunny",
    );
    expect(shortHash("9c2b7e41f0d3a8c6b5e2d1f4a7c9b8e6d5f3a2c1")).toBe("9c2b7e41f0d3…f3a2c1");
  });
});

describe("options", () => {
  it("sends the form as the API's units", () => {
    const r = addOptions(form({ uploadLimit: "5000", downloadLimit: "1,5" }));
    expect("options" in r && r.options).toMatchObject({
      save_path: "/data/linux",
      category: "linux",
      tags: ["iso"],
      stopped: false,
      auto_management: false,
      download_limit: 1500,
      upload_limit: 5_000_000,
    });
    expect("options" in r && r.options.share_limits).toBeUndefined();
  });

  it("leaves the save path to the category under automatic management", () => {
    const r = addOptions(form({ autoManagement: true }));
    expect("options" in r && r.options.save_path).toBeNull();
  });

  it("gives the torrent its own ratio when not inheriting", () => {
    const own = addOptions(form({ inheritLimits: false, ratio: "5.0" }));
    expect("options" in own && own.options.share_limits).toEqual({
      ratio: { mode: "limit", value: 5 },
      seeding_time: { mode: "unlimited" },
      inactive_seeding_time: { mode: "unlimited" },
      action: null,
    });
    const none = addOptions(form({ inheritLimits: false }));
    expect("options" in none && none.options.share_limits?.ratio).toEqual({ mode: "unlimited" });
  });

  it("says what is wrong", () => {
    expect(addOptions(form({ uploadLimit: "fast" }))).toEqual({
      error: "Upload limit: a number of kB/s, or empty for none.",
    });
    expect(addOptions(form({ inheritLimits: false, ratio: "-1" }))).toEqual({
      error: "Ratio limit: a number, or empty for none.",
    });
  });
});

describe("files and paths", () => {
  const files = [
    { path: "a/1.iso", size: 100 },
    { path: "a/2.iso", size: 50 },
  ];
  it("sizes what is selected and sends priorities only when changed", () => {
    expect(selectedSize(files, undefined)).toBe(150);
    expect(selectedSize(files, [0, 4])).toBe(50);
    expect(filePriorities([4, 4])).toBeUndefined();
    expect(filePriorities([0, 7])).toEqual([0, 7]);
  });

  it("resolves a category's save path as the daemon does", () => {
    const cat = (save_path: string | null) => ({ save_path, download_path: null });
    expect(categoryPath("/data", "linux", cat(null))).toBe("/data/linux");
    expect(categoryPath("/data/", "tv", cat("series"))).toBe("/data/series");
    expect(categoryPath("/data", "tv", cat("/srv/tv"))).toBe("/srv/tv");
    expect(categoryPath("/data", null, undefined)).toBe("/data");
  });
});

describe("the download path", () => {
  it("is the daemon's to decide until chosen", () => {
    const o = addOptions(form());
    expect("options" in o && o.options.download_path).toBeUndefined();
    expect("options" in o && o.options.use_download_path).toBeUndefined();
  });
  it("sends a folder, or none at all", () => {
    const on = addOptions(
      form({ download: { touched: true, on: true, path: " /data/incoming " } }),
    );
    expect("options" in on && on.options.download_path).toBe("/data/incoming");
    const off = addOptions(form({ download: { touched: true, on: false, path: "/x" } }));
    expect("options" in off && off.options.use_download_path).toBe(false);
    expect("options" in off && off.options.download_path).toBeUndefined();
    expect(addOptions(form({ download: { touched: true, on: true, path: " " } }))).toEqual({
      error: "Keep incomplete in: a folder, or turn it off.",
    });
  });
});
