// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Queue & share limits against a real daemon (AGENTS.md 7.4):
// queue limits saved and shown against the torrents that hold slots, a
// torrent moved up the queue, and share limits in the API's units with the
// seeding torrents measured against them.

import type { Page } from "@playwright/test";

import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

/** A setting's field by its label; a changed one is also "(not saved)". */
function field(page: Page, label: string) {
  return page.getByLabel(new RegExp(`^${label}( \\(not saved\\))?$`));
}

test("queue limits, the slots they hand out, and moving a torrent", async ({
  signedIn: page,
  daemon,
}) => {
  // Two downloads with no peer: slow, so they hold a slot only while slow
  // torrents count.
  const a = makeTorrent({ name: "first-in-queue.bin", size: 256 * 1024, pieceLength: 65_536 });
  const b = makeTorrent({ name: "second-in-queue.bin", size: 256 * 1024, pieceLength: 65_536 });
  await daemon.api.POST("/api/v1/torrents", { body: { torrents: [a.base64, b.base64] } });

  await page.goto(`${daemon.url}/settings/queue`);
  await expect(page.getByRole("heading", { name: "Queue & share limits", level: 1 })).toBeVisible();
  const now = page.getByRole("region", { name: "The queue right now" });
  await expect(now).toContainText("queueing off: every started torrent runs");

  await page.getByText("Limit how many torrents are active at once", { exact: true }).click();
  await field(page, "Active downloads").fill("1");
  await page.getByText("Count slow torrents", { exact: true }).click();
  const bar = page.getByRole("region", { name: "Unsaved changes" });
  await expect(bar).toContainText("queueing_enabled · max_active_downloads · count_slow_torrents");
  // The picture follows the draft before saving: two hold slots, one is over.
  await expect(now).toContainText("2 of 1 used · 2 slow · 1 over");
  await expectAccessible(page);
  await page.keyboard.press("Control+s");
  await expect(bar).toBeHidden();
  const { data } = await daemon.api.GET("/api/v1/settings");
  expect(data).toMatchObject({
    queueing_enabled: true,
    max_active_downloads: 1,
    count_slow_torrents: true,
  });

  // The daemon queues the second.
  await expect(now).toContainText("1 of 1 used · 1 slow · 1 waiting");
  const second = page.getByRole("row", { name: /second-in-queue\.bin/ });
  await expect(second).toContainText("waiting for a download slot");
  await expect(second).toContainText("Queued");

  // Up the queue it takes the slot, and the first waits.
  await page.getByRole("button", { name: "Move second-in-queue.bin up" }).click();
  await expect(second).toContainText("download slot");
  await expect(page.getByRole("row", { name: /first-in-queue\.bin/ })).toContainText(
    "waiting for a download slot",
  );
  const positions = await daemon.api.GET("/api/v1/torrents");
  expect(Object.fromEntries((positions.data ?? []).map((t) => [t.name, t.queue_position]))).toEqual(
    { "second-in-queue.bin": 0, "first-in-queue.bin": 1 },
  );
});

test("share limits in the API's units, against the seeding torrents", async ({
  signedIn: page,
  daemon,
}) => {
  const t = makeTorrent({ name: "long-seed.bin", size: 256 * 1024, pieceLength: 65_536 });
  t.writeContent(daemon.savePath);
  await daemon.api.POST("/api/v1/torrents", { body: { torrents: [t.base64] } });
  await daemon.waitFor(t.hash, (x) => x.state === "seeding", "the torrent to seed");

  await page.goto(`${daemon.url}/settings/queue`);
  const seeds = page.getByRole("region", { name: "Seeding torrents against these limits" });
  const row = seeds.getByRole("row", { name: /long-seed\.bin/ });
  await expect(row).toContainText("no limits");

  await field(page, "Ratio").fill("1,5");
  await expect(
    page.getByRole("alert").filter({ hasText: "A ratio such as 2 or 1.5" }),
  ).toBeVisible();
  await field(page, "Ratio").fill("2");
  await field(page, "Seeding time").fill("1.5");
  // Measured against the draft before it is saved.
  await expect(row).toContainText("0.00 / 2.0");
  await expect(row).toContainText(/seeding time in ~1d 11h → stop/);
  // Idle, it reaches a shorter inactive limit first.
  await field(page, "Inactive seeding time").fill("12");
  await page.getByRole("button", { name: "Inactive seeding time unit" }).click();
  await page.getByRole("option", { name: "hours" }).click();
  await page.getByRole("radio", { name: "Remove with files" }).click();
  await expect(row).toContainText(/inactive time in ~11h 5\dm → remove with files/);
  await expectAccessible(page);

  await page.getByRole("button", { name: /Save changes/ }).click();
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toBeHidden();
  const { data } = await daemon.api.GET("/api/v1/settings");
  expect(data).toMatchObject({
    max_ratio: 2,
    max_seeding_time: 129_600,
    max_inactive_seeding_time: 43_200,
    share_limit_action: "remove_with_files",
  });

  // A torrent's own limits win, and say so.
  await daemon.api.POST("/api/v1/torrents/share-limits", {
    body: {
      hashes: [t.hash],
      share_limits: {
        ratio: { mode: "unlimited" },
        seeding_time: { mode: "unlimited" },
        inactive_seeding_time: { mode: "unlimited" },
        action: null,
      },
    },
  });
  await expect(row).toContainText("own");
  await expect(row).toContainText("no limits");
});
