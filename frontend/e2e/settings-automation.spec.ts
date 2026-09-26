// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Watch folders, RSS and Webhooks against a real daemon
// (AGENTS.md 7.4), with loopback servers only: a webhook receiver that
// checks signatures and can fail on demand, a feed server, and folders the
// daemon watches.

import { createHmac } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

/** A setting's field by its label; a changed one is also "(not saved)". */
function field(page: Page, label: string) {
  return page.getByLabel(new RegExp(`^${label}( \\(not saved\\))?$`));
}

interface Got {
  headers: IncomingHttpHeaders;
  body: string;
}

/** A webhook receiver on loopback: answers `status()`, records every POST. */
async function receiver(status: () => number) {
  const got: Got[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c.toString()));
    req.on("end", () => {
      got.push({ headers: req.headers, body });
      res.writeHead(status());
      res.end();
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  return {
    got,
    url: `http://127.0.0.1:${port}/hook?token=do-not-show`,
    origin: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((ok) => server.close(() => ok())),
  };
}

test("webhooks: add, test, redeliver, edit, switch off, delete", async ({
  signedIn: page,
  daemon,
}) => {
  let answer = 200;
  const hook = await receiver(() => answer);
  try {
    await page.goto(`${daemon.url}/settings/webhooks`);
    await expect(page.getByRole("heading", { name: "Webhooks", level: 1 })).toBeVisible();
    await expect(page.getByText("No webhook yet.")).toBeVisible();

    await page.getByRole("button", { name: "Add webhook" }).click();
    const dialog = page.getByRole("dialog", { name: "Add webhook" });
    await dialog.getByLabel("URL").fill(hook.url);
    await dialog.getByLabel("Name").fill("Receiver");
    // Only "finished": every chip but that one off.
    for (const e of ["added", "metadata", "moved", "error", "removed"]) {
      await dialog.getByRole("button", { name: e, exact: true }).click();
    }
    await dialog.getByRole("button", { name: "Generate" }).click();
    const secret = await dialog.getByLabel("Secret").inputValue();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    await expectAccessible(page);
    await dialog.getByRole("button", { name: "Add webhook" }).click();
    await expect(dialog).toBeHidden();

    // The list shows the origin, never the token in the URL.
    const list = page.getByRole("region", { name: "Webhooks" });
    await expect(list).toContainText("Receiver");
    await expect(list).toContainText("signed");
    await expect(list).toContainText(`${hook.origin}/…`);
    expect(await page.getByRole("button", { name: /Receiver/ }).textContent()).not.toContain(
      "do-not-show",
    );

    // A test, signed with the secret.
    await page.getByRole("button", { name: "Send test event" }).click();
    await expect.poll(() => hook.got.length).toBe(1);
    const first = hook.got[0]!;
    const ts = String(first.headers["x-urtorrentd-timestamp"]);
    expect(first.headers["x-urtorrentd-signature"]).toContain(
      createHmac("sha256", secret).update(`${ts}.${first.body}`).digest("hex"),
    );
    await expect(page.getByText(/What the last test sent/)).toBeVisible();
    await expect(page.locator("pre")).toContainText('"event": "test"');

    // A failure, then the same delivery sent again.
    answer = 503;
    await page.getByRole("button", { name: "Send test event" }).click();
    const redeliver = page.getByRole("button", { name: /^Redeliver the test/ });
    await expect(redeliver).toBeVisible();
    await expect(list).toContainText("failing");
    answer = 200;
    await redeliver.click();
    await expect.poll(() => hook.got.length).toBe(3);
    expect(hook.got[2]!.headers["x-urtorrentd-delivery"]).toBe(
      hook.got[1]!.headers["x-urtorrentd-delivery"],
    );
    await expect(list).toContainText("healthy");

    // Edited and saved together.
    await page
      .getByRole("region", { name: "Webhooks" })
      .getByRole("button", { name: "added", exact: true })
      .click();
    await page.getByRole("button", { name: "Save webhook" }).click();
    await expect(page.getByRole("button", { name: "Save webhook" })).toBeHidden();
    let hooks = (await daemon.api.GET("/api/v1/webhooks")).data ?? [];
    expect(hooks[0]?.events).toEqual(["added", "finished"]);

    // Switched off at once.
    await page.getByRole("switch", { name: "Receiver enabled" }).focus();
    await page.keyboard.press("Space");
    await expect
      .poll(async () => (await daemon.api.GET("/api/v1/webhooks")).data?.[0]?.enabled)
      .toBe(false);
    await expect(list).toContainText("disabled");
    await expectAccessible(page);

    await page.getByRole("button", { name: "Delete webhook" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("No webhook yet.")).toBeVisible();
    hooks = (await daemon.api.GET("/api/v1/webhooks")).data ?? [];
    expect(hooks).toEqual([]);
  } finally {
    await hook.close();
  }
});

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Loopback ISOs</title>
<item><title>debian-13.1.0-amd64-DVD-1.iso</title><enclosure url="magnet:?xt=urn:btih:1111111111111111111111111111111111111111" type="application/x-bittorrent"/></item>
<item><title>ubuntu-24.04.3-desktop-amd64.iso</title><enclosure url="magnet:?xt=urn:btih:2222222222222222222222222222222222222222" type="application/x-bittorrent"/></item>
</channel></rss>`;

test("rss: polling settings, feeds refreshed on demand, rules switched", async ({
  signedIn: page,
  daemon,
}) => {
  const server = createServer((_, res) => {
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(FEED);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  try {
    const feed = await daemon.api.POST("/api/v1/rss/feeds", {
      body: { url: `http://127.0.0.1:${port}/feed.xml?passkey=do-not-show`, name: "Loopback ISOs" },
    });
    await daemon.api.PUT("/api/v1/rss/rules/{name}", {
      params: { path: { name: "Ubuntu" } },
      body: { must_contain: "ubuntu-*", feeds: [feed.data?.id ?? 0] },
    });
    await page.goto(`${daemon.url}/settings/rss`);
    await expect(page.getByRole("heading", { name: "RSS", level: 1 })).toBeVisible();
    const feeds = page.getByRole("region", { name: "Feeds" });
    await expect(feeds).toContainText(`127.0.0.1:${port}`);
    await expect(feeds).not.toContainText("do-not-show");

    await feeds.getByRole("button", { name: "Refresh Loopback ISOs" }).click();
    await expect(
      feeds
        .getByRole("row", { name: /Loopback ISOs/ })
        .getByRole("cell", { name: "2", exact: true }),
    ).toBeVisible();

    // The rule, off at once.
    await page.getByRole("switch", { name: "Ubuntu on" }).focus();
    await page.keyboard.press("Space");
    await expect
      .poll(async () => (await daemon.api.GET("/api/v1/rss/rules")).data?.[0]?.enabled)
      .toBe(false);

    // Polling: on, every 10 minutes, and what that plans.
    await page.getByText("Refresh feeds automatically", { exact: true }).click();
    await field(page, "Refresh interval").fill("0.5");
    await expect(page.getByRole("alert").filter({ hasText: "Minutes, at least 1." })).toBeVisible();
    await field(page, "Refresh interval").fill("10");
    await expect(page.getByRole("img", { name: /refreshes in the next hour/ })).toBeVisible();
    await expectAccessible(page);
    await page.keyboard.press("Control+s");
    await expect(page.getByRole("region", { name: "Unsaved changes" })).toBeHidden();
    const { data } = await daemon.api.GET("/api/v1/settings");
    expect(data).toMatchObject({ rss_enabled: true, rss_refresh_interval: 600 });
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

