// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Log screen against a real daemon (AGENTS.md 7.4): the main log by
// day, filtered by level, topic and text; an entry with its torrent; the
// view held while reading and followed again; and the export.

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

test("log: filters, an entry, following, export", async ({ signedIn: page, daemon }) => {
  // A feed that fails (a warning about RSS) and a torrent (an entry about it).
  const server = createServer((_, res) => {
    res.writeHead(503);
    res.end();
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  try {
    await daemon.api.POST("/api/v1/rss/feeds", {
      body: { url: `http://127.0.0.1:${port}/feed.xml`, name: "Broken feed" },
    });
    const t = makeTorrent({ name: "logged-e2e.bin", size: 128 * 1024, pieceLength: 65_536 });
    await daemon.api.POST("/api/v1/torrents", {
      body: { torrents: [t.base64], options: { stopped: true } },
    });
    await expect
      .poll(
        async () =>
          (await daemon.api.GET("/api/v1/log", { params: { query: { topics: "rss" } } })).data
            ?.length ?? 0,
      )
      .toBeGreaterThan(0);

    await page.goto(`${daemon.url}/log`);
    await expect(page.getByRole("heading", { name: "Main log", level: 1 })).toBeVisible();
    const list = page.getByRole("list", { name: "Main log" });
    await expect(list).toContainText(/Today · /);
    await expect(list).toContainText("RSS feed Broken feed: HTTP 503");
    await expect(list).toContainText("added torrent logged-e2e.bin");
    await expectAccessible(page);

    // Level, topic, text.
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    await sidebar.getByRole("button", { name: /^Warning \d+$/ }).click();
    await expect(page).toHaveURL(/level=warning/);
    await expect(list).not.toContainText("added torrent");
    await expect(list).toContainText("Broken feed");
    await sidebar.getByRole("button", { name: /^All \d+$/ }).click();
    await sidebar.getByRole("button", { name: /^Torrents \d+$/ }).click();
    await expect(list).not.toContainText("Broken feed");
    await expect(list).toContainText("added torrent logged-e2e.bin");
    await sidebar.getByRole("button", { name: /^Everything \d+$/ }).click();
    await page.getByLabel("Filter messages").fill("broken|nothing-else");
    await expect(list.getByRole("button")).toHaveCount(1);
    await page.getByLabel("Filter messages").fill("");

    // An entry about a torrent; reading holds the view.
    await list.getByRole("button", { name: /added torrent logged-e2e\.bin/ }).click();
    const panel = page.getByRole("complementary", { name: "Log entry" });
    await expect(panel.getByLabel("Message")).toHaveText(/^added torrent logged-e2e\.bin/);
    await expect(panel).toContainText("Torrents");
    await expect(panel.getByRole("link", { name: "logged-e2e.bin" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Follow", exact: true })).toBeVisible();
    await expectAccessible(page);

    // Something new while paused: counted, then shown when followed.
    const more = makeTorrent({ name: "later-e2e.bin", size: 64 * 1024, pieceLength: 65_536 });
    await daemon.api.POST("/api/v1/torrents", {
      body: { torrents: [more.base64], options: { stopped: true } },
    });
    await expect(
      page.getByRole("status").filter({ hasText: /paused · \d+ new entr/ }),
    ).toBeVisible();
    await expect(list).not.toContainText("later-e2e.bin");
    await page.getByRole("button", { name: "Follow", exact: true }).click();
    await expect(list).toContainText("added torrent later-e2e.bin");
    await expect(page.getByRole("button", { name: "Following" })).toBeVisible();
    // Rows of two lines keep their height as entries come in above them.
    const boxes = await list
      .getByRole("listitem")
      .evaluateAll((els) =>
        els.map((e) => e.getBoundingClientRect()).map((r) => ({ top: r.top, bottom: r.bottom })),
      );
    boxes.sort((x, y) => x.top - y.top);
    for (let i = 1; i < boxes.length; i += 1) {
      expect(boxes[i]?.top ?? 0).toBeGreaterThanOrEqual((boxes[i - 1]?.bottom ?? 0) - 0.5);
    }

    // To the torrent.
    await panel.getByRole("button", { name: "Open torrent" }).click();
    await expect(page).toHaveURL(new RegExp(`/torrents/${t.hash}$`));

    // The export: what is shown, oldest first.
    await page.goto(`${daemon.url}/log?topic=torrents`);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^urtorrentd-log-\d{12}\.txt$/);
    const text = readFileSync((await file.path()) ?? "", "utf8");
    const lines = text.trim().split("\n");
    expect(lines.every((l) => / info torrents /.test(l))).toBe(true);
    expect(lines.some((l) => l.includes(`${t.hash} added torrent logged-e2e.bin`))).toBe(true);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
