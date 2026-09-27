// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The shell where nothing was designed (AGENTS.md 6.3, 6.4): a phone's
// two-line rows, the bar while the daemon is away, and the card when a
// page's code no longer loads because the daemon serves a newer UI.

import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

test("on a phone: rows on two lines, the details over the list", async ({
  signedIn: page,
  daemon,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const t = makeTorrent({ name: "phone-e2e.bin", size: 128 * 1024, pieceLength: 16_384 });
  await daemon.api.POST("/api/v1/torrents", {
    body: { torrents: [t.base64], options: { stopped: true } },
  });
  await daemon.waitFor(t.hash, (x) => x.state === "stopped", "stopped");
  await page.goto(`${daemon.url}/torrents`);
  const row = page
    .getByRole("listbox", { name: "Torrents" })
    .getByRole("option", { name: /^phone-e2e\.bin/ });
  await expect(row).toContainText("0.0%");
  await expect(row).toContainText("Stopped");
  await expect(row).toContainText(/131 kB/);
  await expect(row.getByText("phone-e2e.bin", { exact: true })).toBeInViewport();
  expect((await row.boundingBox())?.height).toBe(52);
  // The header's buttons keep their names without their words.
  await expect(page.getByRole("button", { name: "Filter" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Display" })).toBeVisible();
  await expectAccessible(page);

  await row.click();
  const details = page.getByRole("region", { name: "Details of phone-e2e.bin" });
  await expect(details).toBeVisible();
  // The whole width but the sheet's border.
  expect((await details.boundingBox())?.width).toBeGreaterThanOrEqual(388);
});

test("while the daemon is away, the page says since when it shows", async ({
  signedIn: page,
  daemon,
}) => {
  await page.goto(`${daemon.url}/torrents`);
  await expect(page.getByRole("status", { name: "Connected to the daemon" })).toBeVisible();
  await daemon.stop();
  const bar = page
    .getByRole("status")
    .filter({ hasText: /Reconnecting to the daemon|The daemon cannot be reached/ });
  await expect(bar).toContainText(/What is shown is as of \d\d:\d\d:\d\d/, { timeout: 20_000 });
  await expect(bar.getByRole("button", { name: "Try now" })).toBeVisible();
  await expectAccessible(page);
});

test("a page whose code no longer loads offers a reload", async ({ signedIn: page, daemon }) => {
  await page.goto(`${daemon.url}/stats`);
  await expect(page.getByRole("heading", { name: "Statistics", level: 1 })).toBeVisible();
  // The build the page came from is gone: its chunks no longer load.
  await page.route("**/assets/timeline-*.js", (route) => route.abort());
  await page.getByRole("link", { name: "Timeline", exact: true }).click();
  const card = page.getByRole("alert").filter({ hasText: "The web UI was updated" });
  await expect(card).toBeVisible();
  // The sidebar still works around it.
  await expect(page.getByRole("link", { name: "Torrents", exact: true })).toBeVisible();
  await expectAccessible(page);

  await page.unroute("**/assets/timeline-*.js");
  await card.getByRole("button", { name: "Reload" }).click();
  await expect(page.getByRole("heading", { name: "Timeline", level: 1 })).toBeVisible();
});