test("watch folders: added, edited, and what they pick up", async ({ signedIn: page, daemon }) => {
  const folder = join(daemon.savePath, "..", "watch");
  mkdirSync(folder, { recursive: true });
  await daemon.api.POST("/api/v1/categories", {
    body: { name: "linux", save_path: null, download_path: null },
  });
  await page.goto(`${daemon.url}/settings/watch-folders`);
  await expect(page.getByRole("heading", { name: "Watch folders", level: 1 })).toBeVisible();
  await expect(page.getByText("No watch folder yet.")).toBeVisible();

  await page.getByRole("button", { name: "Add folder" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The folder is needed." })).toBeVisible();
  await field(page, "Folder").fill(folder);
  await page.getByRole("button", { name: /^Category/ }).click();
  await page.getByRole("option", { name: "linux" }).click();
  const tags = page.getByLabel("Tags", { exact: true });
  await tags.fill("iso");
  await tags.press("Enter");
  await page.getByRole("radio", { name: "Yes", exact: true }).click();
  await expectAccessible(page);
  const bar = page.getByRole("region", { name: "Unsaved changes" });
  await expect(bar).toContainText(`watch_folders: + ${folder}`);
  await page.keyboard.press("Control+s");
  await expect(bar).toBeHidden();
  const { data } = await daemon.api.GET("/api/v1/settings");
  expect(data?.watch_folders).toEqual([
    {
      path: folder,
      recursive: false,
      after_add: "rename",
      options: expect.objectContaining({ category: "linux", tags: ["iso"], stopped: true }),
    },
  ]);

  // What it picks up, and what it cannot add.
  const t = makeTorrent({ name: "watched-e2e.bin", size: 128 * 1024, pieceLength: 65_536 });
  writeFileSync(join(folder, "watched.torrent"), Buffer.from(t.base64, "base64"));
  writeFileSync(join(folder, "broken.torrent"), "not a torrent");
  const recent = page.getByRole("region", { name: "Picked up recently" });
  await expect(recent).toContainText("watched.torrent → added as watched-e2e.bin", {
    timeout: 20_000,
  });
  await expect(recent).toContainText("broken.torrent — not added:");
  await expect(page.getByRole("region", { name: "Folders" })).toContainText("1 added since start");
  await expect(page.getByRole("region", { name: "Folders" })).toContainText(
    /read (just now|\d+s ago)/,
  );

  // Removed, and saved.
  await page.getByRole("button", { name: "Remove folder" }).click();
  await expect(bar).toContainText(`watch_folders: − ${folder}`);
  await page.getByRole("button", { name: /Save changes/ }).click();
  await expect(bar).toBeHidden();
  expect((await daemon.api.GET("/api/v1/settings")).data?.watch_folders).toEqual([]);
});
