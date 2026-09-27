// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// A phone (Torrents — phone, Torrent — phone; AGENTS.md 6.3): the list with
// its status chips, one torrent on the whole screen with its actions below,
// the tab bar, and every page within the width.

import { SECTIONS } from "../src/features/settings/nav-sections";
import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

test("the list, one torrent and the tab bar, as designed", async ({ signedIn: page, daemon }) => {
  const seed = makeTorrent({ name: "seeded-e2e.bin", size: 128 * 1024, pieceLength: 16_384 });
  seed.writeContent(daemon.savePath);
  await daemon.api.POST("/api/v1/torrents", { body: { torrents: [seed.base64] } });
  const t = makeTorrent({ name: "phone-e2e.bin", size: 128 * 1024, pieceLength: 16_384 });
  await daemon.api.POST("/api/v1/torrents", {
    body: { torrents: [t.base64], options: { stopped: true } },
  });
  await daemon.waitFor(t.hash, (x) => x.state === "stopped", "stopped");
  await daemon.waitFor(seed.hash, (x) => x.state === "seeding", "a seed");
  await page.goto(`${daemon.url}/torrents`);

  // The header: the view, the instance and the count; the chips below.
  await expect(page.getByRole("heading", { name: "All torrents", level: 1 })).toBeVisible();
  await expect(page.getByText("urtorrentd · 2 torrents")).toBeVisible();
  const chips = page.getByRole("radiogroup", { name: "Status" });
  await chips.getByRole("radio", { name: /^Stopped/ }).click();
  await expect(page.getByRole("heading", { name: "Stopped", level: 1 })).toBeVisible();
  const list = page.getByRole("listbox", { name: "Torrents" });
  await expect(list.getByRole("option")).toHaveCount(1);
  const row = list.getByRole("option", { name: /^phone-e2e\.bin/ });
  await expect(row).toContainText("131 kB");
  await expect(row).toContainText("0%");
  expect((await row.boundingBox())?.height).toBe(60);
  await chips.getByRole("radio", { name: /^All/ }).click();
  await expect(list.getByRole("option")).toHaveCount(2);
  const tabs = page.getByRole("navigation", { name: "Sections" });
  await expect(tabs.getByRole("link", { name: "Torrents" })).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expectAccessible(page);
  // Filter and Display are one menu.
  await page.getByRole("button", { name: "Filter and display" }).click();
  await expect(page.getByRole("menuitemcheckbox", { name: "Group by state" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);

  // One torrent on the whole screen, its actions below, the tabs in "more".
  await row.click();
  const details = page.getByRole("region", { name: "Details of phone-e2e.bin" });
  await expect(details).toBeVisible();
  expect((await details.boundingBox())?.width).toBe(390);
  await expect(tabs).toBeHidden();
  await expect(details.getByRole("region", { name: "Transfer" })).toContainText("Wasted");
  await expectAccessible(page);
  await details.getByRole("button", { name: "Start", exact: true }).click();
  await expect
    .poll(
      async () =>
        (await daemon.api.GET("/api/v1/torrents/{hash}", { params: { path: { hash: t.hash } } }))
          .data?.state,
    )
    .not.toBe("stopped");
  await details.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page).toHaveURL(/tab=files/);
  await expect(details.getByRole("table", { name: "Files" })).toBeVisible();
  await details.getByRole("button", { name: "Back to the overview" }).click();
  await details.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Trackers" }).click();
  await expect(page).toHaveURL(/tab=trackers/);
  await details.getByRole("button", { name: "Back to the overview" }).click();
  await expect(page).not.toHaveURL(/tab=/);
  await details.getByRole("button", { name: "Back to the list" }).click();
  await expect(details).toBeHidden();

  // The tab bar: add, search, settings.
  await tabs.getByRole("button", { name: "Add torrents" }).click();
  await expect(page.getByRole("dialog", { name: "Add torrents" })).toBeVisible();
  await page.keyboard.press("Escape");
  await tabs.getByRole("button", { name: "Search" }).click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape");
  await tabs.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings\//);
  await expect(tabs.getByRole("link", { name: "Settings" })).toHaveAttribute(
    "aria-current",
    "page",
  );
});

/** Visible elements past the right edge that no scrolling box inside the screen holds. */
function overflowing(): string[] {
  const w = window.innerWidth;
  const out: string[] = [];
  for (const el of document.querySelectorAll("body *")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || r.right <= w + 1) continue;
    let held = false;
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const x = getComputedStyle(p).overflowX;
      if (x !== "visible" && p.getBoundingClientRect().right <= w + 1) {
        held = true;
        break;
      }
    }
    if (!held) out.push(`${el.tagName.toLowerCase()} ${el.textContent?.slice(0, 40) ?? ""}`);
  }
  return out.slice(0, 5);
}

test("every page fits a phone's width", async ({ signedIn: page, daemon }) => {
  test.setTimeout(120_000);
  const pages = [
    "/torrents",
    "/stats",
    "/stats/trackers",
    "/stats/peers",
    "/stats/idle-seeds",
    "/stats/timeline",
    "/rss",
    "/log",
    ...SECTIONS.flatMap((g) => g.items.map((i) => `/settings/${i.id}`)),
  ];
  for (const path of pages) {
    await page.goto(`${daemon.url}${path}`);
    await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
    await expect.poll(() => page.evaluate(overflowing), { message: path }).toEqual([]);
  }
});
