// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import { commandMatches, cycleScope, highlight, parseQuery } from "./palette-view";

describe("palette queries", () => {
  it("takes the scope from a prefix, else the chosen one", () => {
    expect(parseQuery(">theme", "everything")).toEqual({ scope: "commands", words: "theme" });
    expect(parseQuery("> add", "files")).toEqual({ scope: "commands", words: "add" });
    expect(parseQuery("t debian", "everything")).toEqual({ scope: "torrents", words: "debian" });
    expect(parseQuery("f s01e0? mkv", "everything")).toEqual({
      scope: "files",
      words: "s01e0? mkv",
    });
    expect(parseQuery("tails", "files")).toEqual({ scope: "files", words: "tails" });
    expect(parseQuery(" deb ", "torrents")).toEqual({ scope: "torrents", words: "deb" });
  });

  it("cycles the scopes both ways", () => {
    expect(cycleScope("everything", false)).toBe("torrents");
    expect(cycleScope("commands", false)).toBe("everything");
    expect(cycleScope("everything", true)).toBe("commands");
  });
});

describe("highlight", () => {
  it("marks each word where it is first found, case ignored", () => {
    expect(highlight("debian-13.1.0-amd64-DVD-1.iso", "DEB dvd")).toEqual([
      { text: "deb", match: true },
      { text: "ian-13.1.0-amd64-", match: false },
      { text: "DVD", match: true },
      { text: "-1.iso", match: false },
    ]);
  });

  it("leaves wildcard words and misses unmarked, and merges overlaps", () => {
    expect(highlight("README.debian.txt", "s01e0? zzz")).toEqual([
      { text: "README.debian.txt", match: false },
    ]);
    expect(highlight("abcdef", "abc bcd")).toEqual([
      { text: "abcd", match: true },
      { text: "ef", match: false },
    ]);
  });
});

describe("commandMatches", () => {
  it("wants every word in the label or keywords", () => {
    const c = { label: "Open Settings › Downloads", keywords: "paths categories" };
    expect(commandMatches(c, "settings down")).toBe(true);
    expect(commandMatches(c, "categories")).toBe(true);
    expect(commandMatches(c, "speed")).toBe(false);
    expect(commandMatches(c, "")).toBe(true);
  });
});
