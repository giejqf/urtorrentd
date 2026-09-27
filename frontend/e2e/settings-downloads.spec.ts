// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Downloads against a real daemon (AGENTS.md 7.4): paths,
// switches and lists saved together in the API's shape, what the daemon
// would refuse caught first, categories changed at once, and the tracker
// list fetched from a local server on demand.

import type { Page } from "@playwright/test";

import { expect, expectAccessible, test } from "./fixtures";
import { textFile } from "./servers";

/** A setting's field by its label; a changed one is also "(not saved)". */
function field(page: Page, label: string) {
  return page.getByLabel(new RegExp(`^${label.replace(/[.*?()]/g, "\\$&")}( \\(not saved\\))?$`));
}

test("paths, switches and lists are saved together", async ({ signedIn: page, daemon }) => {
  const before = (await daemon.api.GET("/api/v1/settings")).data;
  const save = before?.save_path ?? "";
  await page.goto(`${daemon.url}/settings/downloads`);
  await expect(page.getByRole("heading", { name: "Downloads", level: 1 })).toBeVisible();
  await expect(page.getByText("All changes saved")).toBeVisible();
  await expectAccessible(page);

  // Typing a path turns its switch on; the flow follows the draft.
  await page.getByLabel("Download path", { exact: true }).fill(`${save}/incoming`);
  await expect(field(page, "Keep incomplete downloads elsewhere")).toBeChecked();
  const flow = page.getByText("While incomplete").locator("..");
  await expect(flow).toContainText(`${save}/incoming/`);
  await expect(flow).toContainText("0 torrents here now");
  await page.getByText("Mark incomplete files", { exact: true }).click();
  await expect(flow).toContainText(".!ur");
  await page.getByRole("radio", { name: "Subfolder", exact: true }).click();
  await page.getByRole("button", { name: "Stop condition" }).click();
  await page.getByRole("option", { name: "Files checked" }).click();
  await page.getByText("Merge trackers into duplicates", { exact: true }).click();

  await field(page, "Skip files named").fill("sample*");
  await field(page, "Skip files named").press("Enter");
  await expect(page.getByRole("button", { name: "Remove pattern sample*" })).toBeVisible();
  const own = field(page, "Your own list");
  await own.fill("ftp://tracker.lan/announce");
  await own.press("Enter");
  await expect(
    page.getByRole("alert").filter({ hasText: "An http, https or udp URL." }),
  ).toBeVisible();
  await own.fill("udp://127.0.0.1:6969/announce");
  await own.press("Enter");
  await expect(
    page.getByRole("button", { name: "Remove tracker udp://127.0.0.1:6969/announce" }),
  ).toBeVisible();

  const bar = page.getByRole("region", { name: "Unsaved changes" });
  await expect(bar).toContainText("7 unsaved changes");
  await expect(bar).toContainText(
    "download_path · incomplete_file_suffix · content_layout · stop_condition · merge_trackers · excluded_file_names · add_trackers",
  );
  await expectAccessible(page);
  await page.keyboard.press("Control+s");
  await expect(bar).toBeHidden();
  await expect(page.getByText("All changes saved")).toBeVisible();
  const { data } = await daemon.api.GET("/api/v1/settings");
  expect(data).toMatchObject({
    download_path: `${save}/incoming`,
    incomplete_file_suffix: ".!ur",
    content_layout: "subfolder",
    stop_condition: "files_checked",
    excluded_file_names: ["sample*"],
    add_trackers: ["udp://127.0.0.1:6969/announce"],
    merge_trackers: !before?.merge_trackers,
  });

  // Off sends null and keeps the text for next time.
  await page.getByText("Keep incomplete downloads elsewhere", { exact: true }).click();
  await page.getByRole("button", { name: /Save changes/ }).click();
  await expect(bar).toBeHidden();
  expect((await daemon.api.GET("/api/v1/settings")).data?.download_path).toBeNull();
  await expect(page.getByLabel("Download path", { exact: true })).toHaveValue(`${save}/incoming`);
});

