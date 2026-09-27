// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Categories and tags managed from the torrents screen's sidebar, against a
// real daemon (AGENTS.md 7.4): made from the "+" beside each title, edited
// and removed from a row's menu after a question that counts the torrents
// concerned, and a filter on one that goes away goes with it.

import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

test("categories and tags are made, edited and removed from the sidebar", async ({
  signedIn: page,
  daemon,
}) => {
  await daemon.api.POST("/api/v1/categories", {
    body: { name: "linux", save_path: null, download_path: null },
  });
  for (const name of ["one-e2e.bin", "two-e2e.bin"]) {
    const t = makeTorrent({ name, size: 64 * 1024, pieceLength: 16_384 });
    await daemon.api.POST("/api/v1/torrents", {
      body: { torrents: [t.base64], options: { stopped: true, category: "linux", tags: ["keep"] } },
    });
  }
  const tags = async () => (await daemon.api.GET("/api/v1/tags")).data ?? [];
  const categories = async () => (await daemon.api.GET("/api/v1/categories")).data ?? {};
  const sidebar = page.getByRole("complementary", { name: "Sidebar" });

  // A new tag from the "+".
  const tagList = sidebar.getByRole("region", { name: "Tags" });
  await tagList.getByRole("button", { name: "New tag" }).click();
  const named = page.getByRole("dialog", { name: "New tag" });
  await named.getByLabel("Tag").fill("archive");
  await expectAccessible(page);
  await named.getByRole("button", { name: "Create tag" }).click();
  await expect.poll(tags).toContain("archive");
  await expect(tagList.getByRole("button", { name: /^archive/ })).toBeVisible();

  // Deleting the tag in use as the filter: asked first, then the filter goes too.
  await tagList.getByRole("button", { name: /^keep/ }).click();
  await expect(page).toHaveURL(/tag=keep/);
  await tagList.getByRole("button", { name: "Tag keep: actions" }).click();
  await page.getByRole("menuitem", { name: "Delete tag…" }).click();
  const ask = page.getByRole("alertdialog", { name: "Delete tag keep?" });
  await expect(ask).toContainText("It comes off the 2 torrents that have it.");
  await expectAccessible(page);
  await ask.getByRole("button", { name: "Delete tag" }).click();
  await expect.poll(tags).toEqual(["archive"]);
  await expect(page).not.toHaveURL(/tag=/);
  const rows = (await daemon.api.GET("/api/v1/torrents")).data ?? [];
  expect(rows.map((t) => t.tags)).toEqual([[], []]);

  // A category's dialog from its row.
  const catList = sidebar.getByRole("region", { name: "Categories" });
  await catList.getByRole("button", { name: "Category linux: actions" }).click();
  await page.getByRole("menuitem", { name: "Edit category…" }).click();
  const edit = page.getByRole("dialog", { name: "Edit category — linux" });
  await expect(edit).toContainText("2 torrents");
  await edit.getByLabel("Save path", { exact: true }).fill("iso");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect.poll(async () => (await categories()).linux?.save_path).toBe("iso");

  // Removing it asks alone; keeping it closes the question and nothing else opens.
  await catList.getByRole("button", { name: /^linux/ }).click();
  await expect(page).toHaveURL(/category=linux/);
  await catList.getByRole("button", { name: "Category linux: actions" }).click();
  await page.getByRole("menuitem", { name: "Remove category…" }).click();
  const remove = page.getByRole("alertdialog", { name: "Remove category linux?" });
  await expect(remove).toContainText("Its 2 torrents lose the category");
  await remove.getByRole("button", { name: "Keep it" }).click();
  await expect(remove).toBeHidden();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await catList.getByRole("button", { name: "Category linux: actions" }).click();
  await page.getByRole("menuitem", { name: "Remove category…" }).click();
  await remove.getByRole("button", { name: "Remove" }).click();
  await expect.poll(async () => Object.keys(await categories())).toEqual([]);
  await expect(page).not.toHaveURL(/category=/);

  // A new category from the "+".
  await catList.getByRole("button", { name: "New category" }).click();
  const add = page.getByRole("dialog", { name: "Add category" });
  await add.getByLabel("Name").fill("tv");
  await add.getByRole("button", { name: "Add category" }).click();
  await expect.poll(async () => Object.keys(await categories())).toEqual(["tv"]);
  await expect(catList.getByRole("button", { name: /^tv/ })).toBeVisible();
});
