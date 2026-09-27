// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The command palette (Command palette ⌘K) against a real daemon: torrents
// by the daemon's search, a removed one from the statistics, files across
// torrents, commands with their keys; and the light theme it switches to,
// kept by the daemon and checked with axe.

import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

test("the palette finds torrents, removed ones, files and commands", async ({
  signedIn: page,
  daemon,
}) => {
  test.setTimeout(120_000);
  const kept = makeTorrent({
    name: "Kept_Show_e2e",
    files: [
      { path: "s01/e01.mkv", size: 40_000 },
      { path: "s01/e02.mkv", size: 40_000 },
      { path: "readme.txt", size: 1_000 },
    ],
    pieceLength: 16_384,
  });
  kept.writeContent(daemon.savePath);
  await daemon.api.POST("/api/v1/torrents", { body: { torrents: [kept.base64] } });
  const gone = makeTorrent({ name: "Gone_Show_e2e", size: 64 * 1024, pieceLength: 16_384 });
  await daemon.api.POST("/api/v1/torrents", {
    body: { torrents: [gone.base64], options: { stopped: true } },
  });
  await daemon.waitFor(kept.hash, (x) => x.state === "seeding", "a seed");
  await daemon.api.POST("/api/v1/torrents/delete", {
    body: { hashes: [gone.hash], delete_files: false },
  });
  await expect
    .poll(async () =>
      (
        await daemon.api.GET("/api/v1/stats/torrents", { params: { query: { removed: true } } })
      ).data?.map((r) => r.name),
    )
    .toEqual(["Gone_Show_e2e"]);

  await page.goto(`${daemon.url}/torrents`);
  await expect(page.getByRole("heading", { name: "All torrents", level: 1 })).toBeVisible();
  const palette = page.getByRole("dialog", { name: "Command palette" });
  const input = palette.getByRole("combobox");
  const results = palette.getByRole("listbox", { name: "Results" });

  // Torrents, the one in the session and the removed one.
  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("show e2e");
  const torrents = results.getByRole("group", { name: "Torrents" });
  await expect(torrents.getByRole("option", { name: /^Kept_Show_e2e/ })).toBeVisible();
  await expect(torrents.getByRole("option", { name: /^Gone_Show_e2e/ })).toContainText(
    "history only",
  );
  await expect(palette).toContainText("1 torrent · 3 files indexed");
  await expectAccessible(page);
  await input.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/torrents/${kept.hash}`));
  await expect(palette).toBeHidden();

  // Files, by their prefix and wildcards; one opens its torrent's Files tab.
  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("f e0? mkv");
  await expect(palette.getByRole("radio", { name: /^Files/ })).toHaveAttribute(
    "aria-checked",
    "true",
  );
  const files = results.getByRole("group", { name: "Files" });
  await expect(files.getByRole("option")).toHaveCount(2);
  await input.press("ArrowDown");
  await expect(files.getByRole("option").nth(1)).toHaveAttribute("aria-selected", "true");
  await input.press("Enter");
  await expect(page).toHaveURL(new RegExp(`/torrents/${kept.hash}\\?tab=files`));

  // A removed torrent opens its history.
  await page.keyboard.press("ControlOrMeta+k");
  await input.fill("gone show");
  await torrents.getByRole("option", { name: /^Gone_Show_e2e/ }).click();
  await expect(page).toHaveURL(new RegExp(`/stats/timeline\\?hash=${gone.hash}`));

  // Commands and their keys: , opens Settings, ⌥S switches the limits.
  await page.goto(`${daemon.url}/torrents`);
  await expect(page.getByRole("heading", { name: "All torrents", level: 1 })).toBeVisible();
  await page.keyboard.press(",");
  await expect(page).toHaveURL(/\/settings\/speed/);
  await page.keyboard.press("Alt+s");
  await expect
    .poll(async () => (await daemon.api.GET("/api/v1/transfer")).data?.alt_speed_enabled)
    .toBe(true);
  await page.keyboard.press("ControlOrMeta+k");
  await input.fill(">alternative");
  await expect(results.getByRole("option", { name: /^Toggle alternative/ })).toContainText(
    "currently on",
  );
  await input.press("Enter");
  await expect
    .poll(async () => (await daemon.api.GET("/api/v1/transfer")).data?.alt_speed_enabled)
    .toBe(false);
});

test("the light theme: chosen, kept by the daemon, accessible", async ({
  signedIn: page,
  daemon,
}) => {
  test.setTimeout(120_000);
  const t = makeTorrent({ name: "Light_e2e", size: 64 * 1024, pieceLength: 16_384 });
  t.writeContent(daemon.savePath);
  await daemon.api.POST("/api/v1/torrents", { body: { torrents: [t.base64] } });
  await daemon.waitFor(t.hash, (x) => x.state === "seeding", "a seed");
  await page.goto(`${daemon.url}/torrents`);
  await expect(page.getByRole("heading", { name: "All torrents", level: 1 })).toBeVisible();
  const html = page.locator("html");
  // The suite's browser prefers dark, and the theme follows it.
  await expect(html).toHaveAttribute("data-theme", "dark");

  await page.keyboard.press("ControlOrMeta+k");
  const palette = page.getByRole("dialog", { name: "Command palette" });
  await palette.getByRole("combobox").fill(">theme");
  await palette.getByRole("option", { name: /^Theme: Light/ }).click();
  await expect(html).toHaveAttribute("data-theme", "light");
  await expect
    .poll(
      async () =>
        (
          await daemon.api.GET("/api/v1/client-data", {
            params: { query: { keys: "webui.theme" } },
          })
        ).data?.["webui.theme"],
    )
    .toBe("light");

  // Every kind of page, in the light theme.
  for (const path of [
    `/torrents/${t.hash}`,
    "/stats",
    "/stats/peers",
    "/rss",
    "/log",
    "/settings/downloads",
    "/settings/security",
  ]) {
    await page.goto(`${daemon.url}${path}`);
    await expect(html).toHaveAttribute("data-theme", "light");
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expectAccessible(page);
  }

  // Back to the system's from the instance menu.
  await page.getByRole("button", { name: /instance menu$/ }).click();
  await page.getByRole("menuitem", { name: "Theme" }).click();
  await page.getByRole("menuitemradio", { name: "Match the system" }).click();
  await expect(html).toHaveAttribute("data-theme", "dark");
});
