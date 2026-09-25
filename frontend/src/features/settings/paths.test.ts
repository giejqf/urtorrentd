// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import { categoryDownloadPath, categorySavePath, contentIn, joinPath } from "./paths";

const cat = (save_path: string | null, download_path: string | null) => ({
  save_path,
  download_path,
});

describe("paths", () => {
  it("joins as the daemon does", () => {
    expect(joinPath("/data", "movies")).toBe("/data/movies");
    expect(joinPath("/data/", "movies")).toBe("/data/movies");
    expect(joinPath("/", "movies")).toBe("/movies");
    expect(joinPath("/data", "/mnt/fast")).toBe("/mnt/fast");
  });

  it("resolves a category's paths", () => {
    expect(categorySavePath("/data", "linux", cat(null, null))).toBe("/data/linux");
    expect(categorySavePath("/data", "linux", cat("iso", null))).toBe("/data/iso");
    expect(categoryDownloadPath(null, cat(null, null))).toBeNull();
    expect(categoryDownloadPath("/data/incoming", cat(null, null))).toBe("/data/incoming");
    expect(categoryDownloadPath("/data/incoming", cat(null, "sw"))).toBe("/data/incoming/sw");
    // A relative download path needs the global one.
    expect(categoryDownloadPath(null, cat(null, "sw"))).toBeNull();
    expect(categoryDownloadPath(null, cat(null, "/mnt/in"))).toBe("/mnt/in");
  });

  it("counts what is in a folder now", () => {
    const ts = [
      { content_path: "/data/incoming/a", completed: 100 },
      { content_path: "/data/incoming", completed: 1 },
      { content_path: "/data/incomingx/b", completed: 5 },
      { content_path: null, completed: 0 },
    ];
    expect(contentIn(ts, "/data/incoming/")).toEqual({ count: 2, bytes: 101 });
  });
});
