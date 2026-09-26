// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Stats reports Peers & geo, Idle seeds and Timeline against real
// daemons (AGENTS.md 7.4): a torrent seeded slowly to a second daemon, one
// downloaded from it, one nobody wants. A tracker on loopback tells the
// daemon its external address (203.0.113.7, a documentation address) and a
// GeoIP file written by the test places that in the United Kingdom and the
// other daemon in Germany.

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, expectAccessible, test } from "./fixtures";
import { country, writeCountryDb } from "./mmdb";
import { makeTorrent } from "./torrent";

test("stats: peers & geo, idle seeds, timeline", async ({
  signedIn: page,
  daemon,
  seeder: other,
}) => {
  test.setTimeout(180_000);
  const tracker = createServer((_, res) => {
    res.writeHead(200);
    res.end(
      Buffer.concat([
        Buffer.from("d11:external ip4:"),
        Buffer.from([203, 0, 113, 7]),
        Buffer.from("8:intervali1800e5:peers0:e"),
      ]),
    );
  });
  await new Promise<void>((ok) => tracker.listen(0, "127.0.0.1", ok));
  const announce = `http://127.0.0.1:${(tracker.address() as { port: number }).port}/announce`;
  const dir = mkdtempSync(join(tmpdir(), "urtorrentd-geo-"));
  try {
    const db = join(dir, "country.mmdb");
    writeCountryDb(db, [
      ["203.0.113.0/24", country("GB", "United Kingdom")],
      [`${other.peerIp}/32`, country("DE", "Germany")],
    ]);
    await daemon.api.PATCH("/api/v1/settings", { body: { geoip_database: db } });
    await other.api.PATCH("/api/v1/settings", { body: { download_limit: 150_000 } });

    // Seeded here, downloaded slowly by the other daemon; seeded there and
    // downloaded here; seeded here and wanted by nobody.
    const big = makeTorrent({
      name: "big-e2e.bin",
      size: 6 * 1024 * 1024,
      pieceLength: 65_536,
      trackers: [announce],
    });
    const back = makeTorrent({ name: "back-e2e.bin", size: 256 * 1024, pieceLength: 65_536 });
    const idle = makeTorrent({ name: "idle-e2e.bin", size: 512 * 1024, pieceLength: 65_536 });
    big.writeContent(daemon.savePath);
    idle.writeContent(daemon.savePath);
    back.writeContent(other.savePath);
    for (const t of [big, idle]) {
      await daemon.api.POST("/api/v1/torrents", { body: { torrents: [t.base64] } });
      await daemon.waitFor(t.hash, (x) => x.state === "seeding", "a seed");
    }
    await other.api.POST("/api/v1/torrents", { body: { torrents: [back.base64] } });
    await other.waitFor(back.hash, (x) => x.state === "seeding", "the other seed");
    await daemon.api.POST("/api/v1/torrents", {
      body: { torrents: [back.base64], options: { category: "linux" } },
    });
    await daemon.api.POST("/api/v1/torrents/peers", {
      body: { hashes: [back.hash], peers: [await other.peerAddress()] },
    });
    await daemon.waitFor(back.hash, (x) => x.complete === true, "the download");
    await other.api.POST("/api/v1/torrents", { body: { torrents: [big.base64] } });
    await other.api.POST("/api/v1/torrents/peers", {
      body: { hashes: [big.hash], peers: [await daemon.peerAddress()] },
    });
    await expect
      .poll(async () => (await daemon.api.GET("/api/v1/transfer/peers")).data?.here?.country, {
        timeout: 30_000,
      })
      .toBe("GB");

    // Peers & geo: the map from the United Kingdom, the peer in Germany.
    await page.goto(`${daemon.url}/stats/peers`);
    await expect(page.getByRole("heading", { name: "Peers & geo", level: 1 })).toBeVisible();
    const map = page.getByRole("region", { name: "Map" });
    await expect(map.getByRole("img")).toBeVisible();
    await expect(map).toContainText("United Kingdom");
    await page.getByRole("button", { name: "Torrent…" }).click();
    await page.getByRole("button", { name: /^big-e2e\.bin/ }).click();
    await expect(page).toHaveURL(new RegExp(`hash=${big.hash}`));
    const peers = page.getByRole("list", { name: "Peers" });
    const row = peers.getByRole("listitem").filter({ hasText: other.peerIp });
    await expect(row).toContainText("Germany");
    await expect(row).toContainText("DE");
    await expect(map).toContainText("DE");
    await expect(page.getByRole("region", { name: "Connections" })).toContainText("TCP");
    await expectAccessible(page);
    // The last 24 hours: traffic by country.
    // Once a sample has tied the torrent's traffic to its peer (every 10 s).
    await expect
      .poll(
        async () =>
          (
            await daemon.api.GET("/api/v1/stats/geo", {
              params: { query: { hash: big.hash } },
            })
          ).data?.rows[0]?.country,
        { timeout: 30_000 },
      )
      .toBe("DE");
    await page.getByRole("radio", { name: "24 h" }).click();
    await expect(page.getByRole("region", { name: "Countries" })).toContainText("Germany", {
      timeout: 20_000,
    });
    // Banned from the live list.
    await page.getByRole("radio", { name: "Live" }).click();
    await row.getByRole("checkbox").focus();
    await page.keyboard.press("Space");
    await expect(row.getByRole("checkbox")).toBeChecked();
    await page.getByRole("button", { name: "Ban selected" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Ban" }).click();
    await expect
      .poll(async () => (await daemon.api.GET("/api/v1/settings")).data?.banned_ips)
      .toContain(other.peerIp);

    // Idle seeds: what shared nothing, kept or removed.
    await page.goto(`${daemon.url}/stats/idle-seeds`);
    await expect(page.getByRole("heading", { name: "Idle seeds", level: 1 })).toBeVisible();
    const worth = page.getByRole("region", { name: "Least valuable first" });
    const idleRow = worth.getByRole("row", { name: /idle-e2e\.bin/ });
    await expect(idleRow).toContainText("0.00×");
    await expect(
      page.getByRole("region", { name: "Worth its space?" }).getByRole("img"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Select all under 0.1×" }).click();
    const bar = page.getByRole("toolbar", { name: "Selected torrents" });
    await expect(bar).toContainText("2 selected");
    await expectAccessible(page);
    await bar.getByRole("button", { name: "Tag keep" }).click();
    await expect
      .poll(
        async () =>
          (await daemon.api.GET("/api/v1/torrents")).data?.filter((t) => t.tags.includes("keep"))
            .length,
      )
      .toBe(2);
    await expect(idleRow).toContainText("keep");
    // Kept ones are not taken by "under 0.1×".
    await page.getByRole("button", { name: "Clear" }).click();
    await page.getByRole("button", { name: "Select all under 0.1×" }).click();
    await expect(bar).toBeHidden();
    await idleRow.getByRole("checkbox").focus();
    await page.keyboard.press("Space");
    await expect(idleRow.getByRole("checkbox")).toBeChecked();
    await bar.getByRole("button", { name: "Remove, keep files" }).click();
    await page
      .getByRole("alertdialog")
      .getByRole("button", { name: "Delete", exact: true })
      .click();
    await expect
      .poll(async () => (await daemon.api.GET("/api/v1/torrents")).data?.map((t) => t.name).sort())
      .toEqual(["back-e2e.bin", "big-e2e.bin"]);
    const csv = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export CSV" }).click();
    const file = await csv;
    expect(file.suggestedFilename()).toMatch(/^urtorrentd-idle-seeds-30d-\d{12}\.csv$/);
    const text = readFileSync((await file.path()) ?? "", "utf8");
    expect(text.split("\n")[0]).toContain("name,hash,size_bytes");
    expect(text).toContain("back-e2e.bin");

    // Timeline: the events, by kind, as lanes and a feed.
    await page.goto(`${daemon.url}/stats/timeline`);
    await expect(page.getByRole("heading", { name: "Timeline", level: 1 })).toBeVisible();
    const feed = page.getByRole("list", { name: "Events" });
    await expect(feed).toContainText("back-e2e.bin was added");
    await expect(feed).toContainText("finished downloading");
    await expect(feed).toContainText("idle-e2e.bin was removed");
    await expect(page.getByRole("region", { name: "Lifecycles" }).getByRole("img")).toBeVisible();
    await expectAccessible(page);
    await page.getByRole("button", { name: /^Added \d+$/ }).click();
    await expect(page).toHaveURL(/hide=added/);
    await expect(feed).not.toContainText("was added");
    await page.getByRole("button", { name: "Torrent…" }).click();
    await page.getByRole("button", { name: /^back-e2e\.bin/ }).click();
    await expect(feed).not.toContainText("big-e2e.bin");
    await expect(feed).toContainText("back-e2e.bin finished downloading");
    const exported = page.waitForEvent("download");
    await page.getByRole("button", { name: "Export" }).click();
    const events = readFileSync((await (await exported).path()) ?? "", "utf8");
    expect(events.split("\n")[0]).toBe("time_utc,kind,hash,name,state,detail");
    expect(events).toContain(`finished,${back.hash}`);
    expect(events).not.toContain(",added,");
  } finally {
    await new Promise<void>((ok) => tracker.close(() => ok()));
    rmSync(dir, { recursive: true, force: true });
  }
});
