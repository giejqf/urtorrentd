// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The scale benchmark (AGENTS.md 7.4, W7), tagged @slow: a real daemon with
// BENCH_N torrents (default 10 000: magnets that wait for metadata, some
// stopped, and .torrent files without content), in categories and tags,
// and the UI against it in Chromium: loading, the list's scrolling, filters,
// sorting, search, one torrent, choosing all, the idle cost of the live
// stream, memory and the bundle. Times are measured in the page (from the
// action to the frame that shows its result), not through Playwright's
// clicks. It uses no request interception, so nothing slows the page down;
// the daemon is offline from its first start as in every spec.
//
//   SLOW=1 npx playwright test --grep @slow --project=chromium
//   SLOW=1 BENCH_N=1000 npx playwright test --grep @slow --project=chromium

import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { gzipSync } from "node:zlib";

import { type Page, test } from "@playwright/test";

import { CREDENTIALS, Daemon, UI_DIR } from "./daemon";
import { makeTorrent } from "./torrent";

const N = Number(process.env.BENCH_N ?? 10_000);
// Kept apart from test-results/, which each run empties.
const OUT = join(import.meta.dirname, "..", "..", "target", "bench", `web-${N}.json`);

const CATEGORIES = ["linux", "bsd", "movies", "series", "music", "books", "games", "software"];
const TAGS = ["iso", "keep", "4k", "hd", "flac", "old", "new", "x", "y", "z", "rare", "seed"];
const WORDS = ["alpha", "bravo", "delta", "echo", "golf", "hotel", "kilo", "lima", "oscar"];

const hex = (n: number) => createHash("sha1").update(`bench ${n}`).digest("hex");

interface Stats {
  frames: number;
  p50: number;
  p95: number;
  max: number;
  over50: number;
  fps: number;
}

function stats(deltas: number[], seconds: number): Stats {
  const s = [...deltas].sort((a, b) => a - b);
  const q = (p: number) => Math.round((s[Math.floor(p * (s.length - 1))] ?? 0) * 10) / 10;
  return {
    frames: s.length,
    p50: q(0.5),
    p95: q(0.95),
    max: Math.round((s[s.length - 1] ?? 0) * 10) / 10,
    over50: s.filter((d) => d > 50).length,
    fps: Math.round(s.length / seconds),
  };
}

/**
 * Milliseconds from the real input (the pointer or key going down, taken by
 * a capture listener) to the frame where `done` holds: `input` is
 * Playwright's click or key press, so its waiting for the element does not
 * count.
 */
async function timed(
  page: Page,
  input: () => Promise<void>,
  done: () => boolean,
  timeout = 60_000,
): Promise<number> {
  await page.evaluate(() => {
    const w = window as unknown as { t0: number };
    w.t0 = 0;
    const mark = () => {
      if (w.t0 === 0) w.t0 = performance.now();
    };
    document.addEventListener("pointerdown", mark, { capture: true, once: true });
    document.addEventListener("keydown", mark, { capture: true, once: true });
  });
  await input();
  const h = await page.waitForFunction(
    (d) =>
      new Function(`return (${d})()`)()
        ? performance.now() - (window as unknown as { t0: number }).t0
        : false,
    done.toString(),
    { polling: "raf", timeout },
  );
  return Math.round(((await h.jsonValue()) as number) * 10) / 10;
}

