// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The shell where nothing was designed (AGENTS.md 6.4): the bar while the
// daemon is away, and the card when a page's code no longer loads because
// the daemon serves a newer UI.

import { expect, expectAccessible, test } from "./fixtures";

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
