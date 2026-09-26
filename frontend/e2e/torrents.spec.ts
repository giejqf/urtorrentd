// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The main screen against real daemons (AGENTS.md 7.4): adding and
// deleting, a real download from a seeder, the sidebar's counts against
// the daemon's own filters, search, keyboard selection and the detail
// panel's edits. Every number asserted comes from the daemon's API.

import { formatBytes } from "../src/lib/format";
import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

const magnet = (hash: string, name: string) => `magnet:?xt=urn:btih:${hash}&dn=${name}`;

test("add a magnet, see it wait for metadata, delete it", async ({ signedIn: page, daemon }) => {
  await expect(page.getByText("No torrents yet")).toBeVisible();
  await expectAccessible(page);

  const hash = "c0ffee00112233445566778899aabbccddeeff00";
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add torrents" });
  await expectAccessible(page);
  await dialog.getByLabel("Sources").fill(magnet(hash, "tails-amd64-6.20.img"));
  await dialog.getByRole("button", { name: /^Category/ }).click();
  await page.getByRole("option", { name: "New category…" }).click();
  const prompt = page.getByRole("dialog", { name: "New category" });
  await prompt.getByLabel("Name").fill("linux");
  await prompt.getByRole("button", { name: "Use it" }).click();
  await dialog.getByLabel("Tags").fill("iso, keep");
  await dialog.getByRole("button", { name: "Add 1 torrent" }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByRole("option", { name: /tails-amd64-6\.20\.img/ });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/torrents/${hash}$`));
  const details = page.getByRole("region", { name: "Details of tails-amd64-6.20.img" });
  await expect(details.getByText("Fetching metadata")).toBeVisible();
  await expect(details.getByText("No metadata yet")).toBeVisible();
  await expect(details.getByText("waiting for metadata")).toBeVisible();
  await expect(details.getByText("keep", { exact: true })).toBeVisible();
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("button", { name: /^linux\s*1$/ })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^iso\s*1$/ })).toBeVisible();
  await expectAccessible(page);

  await details.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Remove…" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Remove tails-amd64-6.20.img?");
  await confirm.getByRole("button", { name: "Remove", exact: true }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText("No torrents yet")).toBeVisible();
  await expect(page).toHaveURL(/\/torrents$/);
  const { data } = await daemon.api.GET("/api/v1/torrents");
  expect(data).toEqual([]);
});

test("a real download from a seeder, shown as the daemon reports it", async ({
  signedIn: page,
  daemon,
  seeder,
}) => {
  const t = makeTorrent({ name: "sintel-e2e.bin", size: 3 * 1024 * 1024, pieceLength: 65_536 });
  t.writeContent(seeder.savePath);
  const seeded = await seeder.api.POST("/api/v1/torrents", { body: { torrents: [t.base64] } });
  expect(seeded.data?.added.map((a) => a.hash)).toEqual([t.hash]);
  await seeder.waitFor(t.hash, (x) => x.state === "seeding", "the seeder to seed");

  // Add the .torrent file through the UI.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add torrents" });
  await dialog.getByRole("tab", { name: ".torrent file" }).click();
  await dialog.getByLabel("Torrent files").setInputFiles({
    name: "sintel-e2e.torrent",
    mimeType: "application/x-bittorrent",
    buffer: t.bytes,
  });
  // The daemon reads the file before anything is added.
  await expect(dialog.getByRole("heading", { name: "sintel-e2e.bin" })).toBeVisible();
  await expect(dialog.getByText(`${t.pieces} × 64 KiB`)).toBeVisible();
  await dialog.getByRole("button", { name: "Add 1 torrent" }).click();
  await expect(dialog).toBeHidden();

  // No DHT and no tracker in the lab: tell it where the seeder is.
  const peers = await daemon.api.POST("/api/v1/torrents/peers", {
    body: { hashes: [t.hash], peers: [await seeder.peerAddress()] },
  });
  expect(peers.data?.applied).toEqual([t.hash]);

  await page.getByRole("option", { name: /sintel-e2e\.bin/ }).click();
  const details = page.getByRole("region", { name: "Details of sintel-e2e.bin" });
  await expect(details.getByText(/^100% · ratio/)).toBeVisible({ timeout: 30_000 });
  // Complete and seeding; with no leecher it moves no payload, which the
  // daemon flags as stalled and the UI shows as Idle (a stalled download
  // is Stalled).
  await expect(async () => {
    const { data } = await daemon.api.GET("/api/v1/torrents/{hash}", {
      params: { path: { hash: t.hash } },
    });
    expect(data?.state).toBe("seeding");
    await expect(
      details.getByText(data?.stalled ? "Idle" : "Seeding", { exact: true }),
    ).toBeVisible({
      timeout: 100,
    });
  }).toPass({ timeout: 10_000 });
  await expect(details.getByText(`${t.pieces} / ${t.pieces} × 64 KiB`)).toBeVisible();
  await expect(
    details.getByRole("img", { name: new RegExp(`^${t.pieces} of ${t.pieces} pieces had`) }),
  ).toBeVisible();

  // The counters are the daemon's, formatted.
  const done = await daemon.waitFor(t.hash, (x) => x.complete === true, "completion");
  const stat = (label: string) =>
    details.locator("dt", { hasText: label }).locator("xpath=following-sibling::dd[1]");
  await expect(stat("Downloaded")).toHaveText(formatBytes(done.downloaded as number));
  await expect(stat("Wasted")).toHaveText(formatBytes(done.wasted as number));
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  await expect(sidebar.getByRole("button", { name: /^Seeding\s*1$/ })).toBeVisible();
  await expect(sidebar.getByRole("button", { name: /^Completed\s*1$/ })).toBeVisible();
  await expectAccessible(page);
});

test("filters count as the daemon's do; search, keys and bulk actions", async ({
  signedIn: page,
  daemon,
}) => {
  const add = (hash: string, name: string, options: Record<string, unknown>) =>
    daemon.api.POST("/api/v1/torrents", { body: { urls: [magnet(hash, name)], options } });
  // Trackers on loopback only (they refuse): the lab never leaves the machine.
  const tr = (...urls: string[]) => urls.map((u) => `&tr=${encodeURIComponent(u)}`).join("");
  await add("1".repeat(40), `debian-13.1.0-amd64-DVD-1.iso${tr("http://127.0.0.1:1/announce")}`, {
    category: "linux",
    tags: ["iso"],
  });
  await add("2".repeat(40), "Big Buck Bunny (2008) 4K", { category: "movies", stopped: true });
  await add(
    "3".repeat(40),
    `archlinux-2026.09.01-x86_64.iso${tr("http://127.0.0.1:1/announce", "udp://localhost:1/announce")}`,
    { tags: ["iso", "keep"] },
  );
  const list = page.getByRole("listbox", { name: "Torrents" });
  await expect(list.getByRole("option")).toHaveCount(3);

  // Every status count equals the daemon's answer for that filter.
  const status = page.getByRole("region", { name: "Status" });
  const filters = [
    ["all", "All"],
    ["downloading", "Downloading"],
    ["seeding", "Seeding"],
    ["completed", "Completed"],
    ["active", "Active"],
    ["stalled_seeding", "Idle"],
    ["stalled_downloading", "Stalled"],
    ["stopped", "Stopped"],
    ["checking", "Checking"],
    ["errored", "Errored"],
  ] as const;
  await expect(async () => {
    for (const [filter, label] of filters) {
      const { data } = await daemon.api.GET("/api/v1/torrents", { params: { query: { filter } } });
      const button = status.getByRole("button", { name: new RegExp(`^${label}\\s*\\d+$`) });
      await expect(button, label).toHaveText(new RegExp(`${data?.length ?? -1}$`), {
        timeout: 100,
      });
    }
  }).toPass({ timeout: 15_000 });

  // Every tracker host counts its torrents, as the daemon's filter does.
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });
  const trackers = sidebar.getByRole("region", { name: "Trackers" });
  for (const [host, label] of [
    ["127.0.0.1", "127.0.0.1"],
    ["localhost", "localhost"],
    ["", "No tracker"],
  ] as const) {
    const { data } = await daemon.api.GET("/api/v1/torrents", {
      params: { query: { tracker: host } },
    });
    await expect(
      trackers.getByRole("button", { name: new RegExp(`^${label}\\s*${data?.length ?? -1}$`) }),
    ).toBeVisible();
  }
  await trackers.getByRole("button", { name: /^127\.0\.0\.1\s*2$/ }).click();
  await expect(page.getByRole("heading", { name: "All torrents · 127.0.0.1" })).toBeVisible();
  await expect(list.getByRole("option")).toHaveCount(2);
  await trackers.getByRole("button", { name: /^127\.0\.0\.1\s*2$/ }).click();

  // Filters narrow the list and name it.
  await sidebar.getByRole("button", { name: /^linux\s*1$/ }).click();
  await expect(page.getByRole("heading", { name: "All torrents · linux" })).toBeVisible();
  await expect(list.getByRole("option")).toHaveCount(1);
  await sidebar.getByRole("button", { name: /^linux\s*1$/ }).click();
  await sidebar.getByRole("button", { name: /^iso\s*2$/ }).click();
  await expect(list.getByRole("option")).toHaveCount(2);
  await sidebar.getByRole("button", { name: /^iso\s*2$/ }).click();
  await status.getByRole("button", { name: /^Stopped\s*1$/ }).click();
  await expect(page.getByRole("heading", { name: "Stopped" })).toBeVisible();
  await expect(list.getByRole("option", { name: /Big Buck Bunny/ })).toBeVisible();
  await status.getByRole("button", { name: /^All\s*3$/ }).click();

  // Search is the daemon's: words match the name, any order.
  await page.keyboard.press("/");
  await page.keyboard.type("iso debian");
  await expect(list.getByRole("option")).toHaveCount(1);
  await expect(list.getByRole("option", { name: /debian/ })).toBeVisible();
  await page.getByRole("searchbox", { name: "Search torrents" }).press("Escape");
  await expect(list.getByRole("option")).toHaveCount(3);

  // Keyboard: pick two, stop them with Space, delete them.
  // Display: no groups, by name. Wait for each menu to close: it hands
  // focus back to its button when its animation ends.
  const menu = page.getByRole("menu");
  await page.getByRole("button", { name: "Display" }).click();
  await page.getByRole("menuitemcheckbox", { name: "Group by state" }).click();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await page.getByRole("button", { name: "Display" }).click();
  await page.getByRole("menuitemradio", { name: "Name" }).click();
  await page.keyboard.press("Escape");
  await expect(menu).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Display" })).toBeFocused();
  await list.focus();
  await page.keyboard.press("ArrowDown");
  await expect(list.getByRole("option", { selected: true })).toHaveText(/archlinux/);
  await page.keyboard.press("Shift+ArrowDown");
  await expect(page.getByText("2 selected")).toBeVisible();
  await page.keyboard.press(" ");
  await expect(async () => {
    const { data } = await daemon.api.GET("/api/v1/torrents", {
      params: { query: { filter: "stopped" } },
    });
    expect(data?.map((t) => t.name).sort()).toEqual([
      "Big Buck Bunny (2008) 4K",
      "archlinux-2026.09.01-x86_64.iso",
    ]);
  }).toPass({ timeout: 10_000 });
  await page.keyboard.press("Delete");
  await page
    .getByRole("alertdialog")
    .getByRole("button", { name: /^Remove/ })
    .click();
  await expect(list.getByRole("option")).toHaveCount(1);
  const { data } = await daemon.api.GET("/api/v1/torrents");
  expect(data?.map((t) => t.name)).toEqual(["debian-13.1.0-amd64-DVD-1.iso"]);
});

test("the detail panel changes category and tags", async ({ signedIn: page, daemon }) => {
  const hash = "4".repeat(40);
  await daemon.api.POST("/api/v1/torrents", {
    body: { urls: [magnet(hash, "Elephants Dream (2006)")], options: { stopped: true } },
  });
  await page.getByRole("option", { name: /Elephants Dream/ }).click();
  const details = page.getByRole("region", { name: "Details of Elephants Dream (2006)" });
  await expect(details.getByText("Stopped", { exact: true })).toBeVisible();

  await details.getByRole("button", { name: /^Category: none/ }).click();
  await page.getByRole("menuitem", { name: "New category…" }).click();
  const prompt = page.getByRole("dialog", { name: "New category" });
  await prompt.getByLabel("Name").fill("movies");
  await prompt.getByRole("button", { name: "Create and set" }).click();
  await expect(details.getByRole("button", { name: /^Category: movies/ })).toBeVisible();

  await details.getByRole("button", { name: "Change tags" }).click();
  await page.getByRole("menuitem", { name: "New tag…" }).click();
  const tag = page.getByRole("dialog", { name: "New tag" });
  await tag.getByLabel("Tag").fill("keep");
  await tag.getByRole("button", { name: "Create and add" }).click();
  await expect(details.getByText("keep", { exact: true })).toBeVisible();

  const { data } = await daemon.api.GET("/api/v1/torrents/{hash}", { params: { path: { hash } } });
  expect(data?.category).toBe("movies");
  expect(data?.tags).toEqual(["keep"]);
  await expect(
    page
      .getByRole("complementary", { name: "Sidebar" })
      .getByRole("button", { name: /^movies\s*1$/ }),
  ).toBeVisible();

  // Start from the header.
  await details.getByRole("button", { name: "Start" }).click();
  await expect(details.getByText("Fetching metadata")).toBeVisible();
});
