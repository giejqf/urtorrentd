// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Connection, BitTorrent and Banned addresses against a real
// daemon (AGENTS.md 7.4): listening and transports saved in the API's
// shape, discovery and identity, and bans that apply at once and show in
// the peer log. Everything stays on loopback (DHT and LSD are off in the
// harness, and no bootstrap router is ever reachable).

import type { Page } from "@playwright/test";

import { expect, expectAccessible, test } from "./fixtures";

/** A setting's field by its label; a changed one is also "(not saved)". */
function field(page: Page, label: string) {
  return page.getByLabel(new RegExp(`^${label}( \\(not saved\\))?$`));
}

test("connection: port, interface, families and transports", async ({ signedIn: page, daemon }) => {
  const before = (await daemon.api.GET("/api/v1/settings")).data;
  await page.goto(`${daemon.url}/settings/connection`);
  await expect(page.getByRole("heading", { name: "Connection", level: 1 })).toBeVisible();
  const reach = page.getByRole("region", { name: "Reachability" });
  await expect(reach).toContainText(String(before?.listen_port));
  await expect(page.getByRole("region", { name: "Interfaces" })).toContainText("lo");
  await expectAccessible(page);

  await field(page, "Listen port").fill("70000");
  await expect(
    page.getByRole("alert").filter({ hasText: "A port from 0 to 65535." }),
  ).toBeVisible();
  // Back to the port it has: another port could clash with parallel daemons.
  await field(page, "Listen port").fill(String(before?.listen_port));
  // Both families off is refused before it reaches the daemon.
  const ipv4 = page.locator("label").filter({ hasText: /^IPv4/ });
  await ipv4.click();
  await expect(
    page.getByRole("alert").filter({ hasText: "IPv4 and IPv6 cannot both be off." }),
  ).toBeVisible();
  await ipv4.click();
  await page.getByRole("button", { name: "Interface" }).click();
  await page.getByRole("option", { name: /^lo\b/ }).click();
  await page.getByRole("radio", { name: "µTP only" }).click();
  const bar = page.getByRole("region", { name: "Unsaved changes" });
  await expect(bar).toContainText("2 unsaved changes");
  await expect(bar).toContainText("listen_interface · transports");
  await page.keyboard.press("Control+s");
  await expect(bar).toBeHidden();
  const { data } = await daemon.api.GET("/api/v1/settings");
  expect(data).toMatchObject({
    listen_port: before?.listen_port,
    listen_interface: "lo",
    listen_v4: before?.listen_v4,
    listen_v6: null,
    transports: "utp_only",
  });
  // The daemon now listens on the loopback interface's address.
  await expect(
    page
      .getByRole("region", { name: "Interfaces" })
      .getByRole("listitem")
      .filter({ hasText: "lo" }),
  ).toContainText("listening");
});

test("bittorrent: discovery, bootstrap routers, encryption and identity", async ({
  signedIn: page,
  daemon,
}) => {
  await page.goto(`${daemon.url}/settings/bittorrent`);
  await expect(page.getByRole("heading", { name: "BitTorrent", level: 1 })).toBeVisible();
  await expect(page.getByRole("region", { name: "How peers were found" })).toContainText(
    "No peer traffic in the last day.",
  );
  await page
    .locator("label")
    .filter({ hasText: /^Peer exchange/ })
    .click();
  await expect(page.getByRole("region", { name: "How peers were found" })).toBeVisible();

  // The harness has its own, empty list: add a router on loopback.
  const routers = field(page, "DHT bootstrap routers restart");
  await routers.fill("nowhere");
  await routers.press("Enter");
  await expect(page.getByRole("alert").filter({ hasText: "host:port" })).toBeVisible();
  await routers.fill("127.0.0.1:6881");
  await routers.press("Enter");
  await expect(page.getByRole("button", { name: "Remove router 127.0.0.1:6881" })).toBeVisible();

  await page.getByRole("radio", { name: "Forced" }).click();
  await page.getByRole("button", { name: /^Identity\b/ }).click();
  await page.getByRole("option", { name: /qBittorrent 5\.2\.3/ }).click();
  await expect(page.getByText(/^qbt_5_2_3_lt2_0_14\s+selected$/)).toBeVisible();
  await expectAccessible(page);
  const bar = page.getByRole("region", { name: "Unsaved changes" });
  await expect(bar).toContainText("pex · dht_bootstrap_nodes · encryption · identity");
  await page.getByRole("button", { name: /Save changes/ }).click();
  await expect(bar).toBeHidden();
  const { data } = await daemon.api.GET("/api/v1/settings");
  expect(data).toMatchObject({
    pex: false,
    dht_bootstrap_nodes: ["127.0.0.1:6881"],
    encryption: "forced",
    identity: "qbt_5_2_3_lt2_0_14",
  });
  // The routers apply after a restart, and the page says so.
  await expect(page.getByText(/engine settings? appl(y|ies) after a restart/)).toBeVisible();
});

test("bans apply at once and show in the peer log", async ({ signedIn: page, daemon }) => {
  await page.goto(`${daemon.url}/settings/bans`);
  await expect(page.getByRole("heading", { name: "Banned addresses", level: 1 })).toBeVisible();
  const add = page.getByLabel("Addresses to ban");
  await add.fill("203.0.113.7:6881, 10.0.0.0/8 nonsense");
  await add.press("Enter");
  await expect(
    page.getByRole("alert").filter({ hasText: "Not an address, block or range: nonsense" }),
  ).toBeVisible();
  await add.fill("203.0.113.7:6881, 10.0.0.0/8");
  await page.getByRole("button", { name: "Ban", exact: true }).click();
  await expect(add).toHaveValue("");
  const { data } = await daemon.api.GET("/api/v1/settings");
  expect(data?.banned_ips).toEqual(["203.0.113.7"]);
  expect(data?.banned_ip_ranges).toEqual(["10.0.0.0/8"]);

  const list = page.getByRole("region", { name: "Your list" });
  await expect(list.getByRole("row")).toHaveCount(3);
  await expect(page.getByText("16.8M")).toBeVisible();
  await list.getByRole("radio", { name: "Blocks & ranges" }).click();
  await expect(list.getByRole("row")).toHaveCount(2);
  await expect(list).toContainText("10.0.0.0/8");
  await list.getByRole("radio", { name: "All" }).click();

  const log = page.getByRole("region", { name: "Peer log" });
  await expect(log).toContainText("203.0.113.7 — banned in the settings");
  await expect(log.getByRole("img", { name: /^1 ban/ })).toBeVisible();
  await expectAccessible(page);

  // Unbanned from the log.
  await log.getByRole("button", { name: "Unban 203.0.113.7" }).click();
  await expect(log).toContainText("203.0.113.7 — unbanned in the settings");
  await expect(list.getByRole("row")).toHaveCount(2);
  expect((await daemon.api.GET("/api/v1/settings")).data?.banned_ips).toEqual([]);
});