test("@slow the UI with many torrents", async ({ browser }) => {
  test.setTimeout(40 * 60_000);
  const daemon = await Daemon.start({ peerIp: "127.0.98.2" });
  const result: Record<string, unknown> = { torrents: N, date: new Date().toISOString() };
  try {
    // --- The daemon, filled in batches of 500 (a tenth .torrent files).
    const t0 = Date.now();
    const files = Math.floor(N / 10);
    let made = 0;
    for (let b = 0; made < N; b++) {
      const count = Math.min(500, N - made);
      const options = {
        category: CATEGORIES[b % CATEGORIES.length],
        tags: [TAGS[b % TAGS.length] ?? "x", TAGS[(b + 5) % TAGS.length] ?? "y"],
        stopped: b % 3 === 0,
      };
      if (made < files) {
        const torrents = Array.from({ length: count }, (_, i) => {
          const n = made + i;
          return makeTorrent({
            name: `bench-${n}-${WORDS[n % WORDS.length] ?? "x"}.bin`,
            size: 16_384 * (1 + (n % 7)),
            pieceLength: 16_384,
          }).base64;
        });
        const r = await daemon.api.POST("/api/v1/torrents", { body: { torrents, options } });
        if (!r.response.ok) throw new Error(`add: ${r.response.status}`);
      } else {
        const urls = Array.from({ length: count }, (_, i) => {
          const n = made + i;
          return `magnet:?xt=urn:btih:${hex(n)}&dn=bench-${n}-${WORDS[n % WORDS.length] ?? "x"}`;
        });
        const r = await daemon.api.POST("/api/v1/torrents", { body: { urls, options } });
        if (!r.response.ok) throw new Error(`add: ${r.response.status}`);
      }
      made += count;
    }
    const count = (await daemon.api.GET("/api/v1/torrents/count")).data;
    result.daemon = { added_ms: Date.now() - t0, count };

    // --- A cold load: a fresh context, signed in, straight to the list.
    // The timing helper runs its steps with `new Function`, which the page's
    // CSP forbids; the CSP costs nothing measurable, so it is bypassed here.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      bypassCSP: true,
    });
    const page = await context.newPage();
    const login = await page.request.post(`${daemon.url}/api/v1/auth/login`, {
      data: CREDENTIALS,
    });
    if (login.status() !== 204) throw new Error(`login: ${login.status()}`);
    const cdp = await context.newCDPSession(page);
    await cdp.send("Performance.enable");
    // What the live stream brings: its events and their bytes.
    await cdp.send("Network.enable");
    const pushed = { events: 0, bytes: 0 };
    cdp.on("Network.eventSourceMessageReceived", (e) => {
      pushed.events += 1;
      pushed.bytes += e.data.length;
    });
    const metrics = async (gc = false) => {
      // The heap as it is kept, not with the garbage not collected yet.
      if (gc) await cdp.send("HeapProfiler.collectGarbage");
      return Object.fromEntries(
        (await cdp.send("Performance.getMetrics")).metrics.map((m) => [m.name, m.value]),
      ) as Record<string, number>;
    };

    // The live stream's drops (the sidebar's status dot), on every load.
    let drops = 0;
    page.on("console", (m) => {
      if (m.text() === "bench: stream dropped") drops += 1;
    });
    await page.addInitScript(() => {
      document.addEventListener("DOMContentLoaded", () =>
        new MutationObserver((changes) => {
          for (const c of changes) {
            const e = c.target as Element;
            if (
              e.getAttribute("role") === "status" &&
              /Reconnecting|unreachable/.test(e.getAttribute("aria-label") ?? "")
            )
              console.log("bench: stream dropped");
          }
        }).observe(document.documentElement, {
          subtree: true,
          attributes: true,
          attributeFilter: ["aria-label"],
        }),
      );
    });

    await page.goto(`${daemon.url}/torrents`);
    const firstRows = await page.waitForFunction(
      () => document.querySelector('[role="option"]') !== null && performance.now(),
      undefined,
      { polling: "raf", timeout: 120_000 },
    );
    const allCounted = await page.waitForFunction(
      (n) => {
        const s = document.querySelector('section[aria-label="Status"] button');
        return (s?.textContent ?? "").replace(/\D/g, "") === String(n) && performance.now();
      },
      N,
      { polling: "raf", timeout: 120_000 },
    );
    const nav = await page.evaluate(() => {
      const e = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
      const res = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
      const code = res.filter((r) => /\.(js|css)$/.test(r.name));
      return {
        dom_content_loaded_ms: Math.round(e.domContentLoadedEventEnd),
        load_ms: Math.round(e.loadEventEnd),
        code_files: code.length,
        code_kb: Math.round(code.reduce((s, r) => s + r.decodedBodySize, 0) / 1000),
      };
    });
    const m0 = await metrics(true);
    result.load = {
      ...nav,
      first_rows_ms: Math.round((await firstRows.jsonValue()) as number),
      counts_ms: Math.round((await allCounted.jsonValue()) as number),
      js_heap_mb: Math.round((m0.JSHeapUsedSize ?? 0) / 1e5) / 10,
      dom_nodes: m0.Nodes,
    };

    // --- The snapshot the stream starts with, as fetched and parsed here.
    result.snapshot = await page.evaluate(async () => {
      const t = performance.now();
      const r = await fetch("/api/v1/sync");
      const text = await r.text();
      const fetched = performance.now();
      JSON.parse(text);
      return {
        kb: Math.round(text.length / 1000),
        fetch_ms: Math.round(fetched - t),
        parse_ms: Math.round(performance.now() - fetched),
      };
    });

    // --- Idle: what the live stream costs the main thread over 10 s.
    await page.waitForTimeout(2_000);
    const i0 = await metrics();
    const p0 = { ...pushed };
    await page.waitForTimeout(10_000);
    const i1 = await metrics();
    const pct = (k: string) => Math.round(((i1[k] ?? 0) - (i0[k] ?? 0)) * 1000) / 100;
    result.idle_10s = {
      busy_pct: pct("TaskDuration"),
      script_pct: pct("ScriptDuration"),
      layout_pct: pct("LayoutDuration"),
      style_pct: pct("RecalcStyleDuration"),
      stream_events: pushed.events - p0.events,
      stream_kb: Math.round((pushed.bytes - p0.bytes) / 1000),
    };

    // --- Scrolling: a fast fling down for 3 s, then jumps to the end and back.
    const scroll = await page.evaluate(async () => {
      const list = document.querySelector('[role="listbox"][aria-label="Torrents"]');
      const box = list?.parentElement;
      if (!box) throw new Error("no list");
      const run = (ms: number, step: (i: number) => void) =>
        new Promise<number[]>((ok) => {
          const d: number[] = [];
          let last = performance.now();
          const start = last;
          let i = 0;
          const frame = (t: number) => {
            d.push(t - last);
            last = t;
            if (t - start > ms) ok(d);
            else {
              step(i++);
              requestAnimationFrame(frame);
            }
          };
          requestAnimationFrame(frame);
        });
      box.scrollTop = 0;
      const fling = await run(3_000, () => {
        box.scrollTop += 600;
      });
      const rows = document.querySelectorAll('[role="option"]').length;
      const jumps = await run(2_000, (i) => {
        box.scrollTop = i % 2 === 0 ? box.scrollHeight : 0;
      });
      box.scrollTop = 0;
      return { fling, jumps, rows_in_dom: rows };
    });
    result.scroll = {
      fling: stats(scroll.fling, 3),
      jumps: stats(scroll.jumps, 2),
      rows_in_dom: scroll.rows_in_dom,
    };

    // --- Interactions, from the input to the frame that shows the result.
    const t: Record<string, number> = {};
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    const h1 = () => document.querySelector("h1")?.textContent ?? "";
    t.filter_stopped = await timed(
      page,
      () =>
        sidebar
          .getByRole("region", { name: "Status" })
          .getByRole("button", { name: /^Stopped/ })
          .click(),
      () => document.querySelector("h1")?.textContent === "Stopped",
    );
    t.filter_all = await timed(
      page,
      () =>
        sidebar
          .getByRole("region", { name: "Status" })
          .getByRole("button", { name: /^All/ })
          .click(),
      () => document.querySelector("h1")?.textContent === "All torrents",
    );
    t.filter_category = await timed(
      page,
      () =>
        sidebar
          .getByRole("region", { name: "Categories" })
          .getByRole("button", { name: /^linux/ })
          .click(),
      () => document.querySelector("h1")?.textContent === "All torrents · linux",
    );
    t.filter_tag = await timed(
      page,
      () =>
        sidebar.getByRole("region", { name: "Tags" }).getByRole("button", { name: /^iso/ }).click(),
      () => (document.querySelector("h1")?.textContent ?? "").includes("#iso"),
    );
    void h1;
    await page.goto(`${daemon.url}/torrents`);
    await page.waitForFunction(() => document.querySelector('[role="option"]') !== null);

    // Grouping and sorting, from the Display menu.
    await page.getByRole("button", { name: "Display" }).click();
    t.ungroup = await timed(
      page,
      () => page.getByRole("menuitemcheckbox", { name: "Group by state" }).click(),
      () => document.querySelector('[role="listbox"] .border-y') === null,
    );
    // By size (the .torrent files have seven), then reversed: every row moves
    // (the names are in the order they were added, all in the same second).
    await page.getByRole("menuitemradio", { name: "Size", exact: true }).click();
    await page.waitForTimeout(500);
    await page.evaluate(() => {
      (window as unknown as { first: string }).first = [
        ...document.querySelectorAll('[role="option"]'),
      ]
        .slice(0, 5)
        .map((o) => o.id)
        .join();
    });
    t.sort_reverse = await timed(
      page,
      () => page.getByRole("menuitemcheckbox", { name: "Descending" }).click(),
      () =>
        [...document.querySelectorAll('[role="option"]')]
          .slice(0, 5)
          .map((o) => o.id)
          .join() !== (window as unknown as { first: string }).first,
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector('[role="menu"]') === null);

    // One torrent opened.
    t.open_torrent = await timed(
      page,
      () => page.getByRole("listbox", { name: "Torrents" }).getByRole("option").nth(3).click(),
      () => document.querySelector('section[aria-label^="Details of"] h2') !== null,
    );
    // Every torrent chosen (⌘A), then none (Escape).
    const list = page.getByRole("listbox", { name: "Torrents" });
    await list.focus();
    t.select_all = await timed(
      page,
      () => page.keyboard.press("ControlOrMeta+a"),
      () =>
        (
          document.querySelector('[role="toolbar"][aria-label="Selected torrents"]')?.textContent ??
          ""
        ).includes(" selected"),
    );
    t.select_none = await timed(
      page,
      () => page.keyboard.press("Escape"),
      () => document.querySelector('[role="toolbar"][aria-label="Selected torrents"]') === null,
    );

    // The palette: open, then search (its typing settles for 150 ms first).
    t.palette_open = await timed(
      page,
      () => page.keyboard.press("ControlOrMeta+k"),
      () => document.querySelector('[role="dialog"][aria-label="Command palette"] input') !== null,
    );
    const input = page.getByRole("dialog", { name: "Command palette" }).getByRole("combobox");
    // A torrent there is at any size: its number typed, the last digit timed.
    const probe = String(Math.floor(N * 0.4242));
    await input.fill(`bench ${probe.slice(0, -1)}`);
    await page.evaluate((p) => {
      (window as unknown as { probe: string }).probe = p;
    }, probe);
    t.palette_search = await timed(
      page,
      () => input.press(probe.slice(-1)),
      () =>
        (
          document.querySelector(
            '[role="dialog"][aria-label="Command palette"] input',
          ) as HTMLInputElement | null
        )?.value === `bench ${(window as unknown as { probe: string }).probe}` &&
        document.querySelector('[role="group"][aria-label="Torrents"] [role="option"]') !== null &&
        !!document
          .querySelector('[role="group"][aria-label="Torrents"]')
          ?.textContent?.includes(`bench-${(window as unknown as { probe: string }).probe}-`),
    );
    t.list_search = await timed(
      page,
      () => page.getByRole("option", { name: /^Show the/ }).click(),
      () =>
        (document.querySelector("h1")?.textContent ?? "").includes(
          `“bench ${(window as unknown as { probe: string }).probe}”`,
        ),
    );
    result.interactions_ms = t;

    const m1 = await metrics(true);
    result.stream_drops = drops;
    result.end = {
      js_heap_mb: Math.round((m1.JSHeapUsedSize ?? 0) / 1e5) / 10,
      dom_nodes: m1.Nodes,
    };
    await context.close();
  } finally {
    await daemon.stop();
  }

  // --- The bundle, as built: raw and gzipped.
  const assets = join(UI_DIR, "assets");
  const all = readdirSync(assets).filter((f) => /\.(js|css)$/.test(f));
  const size = (f: string) => readFileSync(join(assets, f));
  const entry = /src="\/assets\/([^"]+\.js)"/.exec(
    readFileSync(join(UI_DIR, "index.html"), "utf8"),
  );
  const sum = (fs: string[], gz: boolean) =>
    Math.round(fs.reduce((s, f) => s + (gz ? gzipSync(size(f)).length : size(f).length), 0) / 1000);
  result.bundle_kb = {
    files: all.length,
    all_raw: sum(all, false),
    all_gzip: sum(all, true),
    entry: entry?.[1],
    entry_raw: entry?.[1] ? sum([entry[1]], false) : null,
    entry_gzip: entry?.[1] ? sum([entry[1]], true) : null,
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
});
