// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The add dialog against real daemons (AGENTS.md 7.4): the daemon's preview
// of a magnet (fetched from a seeder), per-file choices and options that
// arrive as they were set, duplicates and failures, previews dropped on
// cancel, a watch folder that picks up a .torrent, and browsing the
// daemon's folders.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

test("a magnet's preview, file choices and options arrive as set", async ({
  signedIn: page,
  daemon,
  seeder,
}) => {
  const t = makeTorrent({
    name: "album",
    files: [
      { path: "01.flac", size: 96 * 1024 },
      { path: "02.flac", size: 64 * 1024 },
    ],
    pieceLength: 16_384,
  });
  t.writeContent(seeder.savePath);
  await seeder.api.POST("/api/v1/torrents", { body: { torrents: [t.base64] } });
  await seeder.waitFor(t.hash, (x) => x.state === "seeding", "the seeder to seed");
  await daemon.api.POST("/api/v1/categories", {
    body: { name: "music", save_path: null, download_path: null },
  });

  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add torrents" });
  // Nothing the API cannot back (AGENTS.md 6.4).
  await expect(dialog.getByText("Skip hash check")).toHaveCount(0);
  const magnet = `magnet:?xt=urn:btih:${t.hash}&dn=album&x.pe=${await seeder.peerAddress()}`;
  await dialog.getByLabel("Sources").fill(magnet);

  // The daemon fetches the metadata from the seeder: the preview fills in.
  await expect(dialog.getByText("ready", { exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(dialog.getByRole("heading", { name: "album" })).toBeVisible();
  await expect(dialog.getByText(`${t.pieces} × 16 KiB`)).toBeVisible();
  await expect(dialog.getByText("1 sources · metadata fetched for 1")).toBeVisible();
  await expectAccessible(page);

  // Skip the second file; the first one first.
  const second = dialog.getByRole("checkbox", { name: "Download album/02.flac" });
  await second.focus();
  await page.keyboard.press("Space");
  await expect(second).not.toBeChecked();
  await dialog.getByRole("button", { name: /^Priority of album\/01\.flac/ }).click();
  await page.getByRole("menuitemradio", { name: "High" }).click();
  await expect(dialog.getByText("98.3 kB selected")).toBeVisible();

  // Options.
  await dialog.getByRole("button", { name: /^Category/ }).click();
  await page.getByRole("option", { name: "music" }).click();
  await dialog.getByLabel("Tags").fill("flac, keep");
  await expect(dialog.getByLabel("Tags")).toHaveValue("");
  await expect(dialog.getByRole("button", { name: "Remove tag keep" })).toBeVisible();
  await dialog.getByText("Start immediately", { exact: true }).click();
  await dialog.getByLabel("Upload limit").fill("5000");
  await expect(dialog.getByLabel("Ratio limit")).toBeDisabled();
  await dialog.getByText("Use category share limits", { exact: true }).click();
  await dialog.getByLabel("Ratio limit").fill("2.5");
  await dialog.getByRole("button", { name: "Add 1 torrent" }).click();
  await expect(dialog).toBeHidden();

  const row = page.getByRole("option", { name: /album/ });
  await expect(row).toBeVisible();
  const { data: t1 } = await daemon.api.GET("/api/v1/torrents/{hash}", {
    params: { path: { hash: t.hash } },
  });
  expect(t1?.category).toBe("music");
  expect(t1?.tags).toEqual(["flac", "keep"]);
  expect(t1?.state).toBe("stopped");
  expect(t1?.upload_limit).toBe(5_000_000);
  expect(t1?.share_limits.ratio).toEqual({ mode: "limit", value: 2.5 });
  const { data: files } = await daemon.api.GET("/api/v1/torrents/{hash}/files", {
    params: { path: { hash: t.hash } },
  });
  expect(files?.map((f) => f.priority)).toEqual([6, 0]);
  // The preview was used by the add: none is left.
  const { data: previews } = await daemon.api.GET("/api/v1/previews");
  expect(previews).toEqual([]);
});

test("duplicates and failures are told apart and skipped", async ({ signedIn: page, daemon }) => {
  const known = "6".repeat(40);
  await daemon.api.POST("/api/v1/torrents", {
    body: { urls: [known], options: { stopped: true } },
  });
  await expect(page.getByRole("option")).toHaveCount(1);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add torrents" });
  await dialog
    .getByLabel("Sources")
    .fill([known, "http://127.0.0.1:9/nothing.torrent", "7".repeat(40), "not a link"].join("\n"));
  await expect(dialog.getByText("added already")).toBeVisible();
  await expect(dialog.getByText("failed", { exact: true })).toBeVisible();
  await expect(dialog.getByText("1 lines are not sources")).toBeVisible();
  // Only the new info-hash goes in; the failed one stays, with the reason.
  await dialog.getByRole("button", { name: "Add 1 torrent" }).click();
  await expect
    .poll(async () => (await daemon.api.GET("/api/v1/torrents")).data?.map((t) => t.hash).sort())
    .toEqual([known, "7".repeat(40)]);
  await expect(dialog.getByText("failed", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("closing without adding drops the previews", async ({ signedIn: page, daemon }) => {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add torrents" });
  await dialog.getByLabel("Sources").fill(`magnet:?xt=urn:btih:${"8".repeat(40)}&dn=lonely`);
  await expect(dialog.getByText("fetching", { exact: true })).toBeVisible();
  await expect.poll(async () => (await daemon.api.GET("/api/v1/previews")).data?.length).toBe(1);
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect.poll(async () => (await daemon.api.GET("/api/v1/previews")).data?.length).toBe(0);
});

test("a watch folder picks up its .torrent files with the options", async ({
  signedIn: page,
  daemon,
}) => {
  const folder = join(dirname(daemon.savePath), "watched");
  mkdirSync(folder, { recursive: true });
  const t = makeTorrent({ name: "dropped.bin", size: 64 * 1024 });
  writeFileSync(join(folder, "dropped.torrent"), t.bytes);

  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add torrents" });
  await dialog.getByRole("tab", { name: "Watch folder" }).click();
  await dialog.getByLabel("Folder to watch", { exact: true }).fill(folder);
  await expect(dialog.getByText("1 files to add once it is watched")).toBeVisible();
  await expect(dialog.getByText("dropped.torrent")).toBeVisible();
  await dialog.getByLabel("Tags").fill("watched");
  await dialog.getByText("Start immediately", { exact: true }).click();
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Watch this folder" }).click();
  await expect(dialog).toBeHidden();

  const { data: settings } = await daemon.api.GET("/api/v1/settings");
  expect(settings?.watch_folders.map((w) => [w.path, w.after_add])).toEqual([[folder, "rename"]]);
  // The daemon adds the file once it has settled, and renames it.
  const row = page.getByRole("option", { name: /dropped\.bin/ });
  await expect(row).toBeVisible({ timeout: 30_000 });
  const { data } = await daemon.api.GET("/api/v1/torrents/{hash}", {
    params: { path: { hash: t.hash } },
  });
  expect(data?.tags).toEqual(["watched"]);
  expect(data?.state).toBe("stopped");
  await expect.poll(() => existsSync(join(folder, "dropped.torrent.added"))).toBe(true);
});

test("browse the daemon's folders for the save path", async ({ signedIn: page, daemon }) => {
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add torrents" });
  await expect(dialog.getByLabel("Save path", { exact: true })).toHaveValue(daemon.savePath);
  await dialog.getByRole("button", { name: "Browse for the save path" }).click();
  const picker = page.getByRole("dialog", { name: "Choose a folder" });
  await expect(picker).toContainText("free of");
  // It opens at the save path, or its nearest existing parent.
  await picker
    .getByRole("navigation", { name: "Where" })
    .getByRole("button", { name: basename(dirname(daemon.savePath)), exact: true })
    .click();
  await expect(picker.getByRole("button", { name: /^\.\. parent$/ })).toBeVisible();
  const data = picker.getByRole("option", { name: /^data / });
  await expect(data).toContainText("writable");
  await data.click();
  await expectAccessible(page);
  await picker.getByRole("button", { name: /^Choose \// }).click();
  await expect(dialog.getByLabel("Save path", { exact: true })).toHaveValue(
    join(dirname(daemon.savePath), "data"),
  );
});