test("what the daemon would refuse is caught first", async ({ signedIn: page, daemon }) => {
  const save = (await daemon.api.GET("/api/v1/settings")).data?.save_path ?? "";
  await page.goto(`${daemon.url}/settings/downloads`);
  await field(page, "Save path").fill("data");
  const problems = page.getByRole("alert");
  await expect(problems.filter({ hasText: "An absolute path, starting with /." })).toBeVisible();
  await page.getByText("Export .torrent files of finished torrents", { exact: true }).click();
  await expect(problems.filter({ hasText: "Choose a folder, or turn this off." })).toBeVisible();
  const bar = page.getByRole("region", { name: "Unsaved changes" });
  await expect(bar.getByRole("button", { name: /Save changes/ })).toBeDisabled();
  await bar.getByRole("button", { name: "Discard" }).click();
  await expect(field(page, "Save path")).toHaveValue(save);

  // The folder browser fills the field (and turns its switch on).
  await page.getByRole("button", { name: "Browse for the folder for finished torrents" }).click();
  await page
    .getByRole("dialog", { name: "Choose a folder" })
    .getByRole("button", { name: /^Choose \// })
    .click();
  await expect(page.getByLabel("Folder for finished torrents", { exact: true })).toHaveValue(save);
  await expect(field(page, "Export .torrent files of finished torrents")).toBeChecked();
  await page.keyboard.press("Control+s");
  await expect(bar).toBeHidden();
  expect((await daemon.api.GET("/api/v1/settings")).data?.export_dir_finished).toBe(save);
});

test("categories are added, edited and removed at once", async ({ signedIn: page, daemon }) => {
  const save = (await daemon.api.GET("/api/v1/settings")).data?.save_path ?? "";
  await page.goto(`${daemon.url}/settings/downloads`);
  const paths = page.getByRole("region", { name: "Category paths" });
  await expect(paths).toContainText("No categories yet.");

  await paths.getByRole("button", { name: "Add category" }).click();
  const dialog = page.getByRole("dialog", { name: "Add category" });
  await dialog.getByLabel("Name").fill("linux");
  await expect(dialog).toContainText(`Relative to the default save path → ${save}/linux`);
  await dialog.getByLabel("Save path", { exact: true }).fill("iso");
  await expect(dialog).toContainText(`→ ${save}/iso`);
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Add category" }).click();
  await expect(dialog).toBeHidden();
  const row = paths.getByRole("row", { name: /linux/ });
  await expect(row).toContainText("iso");
  await expect(row).toContainText("— (global)");
  expect((await daemon.api.GET("/api/v1/categories")).data?.linux).toMatchObject({
    save_path: "iso",
    download_path: null,
  });

  // Editing keeps what the page does not show (the share limits).
  const limits = {
    ratio: { mode: "limit", value: 2 },
    seeding_time: { mode: "unlimited" },
    inactive_seeding_time: { mode: "global" },
    action: "stop",
  } as const;
  await daemon.api.PUT("/api/v1/categories", {
    body: { name: "linux", save_path: "iso", download_path: null, share_limits: limits },
  });
  await paths.getByRole("button", { name: "Edit category linux" }).click();
  const edit = page.getByRole("dialog", { name: "Edit category — linux" });
  await expect(edit.getByLabel("Name")).toHaveAttribute("readonly");
  await expect(edit).toContainText("cannot be renamed");
  await expect(edit.getByLabel("Save path", { exact: true })).toHaveValue("iso");
  await expectAccessible(page);
  await edit.getByLabel("Download path", { exact: true }).fill("/srv/incoming");
  await edit.getByRole("button", { name: "Save", exact: true }).click();
  await expect(edit).toBeHidden();
  await expect(row).toContainText("/srv/incoming");
  expect((await daemon.api.GET("/api/v1/categories")).data?.linux).toEqual({
    save_path: "iso",
    download_path: "/srv/incoming",
    share_limits: limits,
  });

  await paths.getByRole("button", { name: "Edit category linux" }).click();
  await edit.getByRole("button", { name: "Remove category" }).click();
  const ask = page.getByRole("alertdialog", { name: "Remove category linux?" });
  await expect(ask).toContainText("No torrent is in it.");
  await ask.getByRole("button", { name: "Remove" }).click();
  await expect(paths).toContainText("No categories yet.");
  expect((await daemon.api.GET("/api/v1/categories")).data).toEqual({});
});

test("the tracker list is fetched on demand", async ({ signedIn: page, daemon }) => {
  let list = "udp://127.0.0.1:1/announce\nhttp://127.0.0.1:2/announce\n";
  const server = await textFile(() => list);
  try {
    await daemon.api.PATCH("/api/v1/settings", { body: { add_trackers_url: server.url } });
    await page.goto(`${daemon.url}/settings/downloads`);
    const status = page.getByRole("status").filter({ hasText: "Fetch now" });
    await expect(status).toContainText(/2 trackers · fetched (just now|\d+s ago)/);
    const before = server.hits();

    list += "udp://127.0.0.1:3/announce\n";
    await status.getByRole("button", { name: "Fetch now" }).click();
    await expect(status).toContainText(/3 trackers · fetched/);
    expect(server.hits()).toBe(before + 1);

    // A URL not saved yet cannot be fetched.
    await page.getByLabel("Tracker list URL").fill(`${server.url}?v=2`);
    await expect(status.getByRole("button", { name: "Fetch now" })).toBeDisabled();
  } finally {
    await server.close();
  }
});
