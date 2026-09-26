// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Speed against a real daemon (AGENTS.md 7.4): a draft saved in
// the API's units, discarded, kept from an accidental leave; the schedule;
// the alternative limits switched at once; and a restart that applies an
// engine setting.

import type { Page } from "@playwright/test";

import { CREDENTIALS } from "./daemon";
import { expect, expectAccessible, test } from "./fixtures";

/** A setting's field by its label; a changed one is also "(not saved)". */
function field(page: Page, label: string) {
  return page.getByLabel(new RegExp(`^${label}( \\(not saved\\))?$`));
}

test("the speed page saves what changed, in the API's units", async ({
  signedIn: page,
  daemon,
}) => {
  await page.getByRole("link", { name: "Settings" }).click();
  await expect(page).toHaveURL(/\/settings\/speed$/);
  await expect(page.getByRole("heading", { name: "Speed", level: 1 })).toBeVisible();
  await expectAccessible(page);

  const bar = page.getByRole("region", { name: "Unsaved changes" });
  await field(page, "Upload limit").fill("12 000");
  await field(page, "Upload slots per torrent").fill("4");
  await expect(bar).toContainText("2 unsaved changes");
  await expect(bar).toContainText("upload_limit · max_uploads_per_torrent");
  // Discard puts the saved values back.
  await bar.getByRole("button", { name: "Discard" }).click();
  await expect(bar).toBeHidden();
  await expect(field(page, "Upload slots per torrent")).toHaveValue("");

  await field(page, "Upload limit").fill("12 000");
  await field(page, "Peer connections").fill("");
  await expect(bar).toContainText("A whole number.");
  await expect(bar.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  await field(page, "Peer connections").fill("300");
  await page.keyboard.press("Control+s");
  await expect(bar).toBeHidden();
  const { data } = await daemon.api.GET("/api/v1/settings");
  expect(data?.upload_limit).toBe(12_000_000);
  expect(data?.max_connections).toBe(300);
  expect(data?.download_limit).toBeNull();
});

test("the schedule: window, zone and days", async ({ signedIn: page, daemon }) => {
  await page.goto(`${daemon.url}/settings/speed`);
  await page.getByText("Switch to alternative limits on a schedule", { exact: true }).click();
  await expect(field(page, "Window")).toHaveValue("01:00");
  await expect(page.getByLabel("Window ends at")).toHaveValue("07:00");
  const days = page.getByRole("group", { name: "Days" });
  for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"])
    await days.getByRole("button", { name: d }).click();
  await expect(page.getByText("30 h / week")).toBeVisible();
  await expect(page.getByRole("img", { name: /^30 hours a week/ })).toBeVisible();
  await page.getByRole("button", { name: "Time zone" }).click();
  await page.getByRole("option", { name: "Europe/London" }).click();
  // The daemon reads HH:MM only.
  await field(page, "Window").fill("1:00");
  await expect(page.getByText("HH:MM, 24-hour.").first()).toBeVisible();
  await field(page, "Window").fill("22:00");
  await expect(page.getByText("45 h / week")).toBeVisible();
  await expectAccessible(page);
  await page.getByRole("button", { name: /Save changes/ }).click();
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toBeHidden();
  const { data } = await daemon.api.GET("/api/v1/settings");
  expect(data?.alt_speed_schedule).toEqual({
    from: "22:00",
    to: "07:00",
    days: ["mon", "tue", "wed", "thu", "fri"],
    time_zone: "Europe/London",
  });
  // The status says when the saved schedule switches next.
  await expect(page.getByText(/the schedule turns them (on|off) at/)).toBeVisible();
});

test("the alternative limits switch at once", async ({ signedIn: page, daemon }) => {
  await page.goto(`${daemon.url}/settings/speed`);
  await page.getByText("Alternative limits are in force", { exact: true }).click();
  await expect
    .poll(async () => (await daemon.api.GET("/api/v1/transfer")).data?.alt_speed_enabled)
    .toBe(true);
  // Live, not a draft: nothing to save.
  await expect(page.getByRole("region", { name: "Unsaved changes" })).toBeHidden();
  await expect(
    page.getByText("Not in force now: the alternative limits are.").first(),
  ).toBeVisible();
});

test("leaving with unsaved changes asks first", async ({ signedIn: page, daemon }) => {
  await page.goto(`${daemon.url}/settings/speed`);
  await field(page, "Download limit").fill("500");
  await page.getByRole("link", { name: "Back to torrents" }).click();
  const ask = page.getByRole("alertdialog", { name: "Leave without saving?" });
  await expect(ask).toContainText("download_limit");
  await ask.getByRole("button", { name: "Stay" }).click();
  await expect(field(page, "Download limit")).toHaveValue("500");
  await page.getByRole("link", { name: "Back to torrents" }).click();
  await ask.getByRole("button", { name: "Leave" }).click();
  await expect(page).toHaveURL(/\/torrents$/);
  const { data } = await daemon.api.GET("/api/v1/settings");
  expect(data?.download_limit).toBeNull();
});

test("other sections say they are coming", async ({ signedIn: page, daemon }) => {
  await page.goto(`${daemon.url}/settings/speed`);
  await page.getByRole("link", { name: "Security & API" }).click();
  await expect(page.getByRole("heading", { name: "Security & API", level: 1 })).toBeVisible();
  await expect(page.getByText("are not built yet")).toBeVisible();
});

test("a restart from the page applies an engine setting", async ({ signedIn: page, daemon }) => {
  await daemon.api.PATCH("/api/v1/settings", { body: { hash_threads: 3 } });
  await page.goto(`${daemon.url}/settings/speed`);
  const banner = page
    .getByRole("status")
    .filter({ hasText: "engine setting applies after a restart" });
  await expect(banner).toBeVisible();
  await expect(page.getByRole("link", { name: /Engine \(restart required\)/ })).toBeVisible();
  await banner.getByRole("button", { name: "Restart daemon" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Restart", exact: true }).click();
  // Sessions live in the daemon's memory: sign in again after it is back.
  await expect(page).toHaveURL(/\/sign-in/, { timeout: 30_000 });
  await page.getByLabel("Username").fill(CREDENTIALS.username);
  await page.getByLabel("Password").fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "Speed", level: 1 })).toBeVisible();
  await expect(banner).toBeHidden();
  const { data } = await daemon.api.GET("/api/v1/app");
  expect(data?.restart_required).toEqual([]);
});
