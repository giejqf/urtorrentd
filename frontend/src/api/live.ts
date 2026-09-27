// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The live store (AGENTS.md 4.3): torrents, categories, tags and the
// transfer state, fed by the daemon's event stream (`GET /api/v1/events`).
// Nothing polls `/torrents`; everything that lists torrents reads this.

import { batch } from "solid-js";
import { produce, reconcile, type SetStoreFunction } from "solid-js/store";

import type { Schemas } from "~/api/client";

type SyncResponse = Schemas["SyncResponse"];
type TorrentSummary = Schemas["TorrentSummary"];

export interface LiveState {
  /** The revision held; `null` before the first update. */
  rev: number | null;
  torrents: Record<string, Schemas["TorrentSummary"]>;
  categories: Record<string, Schemas["Category"]>;
  tags: string[];
  transfer: Schemas["TransferInfo"] | null;
}

export function emptyLive(): LiveState {
  return { rev: null, torrents: {}, categories: {}, tags: [], transfer: null };
}

/**
 * The torrents an update finishes: known before as incomplete, complete in
 * it (a full snapshot says nothing about what changed, so none).
 */
export function finishedIn(
  before: Readonly<Record<string, Pick<TorrentSummary, "complete">>>,
  u: SyncResponse,
): TorrentSummary[] {
  if (u.full) return [];
  return Object.entries(u.torrents).flatMap(([hash, t]) =>
    before[hash]?.complete === false && t.complete ? [t] : [],
  );
}

/**
 * Apply one update to the store. A full update replaces everything; a diff
 * replaces each changed torrent and category whole, deletes what was
 * removed, and replaces the tags (when sent) and the transfer state.
 * `reconcile` keeps the objects that did not change, so only the fields
 * that did notify their readers.
 */
export function applySync(set: SetStoreFunction<LiveState>, u: SyncResponse): void {
  batch(() => {
    if (u.full) {
      set("torrents", reconcile(u.torrents));
      set("categories", reconcile(u.categories));
    } else {
      for (const [hash, torrent] of Object.entries(u.torrents)) {
        set("torrents", hash, reconcile(torrent));
      }
      for (const [name, category] of Object.entries(u.categories)) {
        set("categories", name, reconcile(category));
      }
      if (u.torrents_removed.length > 0) {
        set(
          "torrents",
          produce((torrents) => {
            for (const hash of u.torrents_removed) delete torrents[hash];
          }),
        );
      }
      if (u.categories_removed.length > 0) {
        set(
          "categories",
          produce((categories) => {
            for (const name of u.categories_removed) delete categories[name];
          }),
        );
      }
    }
    if (u.tags !== null && u.tags !== undefined) set("tags", reconcile(u.tags));
    set("transfer", reconcile(u.transfer));
    set("rev", u.rev);
  });
}

/**
 * The stream's state, for the sidebar's dot: `connecting` before the first
 * update, `live` while updates arrive, `reconnecting` while the browser or
 * we retry, `signed_out` when the session ended (the app shows sign-in),
 * `stopped` while the daemon cannot be reached.
 */
export type Connection = "connecting" | "live" | "reconnecting" | "signed_out" | "stopped";

export interface LiveOptions {
  onUpdate: (update: SyncResponse) => void;
  onConnection: (connection: Connection) => void;
  /** The stream's URL (default `/api/v1/events`). */
  url?: string;
  /** For tests. */
  eventSource?: typeof EventSource;
  /** For tests. */
  fetch?: typeof fetch;
  /** For tests: schedules a retry. */
  setTimeout?: (fn: () => void, ms: number) => unknown;
  clearTimeout?: (handle: unknown) => void;
}

export interface LiveConnection {
  /** Close the stream for good. */
  close(): void;
  /** Open it again now (after signing in). */
  reconnect(): void;
}

const MAX_BACKOFF = 15_000;

/**
 * Open the event stream. The browser reconnects by itself after a dropped
 * connection and resumes with `Last-Event-ID`; when it gives up (an HTTP
 * error: the session ended, the daemon is stopping, a proxy error), ask the
 * public `GET /auth/status` and `GET /app` why, then sign out or retry with
 * backoff from the last revision.
 */
export function connectLive(opts: LiveOptions): LiveConnection {
  const url = opts.url ?? "/api/v1/events";
  const ES = opts.eventSource ?? EventSource;
  const doFetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const later = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = opts.clearTimeout ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));

  let source: EventSource | null = null;
  let rev: number | null = null;
  let timer: unknown = null;
  let backoff = 1_000;
  let closed = false;
  let received = false;

  const report = (c: Connection) => {
    if (!closed) opts.onConnection(c);
  };

  const open = () => {
    if (closed) return;
    source?.close();
    const target = rev === null ? url : `${url}?rev=${rev}`;
    const es = new ES(target, { withCredentials: true });
    source = es;
    report(received ? "reconnecting" : "connecting");
    es.addEventListener("sync", (e) => {
      if (source !== es) return;
      const update = JSON.parse((e as MessageEvent<string>).data) as SyncResponse;
      rev = update.rev;
      received = true;
      backoff = 1_000;
      opts.onUpdate(update);
      report("live");
    });
    es.addEventListener("error", () => {
      if (source !== es) return;
      if (es.readyState === ES.CLOSED) {
        void diagnose();
      } else {
        report("reconnecting");
      }
    });
  };

  const retry = (connection: Connection) => {
    report(connection);
    timer = later(() => {
      timer = null;
      open();
    }, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF);
  };

  const diagnose = async () => {
    source?.close();
    source = null;
    try {
      const status = await doFetch("/api/v1/auth/status", { credentials: "same-origin" });
      if (!status.ok) return retry("stopped");
      const app = await doFetch("/api/v1/app", { credentials: "same-origin" });
      if (app.status === 401) return report("signed_out");
      retry(app.ok ? "reconnecting" : "stopped");
    } catch {
      retry("stopped");
    }
  };

  open();

  return {
    close() {
      closed = true;
      if (timer !== null) cancel(timer);
      source?.close();
      source = null;
    },
    reconnect() {
      if (closed) return;
      if (timer !== null) cancel(timer);
      timer = null;
      backoff = 1_000;
      open();
    },
  };
}
