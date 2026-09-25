// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The queue as it stands, from the live rows, by the library's rules
// (urtorrent `engine/queue.rs`, docs/quirks.md Q26): a running torrent holds
// a download slot until it is complete, then an upload slot; force-started
// torrents are charged too; a slow one (below 2 KiB/s both ways) holds none
// unless slow torrents count. The library does not report its own slow
// flag, so slowness here is read from the rates, which the queue waits 60 s
// to act on (docs/gaps.md). Pure and tested.

import type { Schemas } from "~/api/client";

type Row = Pick<
  Schemas["TorrentSummary"],
  | "hash"
  | "name"
  | "state"
  | "stalled"
  | "forced"
  | "complete"
  | "queue_position"
  | "download_rate"
  | "upload_rate"
  | "last_activity"
>;

/** Below this both ways a torrent is slow (libtorrent `inactive_down_rate`). */
export const SLOW_RATE = 2048;

const RUNNING: ReadonlySet<Schemas["TorrentState"]> = new Set([
  "metadata",
  "downloading",
  "seeding",
]);

export interface QueueEntry<R extends Row = Row> {
  row: R;
  /** The slot it holds; `null` when it holds none (waiting, or slow and not counted). */
  holds: "download" | "upload" | null;
  /** The kind of slot it wants: complete torrents seed. */
  kind: "download" | "upload";
  /** Waiting for a slot (`queued`). */
  waiting: boolean;
  /** Running below the slow rate both ways. */
  slow: boolean;
}

export interface QueueNow<R extends Row = Row> {
  /** Running and waiting torrents in queue order. */
  entries: QueueEntry<R>[];
  downloads: QueueEntry<R>[];
  uploads: QueueEntry<R>[];
  waiting: { download: number; upload: number };
}

export function queueNow<R extends Row>(rows: readonly R[], countSlow: boolean): QueueNow<R> {
  const entries: QueueEntry<R>[] = [];
  for (const row of rows) {
    const running = RUNNING.has(row.state);
    const waiting = row.state === "queued";
    if (!running && !waiting) continue;
    const kind = row.complete ? "upload" : "download";
    const slow = running && row.download_rate < SLOW_RATE && row.upload_rate < SLOW_RATE;
    const holds = running && (countSlow || !slow) ? kind : null;
    entries.push({ row, holds, kind, waiting, slow });
  }
  entries.sort((a, b) => a.row.queue_position - b.row.queue_position);
  return {
    entries,
    downloads: entries.filter((e) => e.holds === "download"),
    uploads: entries.filter((e) => e.holds === "upload"),
    waiting: {
      download: entries.filter((e) => e.waiting && e.kind === "download").length,
      upload: entries.filter((e) => e.waiting && e.kind === "upload").length,
    },
  };
}
