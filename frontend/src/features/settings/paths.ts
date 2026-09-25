// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Where the daemon puts content, as it decides it (daemon/organize.rs): a
// category's paths resolved against the global ones, and which torrents
// sit in a folder now. Pure and tested.

import type { Schemas } from "~/api/client";

/** `rel` under `base`, unless it is absolute (as Rust's `Path::join`). */
export function joinPath(base: string, rel: string): string {
  if (rel.startsWith("/")) return rel;
  return `${base.replace(/\/+$/, "")}/${rel}`;
}

/** Where automatic management saves a category's torrents. */
export function categorySavePath(savePath: string, name: string, c: Schemas["Category"]): string {
  return joinPath(savePath, c.save_path ?? name);
}

/**
 * Where a category's automatically managed torrents download; `null` = no
 * download path (a relative one needs the global one).
 */
export function categoryDownloadPath(
  downloadPath: string | null,
  c: Schemas["Category"],
): string | null {
  const own = c.download_path;
  if (own === null) return downloadPath;
  if (own.startsWith("/")) return own;
  return downloadPath === null ? null : joinPath(downloadPath, own);
}

/** `path` is `dir` or inside it. */
export function isUnder(path: string, dir: string): boolean {
  const d = dir.replace(/\/+$/, "");
  return path === d || path.startsWith(`${d}/`) || d === "";
}

/** The torrents whose content is in `dir` now, and the verified bytes they hold. */
export function contentIn(
  torrents: readonly Pick<Schemas["TorrentSummary"], "content_path" | "completed">[],
  dir: string,
): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const t of torrents) {
    if (t.content_path !== null && isUnder(t.content_path, dir)) {
      count += 1;
      bytes += t.completed;
    }
  }
  return { count, bytes };
}
