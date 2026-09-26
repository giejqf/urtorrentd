// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Several torrents at once against a real daemon (AGENTS.md 7.4): chosen
// with ⌘/Ctrl-click, set from the panel and the selection bar, their share
// limits from the dialog, moved together, the list's keys, and removed with
// their files after the question.

import { existsSync } from "node:fs";
import { join } from "node:path";

import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

test("choose several torrents, set them, move them, remove them", async ({
  signedIn: page,
  daemon,
}) => {
  test.setTimeout(120_000);
  const ts = ["alpha-e2e.bin", "beta-e2e.bin", "gamma-e2e.bin"].map((name) =>
    makeTorrent({ name, size: 128 * 1024, pieceLength: 16_384 }),
  );
  for (const t of ts) {
    t.writeContent(daemon.savePath);
    await daemon.api.POST("/api/v1/torrents", {
      body: { torrents: [t.base64], options: { tags: t.name.startsWith("beta") ? ["keep"] : [] } },
    });
    await daemon.waitFor(t.hash, (x) => x.state === "seeding", "a seed");
  }
  const [alpha, beta] = ts;
  if (!alpha || !beta) throw new Error("torrents");
  const row = async (hash: string) =>
    (await daemon.api.GET("/api/v1/torrents/{hash}", { params: { path: { hash } } })).data;

  const list = page.getByRole("listbox", { name: "Torrents" });
  await list.getByRole("option", { name: /^alpha-e2e\.bin/ }).click();
  await list
    .getByRole("option", { name: /^beta-e2e\.bin/ })
    .click({ modifiers: ["ControlOrMeta"] });
  const panel = page.getByRole("region", { name: "2 torrents selected" });
  await expect(panel).toContainText("On disk");
  await expect(panel).toContainText("Actions on both");
  await expect(panel).toContainText("All idle");
  await expectAccessible(page);

  // The selection bar: a new category for both.
  const bar = page.getByRole("toolbar", { name: "Selected torrents" });
  await expect(bar).toContainText("2 selected");
  await bar.getByRole("button", { name: "Category" }).click();
  await page.getByRole("menuitem", { name: "New category…" }).click();
  const named = page.getByRole("dialog", { name: "New category" });
  await named.getByLabel("Name").fill("linux");
  await named.getByRole("button", { name: "Create and set" }).click();
  await expect.poll(async () => (await row(alpha.hash))?.category).toBe("linux");
  expect((await row(beta.hash))?.category).toBe("linux");

  // The panel: tags, the upload limit and share limits for both.
  await expect(panel).toContainText("1 of 2");
  await panel.getByRole("button", { name: "Add to all" }).click();
  await page.getByRole("menuitemcheckbox", { name: "keep" }).click();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await row(alpha.hash))?.tags).toEqual(["keep"]);
  await panel.getByLabel("Upload limit").fill("300");
  await panel.getByLabel("Upload limit").press("Enter");
  await expect.poll(async () => (await row(beta.hash))?.upload_limit).toBe(300_000);
  await panel
    .getByRole("radiogroup", { name: "Share limits for all" })
    .getByRole("radio", { name: "∞" })
    .click();
  await expect.poll(async () => (await row(alpha.hash))?.share_limits.ratio.mode).toBe("unlimited");
  await panel.getByRole("radio", { name: "Own…" }).click();
  const limits = page.getByRole("dialog", { name: "Share limits" });
  await expect(limits).toContainText("2 torrents");
  await limits.getByLabel("Ratio limit").fill("1.5");
  await expectAccessible(page);
  await limits.getByRole("button", { name: "Save" }).click();
  await expect
    .poll(async () => (await row(beta.hash))?.share_limits.ratio)
    .toEqual({ mode: "limit", value: 1.5 });

  // Move both: where it goes, the free space there, then the move.
  await panel.getByRole("button", { name: "Move all…" }).click();
  const move = page.getByRole("dialog", { name: "Move content" });
  await expect(move).toContainText("2 torrents");
  const target = join(daemon.savePath, "moved");
  await move.getByLabel("New location").fill(target);
  await expect(move).toContainText("free");
  await expectAccessible(page);
  await move.getByRole("button", { name: "Move", exact: true }).click();
  await expect.poll(async () => (await row(alpha.hash))?.save_path).toBe(target);
  await expect.poll(async () => (await row(beta.hash))?.state).toBe("seeding");
  expect(existsSync(join(target, "beta-e2e.bin"))).toBe(true);
  expect((await row(beta.hash))?.auto_management).toBe(false);

  // The list's keys: M moves, L sets share limits (each asks first).
  await list.focus();
  await page.keyboard.press("m");
  await expect(move).toBeVisible();
  await move.getByRole("button", { name: "Cancel" }).click();
  await list.focus();
  await page.keyboard.press("l");
  await expect(limits).toBeVisible();
  await limits.getByRole("button", { name: "Cancel" }).click();

  // The context menu has what the keys do.
  await list.getByRole("option", { name: /^alpha-e2e\.bin/ }).click({ button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toContainText("2 torrents");
  await expect(menu.getByRole("menuitem", { name: /^Move location…/ })).toBeVisible();
  await page.keyboard.press("Escape");

  // Remove both with their files: named, the kept ones said, then gone.
  await bar.getByRole("button", { name: "Remove…" }).click();
  const ask = page.getByRole("alertdialog", { name: "Remove 2 torrents?" });
  await expect(ask.getByRole("list", { name: "Torrents to remove" })).toContainText(
    "alpha-e2e.bin",
  );
  await expect(ask).toContainText("2 of them are tagged keep");
  await ask.getByRole("checkbox", { name: "Also delete the files on disk" }).focus();
  await page.keyboard.press("Space");
  await expect(ask).toContainText(`under ${target}`);
  await expectAccessible(page);
  await ask.getByRole("button", { name: /^Remove 2 and delete / }).click();
  await expect
    .poll(async () => (await daemon.api.GET("/api/v1/torrents")).data?.map((t) => t.name))
    .toEqual(["gamma-e2e.bin"]);
  await expect.poll(() => existsSync(join(target, "alpha-e2e.bin"))).toBe(false);
  await expect(bar).toBeHidden();
});
