// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Torrent actions (AGENTS.md 4.1): one call per action for the whole
// selection. A `BulkResult` that did not apply everywhere is shown, never
// dropped. Long operations (recheck) answer when accepted: their progress
// arrives as the torrent's state through the live store.

import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";

type BulkResult = Schemas["BulkResult"];
type QueueMoveTo = Schemas["QueueMoveTo"];

function report(what: string, r: BulkResult): BulkResult {
  const missed = r.not_found.length + r.failed.length;
  if (missed > 0) {
    const why = r.failed[0]?.error.message ?? "no such torrent";
    toast.error(`${what}: ${r.applied.length} done, ${missed} not (${why})`);
  }
  return r;
}

async function run(what: string, call: () => Promise<BulkResult>): Promise<BulkResult | null> {
  try {
    return report(what, await call());
  } catch (e) {
    toast.error(`${what}: ${e instanceof ApiError ? e.message : "failed"}`);
    return null;
  }
}

const body = (hashes: readonly string[]) => ({ hashes: [...hashes] });

export const actions = {
  start: (h: readonly string[]) =>
    run("Start", () => unwrap(api.POST("/api/v1/torrents/start", { body: body(h) }))),
  stop: (h: readonly string[]) =>
    run("Stop", () => unwrap(api.POST("/api/v1/torrents/stop", { body: body(h) }))),
  forceStart: (h: readonly string[], value: boolean) =>
    run("Force start", () =>
      unwrap(api.POST("/api/v1/torrents/force-start", { body: { ...body(h), value } })),
    ),
  recheck: (h: readonly string[]) =>
    run("Recheck", () => unwrap(api.POST("/api/v1/torrents/recheck", { body: body(h) }))),
  reannounce: (h: readonly string[]) =>
    run("Reannounce", () => unwrap(api.POST("/api/v1/torrents/reannounce", { body: body(h) }))),
  /** To the trackers on these hosts alone. */
  reannounceHosts: (h: readonly string[], hosts: string[]) =>
    run("Reannounce", () =>
      unwrap(api.POST("/api/v1/torrents/trackers/reannounce", { body: { ...body(h), hosts } })),
    ),
  sequential: (h: readonly string[], value: boolean) =>
    run("Sequential download", () =>
      unwrap(api.POST("/api/v1/torrents/sequential", { body: { ...body(h), value } })),
    ),
  firstLast: (h: readonly string[], value: boolean) =>
    run("First and last pieces first", () =>
      unwrap(
        api.POST("/api/v1/torrents/first-last-piece-priority", { body: { ...body(h), value } }),
      ),
    ),
  queue: (h: readonly string[], to: QueueMoveTo) =>
    run("Queue", () => unwrap(api.POST("/api/v1/torrents/queue", { body: { ...body(h), to } }))),
  category: (h: readonly string[], category: string | null) =>
    run("Category", () =>
      unwrap(api.POST("/api/v1/torrents/category", { body: { ...body(h), category } })),
    ),
  tags: (h: readonly string[], mode: Schemas["TagMode"], tags: string[]) =>
    run("Tags", () =>
      unwrap(api.POST("/api/v1/torrents/tags", { body: { ...body(h), mode, tags } })),
    ),
  location: (h: readonly string[], path: string) =>
    run("Move", () =>
      unwrap(api.POST("/api/v1/torrents/location", { body: { ...body(h), path } })),
    ),
  downloadPath: (h: readonly string[], path: string | null) =>
    run("Download path", () =>
      unwrap(api.POST("/api/v1/torrents/download-path", { body: { ...body(h), path } })),
    ),
  autoManagement: (h: readonly string[], value: boolean) =>
    run("Automatic management", () =>
      unwrap(api.POST("/api/v1/torrents/auto-management", { body: { ...body(h), value } })),
    ),
  limits: (h: readonly string[], limits: Omit<Schemas["LimitsRequest"], "hashes">) =>
    run("Limits", () =>
      unwrap(api.POST("/api/v1/torrents/limits", { body: { ...body(h), ...limits } })),
    ),
  shareLimits: (h: readonly string[], shareLimits: Schemas["ShareLimits"]) =>
    run("Share limits", () =>
      unwrap(
        api.POST("/api/v1/torrents/share-limits", {
          body: { ...body(h), share_limits: shareLimits },
        }),
      ),
    ),
  remove: (h: readonly string[], deleteFiles: boolean) =>
    run("Delete", () =>
      unwrap(
        api.POST("/api/v1/torrents/delete", { body: { ...body(h), delete_files: deleteFiles } }),
      ),
    ),
};

/** Whether a torrent runs (Stop applies) rather than stands (Start applies). */
export function isRunning(t: Pick<Schemas["TorrentSummary"], "state">): boolean {
  return !(t.state === "stopped" || t.state === "error" || t.state === "held");
}

export async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(`${what} copied`);
  } catch {
    toast.error(`${what} could not be copied`);
  }
}
