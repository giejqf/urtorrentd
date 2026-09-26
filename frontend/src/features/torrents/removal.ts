// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// What removing torrents with their files deletes, for the question asked
// first: the bytes downloaded (verified), the folders their content is in,
// and which of them the user tagged to keep. Pure and tested.

import type { Schemas } from "~/api/client";

type Row = Pick<Schemas["TorrentSummary"], "name" | "completed" | "content_path" | "tags">;

/** Folders named at most; the rest are counted. */
const PLACES = 2;

function dirname(path: string): string {
  const cut = path.replace(/\/+$/, "").lastIndexOf("/");
  return cut <= 0 ? "/" : path.slice(0, cut);
}

export function removal(
  rows: readonly Row[],
  keep: string,
): { bytes: number; places: string[]; morePlaces: number; kept: string[] } {
  const dirs = [
    ...new Set(rows.flatMap((t) => (t.content_path === null ? [] : [dirname(t.content_path)]))),
  ];
  return {
    bytes: rows.reduce((n, t) => n + t.completed, 0),
    places: dirs.slice(0, PLACES),
    morePlaces: Math.max(0, dirs.length - PLACES),
    kept: rows.filter((t) => t.tags.includes(keep)).map((t) => t.name),
  };
}
