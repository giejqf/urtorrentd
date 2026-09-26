// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Paths on the daemon's machine as the folder dialog walks them. Pure.

import { formatCount } from "~/lib/format";

/** The folder holding `path` (`/` for the root). */
export function parentOf(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

/** `/data/linux` as its steps: `/`, `/data`, `/data/linux`. */
export function crumbs(path: string): { name: string; path: string }[] {
  const out = [{ name: "/", path: "/" }];
  let at = "";
  for (const part of path.split("/").filter((p) => p !== "")) {
    at += `/${part}`;
    out.push({ name: part, path: at });
  }
  return out;
}

/** What a folder holds: "4 items", "empty", "1 000+ items" (counted up to 1 000). */
export function itemsLabel(entries: number | null): string {
  if (entries === null) return "cannot read";
  if (entries === 0) return "empty";
  if (entries >= 1000) return "1,000+ items";
  return `${formatCount(entries)} ${entries === 1 ? "item" : "items"}`;
}
