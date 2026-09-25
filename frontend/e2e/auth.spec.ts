// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// First-run setup, sign-in, wrong passwords, bans, session expiry and
// sign-out, through the UI against real daemons (AGENTS.md 7.4).

import { CREDENTIALS, Daemon } from "./daemon";
import { expect, expectAccessible, test } from "./fixtures";

test("first run: setup chooses the credentials and signs in", async ({ page, freshDaemon }) => {
  await page.goto(freshDaemon.url);
  await expect(page).toHaveURL(/\/setup$/);
  await expect(page.getByRole("heading", { name: "Set up urtorrent" })).toBeVisible();
  await expect(page.getByText("Daemon reachable")).toBeVisible();
  // Before sign-in the daemon tells nobody its name or version.
  await expect(page.getByText(/0\.\d+\.\d+/)).toHaveCount(0);
  await expectAccessible(page);

  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password", { exact: true }).fill("short");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toHaveText("The password needs at least 8 characters.");

  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse batteries");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toHaveText("The passwords do not match.");

  await page.getByLabel("Confirm password").fill("correct horse battery");
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/torrents$/);
  await expect(page.getByRole("heading", { name: "All torrents" })).toBeVisible();
  await expect(page.getByText("No torrents yet")).toBeVisible();

  // The session survives a reload, and setup is closed now.
  await page.reload();
  await expect(page.getByRole("heading", { name: "All torrents" })).toBeVisible();
  const { data } = await freshDaemon.api.GET("/api/v1/auth/status");
  expect(data?.setup_required).toBe(false);

  // Sign out from the instance menu.
  await page.getByRole("button", { name: /instance menu/ }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await page.getByLabel("Username").fill("owner");
  await page.getByLabel("Password").fill("correct horse battery");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("heading", { name: "All torrents" })).toBeVisible();
});

test("setup lost to another client says so", async ({ page, freshDaemon }) => {
  await page.goto(`${freshDaemon.url}/setup`);
  await page.getByLabel("Password", { exact: true }).fill("correct horse battery");
  await page.getByLabel("Confirm password").fill("correct horse battery");
  await freshDaemon.setup(); // someone else is first
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("alert")).toContainText("Someone else set up this daemon first.");
  await page.getByRole("link", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test("sign-in: wrong password, then back to where the user was going", async ({ page, daemon }) => {
  await page.goto(`${daemon.url}/torrents?status=seeding`);
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  await expect(page.getByRole("heading", { name: "Sign in to urtorrent" })).toBeVisible();
  // Nothing the design has that the API cannot back (AGENTS.md 6.4).
  await expect(page.getByText("Stay signed in")).toHaveCount(0);
  await expect(page.getByText("urtorrentd passwd")).toBeVisible();
  await expectAccessible(page);

  await page.getByLabel("Username").fill(CREDENTIALS.username);
  await page.getByLabel("Password").fill("not the password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("Wrong user name or password.");

  await page.getByLabel("Password").fill(CREDENTIALS.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/torrents\?status=seeding$/);
  await expect(page.getByRole("heading", { name: "Seeding" })).toBeVisible();
});

test("too many failures ban the address", async ({ page }, info) => {
  const daemon = await Daemon.start({
    peerIp: `127.0.${10 + info.workerIndex}.250`,
    settings: { api_max_auth_failures: 2, api_ban_duration: 60 },
  });
  try {
    await page.goto(`${daemon.url}/sign-in`);
    await page.getByLabel("Username").fill(CREDENTIALS.username);
    for (const attempt of ["wrong one", "wrong two"]) {
      await page.getByLabel("Password").fill(attempt);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("alert")).toHaveText("Wrong user name or password.");
    }
    await page.getByLabel("Password").fill(CREDENTIALS.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(page.getByRole("alert")).toHaveText(
      "Too many failed sign-ins from this address. Try again later.",
    );
  } finally {
    await daemon.stop();
  }
});

test("a session that ends sends the user back to sign-in", async ({ signedIn: page, daemon }) => {
  await expect(page.getByRole("heading", { name: "All torrents" })).toBeVisible();
  // New credentials end every session (PUT /auth/credentials).
  const r = await daemon.api.PUT("/api/v1/auth/credentials", {
    body: { username: CREDENTIALS.username, password: CREDENTIALS.password },
  });
  expect(r.response.status).toBe(204);
  // The next call the page makes finds the session gone.
  await page.getByRole("button", { name: "Add", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add torrents" });
  await dialog.getByLabel("Links").fill("0123456789abcdef0123456789abcdef01234567");
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page).toHaveURL(/\/sign-in\?next=/);
  await expect(page.getByText("Your session ended. Sign in again.")).toBeVisible();
});
