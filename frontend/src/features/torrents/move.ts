// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Where a torrent's content is and where a move sends it, as the daemon
// does it (`POST /torrents/location`, `/torrents/download-path`): a new save
// path moves the content now, except an incomplete torrent's in its
// download path, which goes there on completion; a download path moves the
// partial files now, and none sends them to the save path. Pure and tested.

import type { Schemas } from "~/api/client";

type Row = Pick<Schemas["TorrentSummary"], "save_path" | "download_path" | "complete">;

export type MoveTarget = "save" | "download";

/** An incomplete torrent downloading in its download path. */
export function staged(t: Row): boolean {
  return t.download_path !== null && !t.complete;
}

/** The folder its content is in now. */
export function contentDir(t: Row): string {
  return staged(t) ? (t.download_path ?? t.save_path) : t.save_path;
}

/** "Now" and "After" for one torrent: a path, or `from → to on completion`. */
export function movePlan(t: Row, target: MoveTarget, path: string): { now: string; after: string } {
  const later = (from: string, to: string) => `${from} → ${to} on completion`;
  const now = staged(t) ? later(t.download_path ?? "", t.save_path) : t.save_path;
  if (target === "save") {
    return { now, after: staged(t) ? later(t.download_path ?? "", path) : path };
  }
  return { now, after: path === "" ? t.save_path : later(path, t.save_path) };
}

/** Why a typed location cannot be used; `null` when it can. */
export function locationProblem(target: MoveTarget, path: string): string | null {
  if (target === "download" && path === "") return null;
  return path.startsWith("/") ? null : "An absolute path.";
}
