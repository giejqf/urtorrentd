// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Playwright fixtures (AGENTS.md 7.4): real daemons per test, a signed-in
// page, and guards every test runs under: no request may leave loopback,
// and no Content-Security-Policy violation may happen.

import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";

import { CREDENTIALS, Daemon } from "./daemon";

let started = 0;

/** A loopback address for a daemon's peers, unique in this run. */
function peerIp(worker: number): string {
  started += 1;
  return `127.0.${10 + (worker % 200)}.${(started % 250) + 2}`;
}

function isLoopback(host: string): boolean {
  return host === "localhost" || host.startsWith("127.") || host === "[::1]";
}

interface Fixtures {
  /** A daemon whose credentials are set ({@link CREDENTIALS}). */
  daemon: Daemon;
  /** A daemon still waiting for first-run setup. */
  freshDaemon: Daemon;
  /** A second daemon, driven only through its API, to seed from. */
  seeder: Daemon;
  /** A page signed in to {@link daemon}, at its root. */
  signedIn: Page;
  guard: void;
}

export const test = base.extend<Fixtures>({
  guard: [
    async ({ context }, use) => {
      const outside: string[] = [];
      const csp: string[] = [];
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (url.protocol === "data:" || isLoopback(url.hostname)) return route.continue();
        outside.push(url.href);
        return route.abort("blockedbyclient");
      });
      context.on("console", (msg) => {
        const text = msg.text();
        if (/Content Security Policy|Refused to/i.test(text)) csp.push(text);
      });
      await use();
      expect(outside, "requests that left loopback").toEqual([]);
      expect(csp, "Content-Security-Policy violations").toEqual([]);
    },
    { auto: true },
  ],
  daemon: async ({}, use, info) => {
    const d = await Daemon.start({ peerIp: peerIp(info.workerIndex) });
    await use(d);
    await d.stop();
  },
  freshDaemon: async ({}, use, info) => {
    const d = await Daemon.start({ peerIp: peerIp(info.workerIndex), fresh: true });
    await use(d);
    await d.stop();
  },
  seeder: async ({}, use, info) => {
    const d = await Daemon.start({ peerIp: peerIp(info.workerIndex) });
    await use(d);
    await d.stop();
  },
  signedIn: async ({ page, daemon }, use) => {
    const r = await page.request.post(`${daemon.url}/api/v1/auth/login`, { data: CREDENTIALS });
    expect(r.status()).toBe(204);
    await page.goto(daemon.url);
    await use(page);
  },
});

export { expect };

/** No WCAG 2.1 A/AA violation on the page as it is now. */
export async function expectAccessible(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const found = result.violations.map(
    (v) =>
      `${v.id}: ${v.help} — ${v.nodes
        .slice(0, 4)
        .map((n) => n.target.join(" "))
        .join(", ")}`,
  );
  expect(found, "accessibility violations").toEqual([]);
}
