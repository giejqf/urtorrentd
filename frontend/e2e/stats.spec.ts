// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Stats screen against real daemons (AGENTS.md 7.4): a torrent seeded
// to a second daemon and one downloaded from it, both through a tracker on
// loopback, and an idle seed whose tracker does not answer. The Overview
// shows the recorded traffic, rankings, breakdowns, idle seeds and events;
// Trackers shows each host with its announces and fixes the dead one.

import { createServer } from "node:http";

import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

test("stats: the overview and the trackers report", async ({
  signedIn: page,
  daemon,
  seeder: other,
}) => {
  test.setTimeout(120_000);
  // A tracker that answers every announce: no peers, come back in 30 min.
  let announces = 0;
  const tracker = createServer((req, res) => {
    announces += 1;
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(
      (req.url ?? "").startsWith("/announce")
        ? "d8:intervali1800e5:peers0:e"
        : "d14:failure reason7:unknowne",
    );
  });
  await new Promise<void>((ok) => tracker.listen(0, "127.0.0.1", ok));
  const port = (tracker.address() as { port: number }).port;
  const working = `http://127.0.0.1:${port}/announce?passkey=do-not-show`;
  const dead = "http://localhost:1/announce";
  try {
    // Seeded here, downloaded by the other daemon: upload.
    const up = makeTorrent({
      name: "big-buck-e2e.bin",
      size: 3 * 1024 * 1024,
      pieceLength: 65_536,
      trackers: [working],
    });
    up.writeContent(daemon.savePath);
    // Seeded there, downloaded here: download.
    const down = makeTorrent({
      name: "tears-e2e.bin",
      size: 2 * 1024 * 1024,
      pieceLength: 65_536,
      trackers: [working],
    });
    down.writeContent(other.savePath);
    // Seeded here, nobody wants it, and its tracker is gone.
    const idle = makeTorrent({
      name: "idle-e2e.bin",
      size: 256 * 1024,
      pieceLength: 65_536,
      trackers: [dead],
    });
    idle.writeContent(daemon.savePath);

    await daemon.api.POST("/api/v1/torrents", {
      body: { torrents: [up.base64], options: { category: "linux" } },
    });
    await daemon.api.POST("/api/v1/torrents", { body: { torrents: [idle.base64] } });
    await other.api.POST("/api/v1/torrents", { body: { torrents: [down.base64] } });
    await daemon.waitFor(up.hash, (x) => x.state === "seeding", "the seed");
    await daemon.waitFor(idle.hash, (x) => x.state === "seeding", "the idle seed");
    await other.waitFor(down.hash, (x) => x.state === "seeding", "the other seed");
    await other.api.POST("/api/v1/torrents", { body: { torrents: [up.base64] } });
    await daemon.api.POST("/api/v1/torrents", {
      body: { torrents: [down.base64], options: { category: "movies" } },
    });
    await other.api.POST("/api/v1/torrents/peers", {
      body: { hashes: [up.hash], peers: [await daemon.peerAddress()] },
    });
    await daemon.api.POST("/api/v1/torrents/peers", {
      body: { hashes: [down.hash], peers: [await other.peerAddress()] },
    });
    await other.waitFor(up.hash, (x) => x.complete === true, "the upload", 60_000);
    await daemon.waitFor(down.hash, (x) => x.complete === true, "the download", 60_000);
    // Recorded: what the transfer statistics hold is what the page sums.
    const recorded = async () => {
      const { data } = await daemon.api.GET("/api/v1/stats/transfer", {
        params: { query: { from: Math.floor(Date.now() / 1000) - 7 * 86_400 } },
      });
      return (data?.points ?? []).reduce(
        (n, p) => ({ down: n.down + p.downloaded, up: n.up + p.uploaded }),
        { down: 0, up: 0 },
      );
    };
    await expect.poll(async () => (await recorded()).up).toBeGreaterThanOrEqual(3 * 1024 * 1024);
    await expect.poll(async () => (await recorded()).down).toBeGreaterThanOrEqual(2 * 1024 * 1024);

    // The overview.
    await page.goto(`${daemon.url}/stats`);
    await expect(page.getByRole("heading", { name: "Statistics", level: 1 })).toBeVisible();
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    await expect(sidebar.getByRole("link", { name: "Overview" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    await expect(sidebar).toContainText(/recording/);
    await expect(page.getByText("Downloaded", { exact: true })).toBeVisible();
    await expect(page.getByRole("img", { name: /^Download and upload rate/ })).toBeVisible();
    const top = page.getByRole("region", { name: "Top torrents" });
    await expect(top.getByRole("link", { name: "big-buck-e2e.bin" })).toBeVisible();
    await top.getByRole("button", { name: "Rank by" }).click();
    await page.getByRole("menuitemradio", { name: "Download" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(top.getByRole("listitem").first()).toContainText("tears-e2e.bin");
    const cats = page.getByRole("region", { name: "Traffic by category" });
    await expect(cats.getByRole("listitem", { name: /^linux: / })).toBeVisible();
    await expect(cats.getByRole("listitem", { name: /^movies: / })).toBeVisible();
    const peers = page.getByRole("region", { name: "Peer clients" });
    await expect(peers.getByRole("listitem").first()).toBeVisible();
    await peers.getByRole("button", { name: "Break peers down by" }).click();
    await page.getByRole("menuitemradio", { name: "Transport" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByRole("region", { name: "Peers by transport" })).toContainText(/TCP|µTP/);
    const idleCard = page.getByRole("region", { name: "Idle seeds" });
    await expect(idleCard.getByRole("row", { name: /idle-e2e\.bin/ })).toContainText("0.00×");
    const timeline = page.getByRole("region", { name: "Timeline" });
    await expect(timeline).toContainText("added");
    await expect(timeline.getByRole("link", { name: "View all" })).toHaveAttribute(
      "href",
      "/stats/timeline",
    );
    await expectAccessible(page);

    // Ranges: a preset, then days picked.
    await page.getByRole("radio", { name: "Today" }).click();
    await expect(page).toHaveURL(/range=today/);
    await expect(top.getByRole("listitem").first()).toContainText("tears-e2e.bin");
    await page.getByRole("button", { name: "Pick days" }).click();
    const today = new Date().toLocaleDateString("en-CA");
    const pick = page.getByRole("dialog", { name: "Pick days" });
    await pick.getByLabel("From", { exact: true }).fill(today);
    await pick.getByLabel("To", { exact: true }).fill(today);
    await expectAccessible(page);
    await pick.getByRole("button", { name: "Show these days" }).click();
    await expect(page).toHaveURL(new RegExp(`from=${today}&to=${today}`));
    await expect(page.getByRole("radio", { checked: true })).toHaveCount(0);

    // Trackers: each host with its announces, the dead one fixed.
    await sidebar.getByRole("link", { name: "Trackers" }).click();
    await expect(page.getByRole("heading", { name: "Trackers", level: 1 })).toBeVisible();
    const hosts = page.getByRole("list", { name: "Trackers" });
    const good = hosts.getByRole("button", { name: /^127\.0\.0\.1:/ });
    await expect(good).toContainText("public · 2 torrents");
    // The interval the trackers ask for, from their replies.
    await expect(page.getByText("30m median interval")).toBeVisible();
    await expect(good).toContainText(/\d+ · 0 failed/);
    const bad = hosts.getByRole("button", { name: /^localhost:/ });
    await expect(bad).toContainText("failing now");
    await expect(page.locator("body")).not.toContainText("do-not-show");
    await expect(page.locator("body")).not.toContainText("/announce");
    await bad.click();
    await expect(bad).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("img", { name: "Upload by tracker, stacked" })).toBeVisible();
    await page.getByRole("radio", { name: "By download" }).click();
    await expect(page).toHaveURL(/by=downloaded/);
    await expect(page.getByRole("region", { name: "Download by tracker" })).toBeVisible();
    await expectAccessible(page);

    const problems = page.getByRole("region", { name: "Announce problems" });
    await expect(problems).toContainText("localhost");
    await expect(problems.getByRole("link", { name: "idle-e2e.bin" })).toBeVisible();
    await problems.getByRole("button", { name: "Reannounce" }).click();
    await problems.getByRole("button", { name: "Remove from torrent" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    const trackersOf = async (hash: string) =>
      (
        await daemon.api.GET("/api/v1/torrents/{hash}/trackers", {
          params: { path: { hash } },
        })
      ).data?.trackers.map((t) => t.url) ?? [];
    await expect.poll(() => trackersOf(idle.hash)).toEqual([]);
    // Now it runs with no tracker; the trackers meant for new public
    // torrents can be given to it.
    await expect(problems).toContainText("1 torrent runs with no working tracker");
    await expect(problems).toContainText("Settings › Downloads");
    await daemon.api.PATCH("/api/v1/settings", { body: { add_trackers: [working] } });
    await page.reload();
    await problems.getByRole("button", { name: "Add trackers to 1 public torrent" }).click();
    await expect.poll(() => trackersOf(idle.hash)).toEqual([working]);
    await expect(problems).toContainText("Every running torrent works with a tracker.", {
      timeout: 30_000,
    });

    // Reclaim on the overview: the idle seeds, deleted after asking.
    await page.goto(`${daemon.url}/stats`);
    await page.getByRole("button", { name: /^Reclaim / }).click();
    const ask = page.getByRole("alertdialog", { name: /^Remove \d idle torrents?\?/ });
    await expect(ask).toBeVisible();
    await ask.getByRole("button", { name: /^Remove/ }).click();
    await expect
      .poll(async () => (await daemon.api.GET("/api/v1/torrents")).data?.map((t) => t.name))
      .toEqual(["big-buck-e2e.bin"]);
    expect(announces).toBeGreaterThan(0);
  } finally {
    await new Promise<void>((ok) => tracker.close(() => ok()));
  }
});
