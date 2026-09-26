// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Security & API, Engine, Statistics & GeoIP and About against
// real daemons (AGENTS.md 7.4): how a request is seen, sessions, bans, the
// key, the HTTP layer and cookies; engine tuning beside what runs, and a
// restart that waits for a download; retention, removed history and GeoIP
// paths; the instance, diagnostics, deleting statistics and shutting down.

import type { Page } from "@playwright/test";
import createClient from "openapi-fetch";

import type { paths } from "../src/api/schema";
import { CREDENTIALS } from "./daemon";
import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

/** A setting's field by its label; a changed one is also "(not saved)". */
function field(page: Page, label: string) {
  return page.getByLabel(new RegExp(`^${label}( \\(not saved\\))?$`));
}

test("security: the request, sessions and bans, the key, the HTTP layer, cookies", async ({
  signedIn: page,
  daemon,
}) => {
  await page.goto(`${daemon.url}/settings/security`);
  await expect(page.getByRole("heading", { name: "Security & API", level: 1 })).toBeVisible();

  // This very request, as the daemon sees it.
  const path = page.getByRole("region", { name: "A request, as configured" });
  await expect(path).toContainText("127.0.0.1");
  await expect(path).toContainText("a direct connection");
  await expect(path).toContainText("an IP address: always accepted");
  await expect(path).toContainText("same origin");

  // The harness's own session (from setup), ended with the others.
  const sessions = page.getByRole("region", { name: "Active sessions and sign-in bans" });
  await expect(sessions).toContainText("this session · admin");
  await expect(sessions.getByRole("button", { name: /^End the session from/ })).toHaveCount(1);
  await sessions.getByRole("button", { name: "End all other sessions" }).click();
  await expect(sessions.getByRole("button", { name: /^End the session from/ })).toHaveCount(0);
  expect((await daemon.api.GET("/api/v1/auth/sessions")).data).toHaveLength(1);

  // A failed sign-in shows, and is forgotten.
  const failed = await fetch(`${daemon.url}/api/v1/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": "curl/8.9.1" },
    body: JSON.stringify({ username: "admin", password: "not the one" }),
  });
  expect(failed.status).toBe(401);
  await expect(sessions).toContainText("1 failed sign-in", { timeout: 15_000 });
  await expect(sessions).toContainText("curl/8.9.1");
  await sessions.getByRole("button", { name: "Forget 127.0.0.1" }).click();
  await expect(sessions).not.toContainText("failed sign-in");
  expect((await daemon.api.GET("/api/v1/auth/bans")).data).toEqual([]);

  // A new key replaces the harness's, shown once: the harness takes it.
  await page.getByRole("button", { name: "Regenerate" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Replace" }).click();
  const shown = page.getByRole("dialog", { name: "Your new API key" });
  const key = await shown.getByLabel("API key").inputValue();
  expect(key).toMatch(/^urtd_[0-9a-f]{48}$/);
  await expectAccessible(page);
  await shown.getByRole("button", { name: "Done" }).click();
  await expect(shown).toBeHidden();
  await expect(page.getByText(key)).toHaveCount(0);
  daemon.api = createClient<paths>({
    baseUrl: daemon.url,
    headers: { authorization: `Bearer ${key}` },
  });
  const account = (await daemon.api.GET("/api/v1/auth/account")).data;
  expect(account?.api_key?.created).toBeGreaterThan(0);
  await expect(page.getByText(/created .* · not used since the daemon started/)).toBeVisible();

  // Limits and the HTTP layer, saved together.
  await field(page, "Sessions expire after").fill("24");
  await field(page, "Failed sign-ins before an address is banned").fill("0");
  await expect(page.getByRole("alert").filter({ hasText: "at least 1" })).toBeVisible();
  await field(page, "Failed sign-ins before an address is banned").fill("3");
  const proxies = field(page, "Trusted reverse proxies");
  await proxies.fill("lan");
  await proxies.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "An address or a block" })).toBeVisible();
  await proxies.fill("10.0.0.0/8");
  await proxies.press("Enter");
  await expectAccessible(page);
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toBeHidden();
  const { data } = await daemon.api.GET("/api/v1/settings");
  expect(data).toMatchObject({
    api_session_timeout: 86_400,
    api_max_auth_failures: 3,
    api_trusted_proxies: ["10.0.0.0/8"],
  });

  // The cookie jar: added from a Set-Cookie line, shown cut, removed.
  const cookie = page.getByLabel("New cookie");
  await cookie.fill("pass=9f3c77aa01e1");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Domain=" })).toBeVisible();
  await cookie.fill("pass=9f3c77aa01e1; Domain=tracker.example; Path=/");
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const jar = page.getByRole("list", { name: "Cookies" });
  await expect(jar).toContainText("9f3c…e1");
  await expect(jar).not.toContainText("9f3c77aa01e1");
  expect((await daemon.api.GET("/api/v1/app/cookies")).data).toEqual([
    { name: "pass", value: "9f3c77aa01e1", domain: "tracker.example", path: "/", expires: null },
  ]);
  await jar.getByRole("button", { name: "Remove the cookie pass for tracker.example" }).click();
  await expect(jar).toBeHidden();
  expect((await daemon.api.GET("/api/v1/app/cookies")).data).toEqual([]);

  // New credentials end this session too.
  await page.getByRole("button", { name: "Change password" }).click();
  const creds = page.getByRole("dialog", { name: "Change the user name and password" });
  await creds.getByLabel("New password", { exact: true }).fill("a new password");
  await creds.getByLabel("The new password again").fill("another one");
  await creds.getByRole("button", { name: "Change and sign in again" }).click();
  await expect(creds.getByRole("alert")).toHaveText("The passwords differ.");
  await creds.getByLabel("The new password again").fill("a new password");
  await creds.getByRole("button", { name: "Change and sign in again" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.getByLabel("Username").fill(CREDENTIALS.username);
  await page.getByLabel("Password").fill("a new password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Security & API", level: 1 })).toBeVisible();
});

test("engine: the machine, saved beside running, a restart that waits for a download", async ({
  signedIn: page,
  daemon,
  seeder,
}) => {
  await page.goto(`${daemon.url}/settings/engine`);
  await expect(page.getByRole("heading", { name: "Engine", level: 1 })).toBeVisible();
  const machine = page.getByRole("region", { name: "The machine" });
  await expect(machine).toContainText("CPU threads");
  await expect(machine).toContainText("io_uring");
  await expect(machine).toContainText(/ulimit -n|no limit/);
  await expect(machine).toContainText("free");

  // Saved, it waits for a restart beside the running value.
  await field(page, "Hashing threads").fill("0");
  await expect(page.getByRole("alert").filter({ hasText: "at least 1" })).toBeVisible();
  await field(page, "Hashing threads").fill("3");
  await page.getByText("Zero-copy sends", { exact: true }).click();
  await expectAccessible(page);
  await page.keyboard.press("Control+s");
  const waiting = page.getByRole("region", { name: "Waiting for a restart" });
  await expect(waiting).toContainText("hash_threads 2 → 3");
  await expect(waiting).toContainText("zero_copy_send off → on");
  await expect(page.getByText("after restart")).toHaveCount(2);
  await expect(
    page.getByRole("status").filter({ hasText: "2 settings apply after a restart" }),
  ).toBeVisible();

  // Back to what runs.
  await waiting.getByRole("button", { name: "Revert to running" }).click();
  await expect(waiting).toBeHidden();
  const { data } = await daemon.api.GET("/api/v1/settings");
  expect(data).toMatchObject({ hash_threads: 2, zero_copy_send: false });
  expect((await daemon.api.GET("/api/v1/app")).data?.restart_required).toEqual([]);

  // A download under way: a restart waits for it, and is called off.
  await seeder.api.PATCH("/api/v1/settings", { body: { upload_limit: 60_000 } });
  const t = makeTorrent({ name: "slow-e2e.bin", size: 1536 * 1024, pieceLength: 65_536 });
  t.writeContent(seeder.savePath);
  await seeder.api.POST("/api/v1/torrents", { body: { torrents: [t.base64] } });
  await seeder.waitFor(t.hash, (x) => x.state === "seeding", "the seeder to seed");
  await daemon.api.POST("/api/v1/torrents", { body: { torrents: [t.base64] } });
  await daemon.api.POST("/api/v1/torrents/peers", {
    body: { hashes: [t.hash], peers: [await seeder.peerAddress()] },
  });
  await daemon.waitFor(t.hash, (x) => Number(x.download_rate) > 0, "data coming in");
  await page.getByRole("button", { name: "Restart when idle" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Waiting: / })).toBeVisible();
  expect((await daemon.api.GET("/api/v1/app")).data?.restart_waiting).toBe(true);
  await page.getByRole("button", { name: "Call off" }).click();
  await expect(page.getByRole("button", { name: "Restart when idle" })).toBeVisible();
  const app = (await daemon.api.GET("/api/v1/app")).data;
  expect(app?.restart_waiting).toBe(false);
  const t0 = await daemon.api.GET("/api/v1/torrents/{hash}", {
    params: { path: { hash: t.hash } },
  });
  expect(t0.data?.complete).toBe(false);
});

test("statistics: retention, what is on disk, removed history, GeoIP files", async ({
  signedIn: page,
  daemon,
}) => {
  // A torrent that runs has days on record; removed, its history stays.
  const t = makeTorrent({ name: "stats-e2e.bin", size: 128 * 1024, pieceLength: 65_536 });
  await daemon.api.POST("/api/v1/torrents", { body: { torrents: [t.base64] } });
  await expect
    .poll(async () => (await daemon.api.GET("/api/v1/stats")).data?.torrents, { timeout: 20_000 })
    .toBe(1);
  await daemon.api.POST("/api/v1/torrents/delete", { body: { hashes: [t.hash] } });
  await expect.poll(async () => (await daemon.api.GET("/api/v1/stats")).data?.removed).toBe(1);

  await page.goto(`${daemon.url}/settings/statistics`);
  await expect(page.getByRole("heading", { name: "Statistics & GeoIP", level: 1 })).toBeVisible();
  const kpis = page.getByRole("region", { name: "What is recorded" });
  await expect(kpis).toContainText("statistics database");
  await expect(kpis).toContainText("torrents with history · 1 removed");
  await expect(kpis).toContainText("no GeoIP database");
  await expect(page.getByRole("img", { name: /^On disk now/ })).toBeVisible();
  await expect(
    page.getByText("1 removed torrent still has days and traffic on file"),
  ).toBeVisible();

  // Retention and the scrape, saved in seconds.
  await field(page, "Keep per-minute buckets for").fill("0");
  await expect(page.getByRole("alert").filter({ hasText: "Days, such as 7" })).toBeVisible();
  await field(page, "Keep per-minute buckets for").fill("7");
  await field(page, "Keep per-hour buckets for").fill("");
  await page.getByLabel("Scrape every").fill("10");
  await expect(page.getByRole("alert").filter({ hasText: "Minutes, at least 30." })).toBeVisible();
  await page.getByLabel("Scrape every").fill("45");
  await expect(page.getByRole("img", { name: /cut at 7 d/ })).toBeVisible();
  await expectAccessible(page);
  await page.keyboard.press("Control+s");
  const bar = page.getByRole("region", { name: "Unsaved changes" });
  await expect(bar).toBeHidden();
  const { data } = await daemon.api.GET("/api/v1/settings");
  expect(data).toMatchObject({
    stats_minute_retention: 7 * 86_400,
    stats_hour_retention: null,
    stats_scrape_interval: 45 * 60,
  });

  // The removed torrent's history, deleted.
  await page.getByRole("button", { name: "Delete all" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("No removed torrent has history on file.")).toBeVisible();
  expect((await daemon.api.GET("/api/v1/stats")).data?.removed).toBe(0);

  // A GeoIP file the daemon cannot read is refused with its reason.
  await field(page, "Country database").fill("/nonexistent/GeoLite2-Country.mmdb");
  await page.keyboard.press("Control+s");
  await expect(bar).toContainText("geoip_database");
  await bar.getByRole("button", { name: "Discard" }).click();
  await expect(bar).toBeHidden();
  expect((await daemon.api.GET("/api/v1/settings")).data?.geoip_database).toBeNull();
  const geo = page.getByRole("region", { name: "GeoIP" });
  await expect(geo).toContainText("Country · none");
});

test("about: the instance, diagnostics, deleting statistics, shutting down", async ({
  signedIn: page,
  daemon,
}) => {
  await daemon.api.PATCH("/api/v1/settings", { body: { hash_threads: 4 } });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: daemon.url,
  });
  await page.goto(`${daemon.url}/settings/about`);
  const app = (await daemon.api.GET("/api/v1/app")).data;
  const me = page.getByRole("region", { name: "urtorrentd" });
  await expect(me).toContainText(app?.version ?? "?");
  await expect(me).toContainText(`pid ${app?.pid}`);
  const instance = page.getByRole("region", { name: "This instance" });
  await expect(instance).toContainText(app?.data_dir ?? "?");
  await expect(instance).toContainText(`${daemon.peerIp}:${app?.listen_port}`);
  await expect(instance).toContainText("none: no list set");
  const waiting = page.getByRole("region", { name: "Waiting for a restart" });
  await expect(waiting).toContainText("hash_threads");
  await expect(waiting).toContainText("2 → 4");

  // The name, saved; the sidebar follows.
  await field(page, "Instance name").fill("seedbox-e2e");
  await page.keyboard.press("Control+s");
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toBeHidden();
  expect((await daemon.api.GET("/api/v1/settings")).data?.instance_name).toBe("seedbox-e2e");

  // Diagnostics: versions and the machine, no address or path.
  await page.getByRole("button", { name: "Copy diagnostics" }).click();
  await expect(page.getByText(/Diagnostics copied/)).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain(`urtorrentd ${app?.version}`);
  expect(text).toContain("Waiting for a restart: hash_threads 2 → 4");
  for (const secret of [daemon.peerIp, app?.data_dir ?? "?", "seedbox-e2e", "127.0.0.1"]) {
    expect(text).not.toContain(secret);
  }
  await expectAccessible(page);

  // Every statistic, deleted.
  const deleted = page.waitForResponse(
    (r) => r.url().endsWith("/api/v1/stats") && r.request().method() === "DELETE",
  );
  await page.getByRole("button", { name: "Delete statistics" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Delete statistics" }).click();
  expect((await deleted).status()).toBe(204);
  await expect(page.getByText("Every statistic is deleted")).toBeVisible();

  // Shut down: the page says so, and the daemon is gone.
  await page.getByRole("button", { name: "Shut down", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Shut down" }).click();
  await expect(page.getByText("The daemon is shutting down.")).toBeVisible();
  await expect
    .poll(
      async () =>
        fetch(`${daemon.url}/api/v1/auth/status`).then(
          () => "up",
          () => "gone",
        ),
      { timeout: 20_000 },
    )
    .toBe("gone");
});
