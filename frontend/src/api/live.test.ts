// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { createStore } from "solid-js/store";
import { describe, expect, it, vi } from "vitest";

import { sync, torrent, transfer } from "~/test/fixtures";

import { applySync, connectLive, emptyLive, type Connection } from "./live";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

describe("applySync", () => {
  it("replaces everything on a full update", () => {
    const [state, set] = createStore(emptyLive());
    applySync(
      set,
      sync({
        rev: 3,
        torrents: { [A]: torrent({ hash: A }), [B]: torrent({ hash: B }) },
        categories: { linux: { save_path: "/data/linux", download_path: null } },
        tags: ["iso"],
      }),
    );
    expect(state.rev).toBe(3);
    expect(Object.keys(state.torrents).sort()).toEqual([A, B]);
    expect(state.categories.linux?.save_path).toBe("/data/linux");
    expect(state.tags).toEqual(["iso"]);

    applySync(
      set,
      sync({ rev: 9, torrents: { [C]: torrent({ hash: C }) }, categories: {}, tags: [] }),
    );
    expect(Object.keys(state.torrents)).toEqual([C]);
    expect(state.categories).toEqual({});
    expect(state.tags).toEqual([]);
  });

  it("applies a diff: changed torrents whole, removals, tags only when sent", () => {
    const [state, set] = createStore(emptyLive());
    applySync(
      set,
      sync({
        torrents: { [A]: torrent({ hash: A }), [B]: torrent({ hash: B, name: "b" }) },
        categories: { linux: { save_path: null, download_path: null } },
        tags: ["iso", "keep"],
      }),
    );
    const before = state.torrents[B];
    applySync(
      set,
      sync({
        rev: 2,
        full: false,
        torrents: {
          [A]: torrent({ hash: A, upload_rate: 7 }),
          [C]: torrent({ hash: C }),
        },
        torrents_removed: [],
        categories: { movies: { save_path: "/data/movies", download_path: null } },
        categories_removed: ["linux"],
        tags: null,
        transfer: transfer({ download_rate: 1 }),
      }),
    );
    expect(state.rev).toBe(2);
    expect(state.torrents[A]?.upload_rate).toBe(7);
    expect(state.torrents[C]?.hash).toBe(C);
    expect(state.torrents[B]).toBe(before);
    expect(Object.keys(state.categories)).toEqual(["movies"]);
    expect(state.tags).toEqual(["iso", "keep"]);
    expect(state.transfer?.download_rate).toBe(1);

    applySync(
      set,
      sync({ rev: 3, full: false, torrents: {}, torrents_removed: [A, B], tags: ["x"] }),
    );
    expect(Object.keys(state.torrents)).toEqual([C]);
    expect(state.tags).toEqual(["x"]);
  });
});

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static last: FakeEventSource | null = null;
  readyState = FakeEventSource.CONNECTING;
  readonly listeners = new Map<string, ((e: Event) => void)[]>();
  closed = false;

  constructor(
    readonly url: string,
    readonly init?: EventSourceInit,
  ) {
    FakeEventSource.last = this;
  }

  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
  }

  emit(type: string, e: Event) {
    for (const fn of this.listeners.get(type) ?? []) fn(e);
  }

  send(update: object) {
    this.readyState = FakeEventSource.OPEN;
    this.emit("sync", new MessageEvent("sync", { data: JSON.stringify(update) }));
  }

  fail(readyState: number) {
    this.readyState = readyState;
    this.emit("error", new Event("error"));
  }
}

function harness(responses: Record<string, number | "down">) {
  const states: Connection[] = [];
  const updates: number[] = [];
  const timers: (() => void)[] = [];
  const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
    const status = responses[String(input)];
    if (status === "down" || status === undefined) throw new TypeError("fetch failed");
    return new Response(null, { status });
  });
  const live = connectLive({
    onUpdate: (u) => updates.push(u.rev),
    onConnection: (c) => states.push(c),
    eventSource: FakeEventSource as unknown as typeof EventSource,
    fetch: fetchStub as unknown as typeof fetch,
    setTimeout: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimeout: () => {},
  });
  return { live, states, updates, timers, fetchStub };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("connectLive", () => {
  it("goes live on the first update and resumes from the last revision", async () => {
    const h = harness({ "/api/v1/auth/status": 200, "/api/v1/app": 200 });
    const first = FakeEventSource.last!;
    expect(first.url).toBe("/api/v1/events");
    expect(first.init?.withCredentials).toBe(true);
    expect(h.states).toEqual(["connecting"]);
    first.send(sync({ rev: 4 }));
    expect(h.updates).toEqual([4]);
    expect(h.states.at(-1)).toBe("live");

    first.fail(FakeEventSource.CONNECTING);
    expect(h.states.at(-1)).toBe("reconnecting");

    first.fail(FakeEventSource.CLOSED);
    await flush();
    expect(h.states.at(-1)).toBe("reconnecting");
    expect(h.timers).toHaveLength(1);
    h.timers[0]!();
    expect(FakeEventSource.last!.url).toBe("/api/v1/events?rev=4");
    h.live.close();
  });

  it("reports a signed-out session without retrying", async () => {
    const h = harness({ "/api/v1/auth/status": 200, "/api/v1/app": 401 });
    FakeEventSource.last!.fail(FakeEventSource.CLOSED);
    await flush();
    expect(h.states.at(-1)).toBe("signed_out");
    expect(h.timers).toHaveLength(0);
    h.live.reconnect();
    expect(FakeEventSource.last!.closed).toBe(false);
    h.live.close();
    expect(FakeEventSource.last!.closed).toBe(true);
  });

  it("reports a stopped daemon and keeps trying", async () => {
    const h = harness({ "/api/v1/auth/status": "down" });
    FakeEventSource.last!.fail(FakeEventSource.CLOSED);
    await flush();
    expect(h.states.at(-1)).toBe("stopped");
    expect(h.timers).toHaveLength(1);
    h.live.close();
  });
});
