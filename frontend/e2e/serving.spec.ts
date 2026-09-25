// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The daemon serving the UI (ADR 0008): deep links and headers, CORS for a
// listed origin only, and a TLS-terminating proxy in front (AGENTS.md 7.4).

import { CREDENTIALS, Daemon } from "./daemon";
import { expect, expectAccessible, test } from "./fixtures";
import { blankPage, forwardingProxy } from "./servers";

test("deep links load the app, with the daemon's headers", async ({ signedIn: page, daemon }) => {
  const response = await page.goto(`${daemon.url}/torrents/${"a".repeat(40)}?status=seeding`);
  expect(response?.status()).toBe(200);
  const headers = response?.headers() ?? {};
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
  expect(headers["x-frame-options"]).toBe("DENY");
  await expect(page.getByRole("heading", { name: "Seeding" })).toBeVisible();

  // Screens of later milestones say so rather than pretend.
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page.getByRole("heading", { name: "Settings is not built yet" })).toBeVisible();
  await expectAccessible(page);
});

test("CORS: a listed origin may call the API, another may not", async ({ page }, info) => {
  const listed = await blankPage();
  const other = await blankPage();
  const daemon = await Daemon.start({
    peerIp: `127.0.${10 + info.workerIndex}.251`,
    settings: { api_cors_origins: [listed.origin] },
  });
  try {
    await page.goto(listed.origin);
    const status = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/v1/auth/status`, { credentials: "include" });
      return r.json();
    }, daemon.url);
    expect(status).toEqual({ setup_required: false });
    // A preflighted request; its error is readable too.
    const login = await page.evaluate(async (url) => {
      const r = await fetch(`${url}/api/v1/auth/login`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "nobody", password: "not the password" }),
      });
      return { status: r.status, body: await r.json() };
    }, daemon.url);
    expect(login.status).toBe(401);
    expect(login.body.error.code).toBe("unauthorized");

    await page.goto(other.origin);
    const refused = await page.evaluate(async (url) => {
      try {
        await fetch(`${url}/api/v1/auth/status`);
        return "read";
      } catch {
        return "blocked";
      }
    }, daemon.url);
    expect(refused).toBe("blocked");
  } finally {
    await daemon.stop();
    await listed.close();
    await other.close();
  }
});

test("behind a TLS-terminating proxy: Secure cookie, live updates", async ({
  page,
  context,
}, info) => {
  const daemon = await Daemon.start({
    peerIp: `127.0.${10 + info.workerIndex}.252`,
    settings: { api_trusted_proxies: ["127.0.0.1"] },
  });
  const proxy = await forwardingProxy(daemon.url);
  try {
    // Through the proxy under a name, as a browser reaches Caddy.
    await page.goto(`http://localhost:${proxy.port}/`);
    await expect(page).toHaveURL(/\/sign-in/);
    await page.getByLabel("Username").fill(CREDENTIALS.username);
    await page.getByLabel("Password").fill(CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("heading", { name: "All torrents" })).toBeVisible();
    const cookie = (await context.cookies()).find((c) => c.name === "urtorrentd_sid");
    expect(cookie?.secure).toBe(true);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe("Strict");
    // The event stream comes through: the store fills and says so.
    await expect(page.getByRole("status", { name: "Connected to the daemon" })).toBeVisible();
    // A state-changing call passes the CSRF check behind the proxy.
    await page.getByRole("button", { name: "Add", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Add torrents" });
    await dialog.getByLabel("Links").fill("5".repeat(40));
    await dialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByRole("option")).toHaveCount(1);
  } finally {
    await proxy.close();
    await daemon.stop();
  }
});
