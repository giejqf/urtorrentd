// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The detail panel's tabs against real daemons (AGENTS.md 7.4): a
// multi-file torrent downloaded slowly from a second daemon, with a tracker
// on loopback whose URL carries a passkey; its files, peers, trackers and
// web seeds, its history, and its options saved as one draft; a torrent's
// piece hashes.

import { readFileSync } from "node:fs";
import { createServer } from "node:http";

import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

test("the detail tabs: files, peers, trackers and history", async ({
  signedIn: page,
  daemon,
  seeder,
}) => {
  test.setTimeout(150_000);
  let announces = 0;
  const tracker = createServer((_, res) => {
    announces += 1;
    res.writeHead(200);
    res.end("d8:completei186e10:incompletei24e8:intervali1800e5:peers0:e");
  });
  await new Promise<void>((ok) => tracker.listen(0, "127.0.0.1", ok));
  const port = (tracker.address() as { port: number }).port;
  const announce = `http://127.0.0.1:${port}/s3cr3tpasskey/announce`;
  try {
    const t = makeTorrent({
      name: "Elephants_Dream",
      files: [
        { path: "movie.mkv", size: 3 * 1024 * 1024 },
        { path: "subtitles/en.srt", size: 61_000 },
        { path: "subtitles/nl.srt", size: 58_000 },
        { path: "commentary.ogg", size: 300_000 },
        { path: "poster.png", size: 120_000 },
      ],
      pieceLength: 65_536,
      trackers: [announce],
    });
    t.writeContent(seeder.savePath);
    await seeder.api.PATCH("/api/v1/settings", { body: { upload_limit: 150_000 } });
    await seeder.api.POST("/api/v1/torrents", { body: { torrents: [t.base64] } });
    await seeder.waitFor(t.hash, (x) => x.state === "seeding", "the seed");
    await daemon.api.POST("/api/v1/torrents", { body: { torrents: [t.base64] } });
    await daemon.api.POST("/api/v1/torrents/peers", {
      body: { hashes: [t.hash], peers: [await seeder.peerAddress()] },
    });
    const files = async () =>
      (
        await daemon.api.GET("/api/v1/torrents/{hash}/files", {
          params: { path: { hash: t.hash } },
        })
      ).data ?? [];

    await page.goto(`${daemon.url}/torrents/${t.hash}`);
    const details = page.getByRole("region", { name: "Details of Elephants_Dream" });
    const tabs = details.getByRole("tablist");

    // Files: a tree with checkboxes and priorities, renames.
    await tabs.getByRole("tab", { name: "Files" }).click();
    await expect(page).toHaveURL(/tab=files/);
    const table = details.getByRole("table", { name: "Files" });
    await expect(table.getByRole("button", { name: "poster.png", exact: true })).toBeVisible();
    await expect(details).toContainText("5 files");
    await expectAccessible(page);
    await table.getByRole("checkbox", { name: "Download Elephants_Dream/poster.png" }).focus();
    await page.keyboard.press("Space");
    await expect
      .poll(async () => (await files()).find((f) => f.path.endsWith("poster.png"))?.priority)
      .toBe(0);
    await expect(details).toContainText("wanted of");
    await table
      .getByRole("button", { name: /^Priority of Elephants_Dream\/subtitles\/en\.srt/ })
      .click();
    await page.getByRole("menuitemradio", { name: "High" }).click();
    await expect
      .poll(async () => (await files()).find((f) => f.path.endsWith("en.srt"))?.priority)
      .toBe(6);
    // The folder's files at once, from the toolbar.
    await table.getByRole("button", { name: "subtitles", exact: true }).click();
    await details.getByRole("button", { name: "Priority", exact: true }).click();
    await expect(page.getByRole("menu")).toContainText("2 chosen files");
    await page.getByRole("menuitem", { name: "Low" }).click();
    await expect
      .poll(async () =>
        (await files()).filter((f) => f.path.includes("subtitles/")).map((f) => f.priority),
      )
      .toEqual([1, 1]);
    await table.getByRole("button", { name: "commentary.ogg", exact: true }).click();
    await details.getByRole("button", { name: "Rename" }).click();
    const rename = page.getByRole("dialog", { name: "Rename file" });
    await rename.getByLabel("Name").fill("commentary.opus");
    await rename.getByRole("button", { name: "Rename" }).click();
    await expect
      .poll(async () => (await files()).map((f) => f.path))
      .toContain("Elephants_Dream/commentary.opus");
    await table.getByRole("button", { name: "Close subtitles" }).click();
    await expect(table.getByRole("button", { name: "en.srt", exact: true })).toBeHidden();

    // Peers: the seeder, connected.
    await tabs.getByRole("tab", { name: "Peers" }).click();
    const peers = details.getByRole("list", { name: "Peers" });
    await expect(peers.getByRole("listitem").filter({ hasText: seeder.peerIp })).toBeVisible();
    await expect(details).toContainText("1 connected");
    await expect(details.getByRole("link", { name: "Map" })).toHaveAttribute(
      "href",
      `/stats/peers?hash=${t.hash}`,
    );
    await expect(details).toContainText("swarm 186 seeds · 24 leechers");
    await expectAccessible(page);

    // Trackers: the host only, the whole URL while it is edited.
    await tabs.getByRole("tab", { name: "Trackers" }).click();
    const trackerRow = details.getByRole("listitem", { name: "127.0.0.1" });
    await expect(trackerRow).toContainText("working · 186 seeds · 24 leechers");
    await expect(details).not.toContainText("s3cr3tpasskey");
    await expectAccessible(page);
    // This tracker alone, now.
    const before = announces;
    await trackerRow.getByRole("button", { name: "Reannounce", exact: true }).click();
    await expect.poll(() => announces).toBeGreaterThan(before);
    await trackerRow.getByRole("button", { name: "Edit URL" }).click();
    const url = details.getByLabel("URL of 127.0.0.1");
    await expect(url).toHaveValue(announce);
    const moved = announce.replace("s3cr3tpasskey", "n3wpasskey");
    await url.fill(moved);
    await details.getByRole("button", { name: "Save" }).click();
    const trackerUrls = async () =>
      (
        await daemon.api.GET("/api/v1/torrents/{hash}/trackers", {
          params: { path: { hash: t.hash } },
        })
      ).data?.trackers.map((x) => [x.url, x.tier]) ?? [];
    await expect.poll(trackerUrls).toEqual([[moved, 0]]);
    // Typed ones share a new tier.
    await details
      .getByLabel("Tracker URLs to add")
      .fill("udp://127.0.0.1:1/announce\nudp://127.0.0.1:2/announce");
    await details.getByRole("button", { name: "Add", exact: true }).first().click();
    await expect.poll(trackerUrls).toEqual([
      [moved, 0],
      ["udp://127.0.0.1:1/announce", 1],
      ["udp://127.0.0.1:2/announce", 1],
    ]);
    // A public torrent is offered the trackers new public torrents get.
    await daemon.api.PATCH("/api/v1/settings", {
      body: { add_trackers: ["udp://127.0.0.1:3/announce"] },
    });
    await page.reload();
    await details.getByRole("button", { name: "Add 1 tracker" }).click();
    await expect.poll(async () => (await trackerUrls()).length).toBe(4);
    await details
      .getByRole("listitem", { name: "127.0.0.1" })
      .filter({ hasText: "tier 1" })
      .first()
      .getByRole("button", { name: "Remove" })
      .click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect.poll(async () => (await trackerUrls()).length).toBe(3);
    // Web seeds.
    const webSeeds = details.getByRole("region", { name: "Web seeds" });
    await webSeeds.getByRole("button", { name: "Add" }).click();
    await webSeeds.getByLabel("Web seed URL to add").fill("http://127.0.0.1:9/iso/");
    await webSeeds.getByRole("button", { name: "Add" }).last().click();
    const seeds = async () =>
      (
        await daemon.api.GET("/api/v1/torrents/{hash}/webseeds", {
          params: { path: { hash: t.hash } },
        })
      ).data;
    await expect.poll(seeds).toEqual(["http://127.0.0.1:9/iso/"]);
    await webSeeds.getByRole("button", { name: "Remove web seed http://127.0.0.1:9/iso/" }).click();
    await expect.poll(seeds).toEqual([]);

    // History: what was recorded, and deleting it.
    await daemon.waitFor(t.hash, (x) => (x.downloaded as number) > 0, "some download");
    await tabs.getByRole("tab", { name: "History" }).click();
    await expect(details.getByRole("img", { name: "Seeding days, last 12 weeks" })).toBeVisible({
      timeout: 20_000,
    });
    await expect(details.getByRole("img", { name: /^Last 24 hours: / })).toBeVisible();
    await expect(details.getByRole("link", { name: "Open in Timeline" })).toHaveAttribute(
      "href",
      `/stats/timeline?hash=${t.hash}`,
    );
    await expectAccessible(page);
    await details.getByRole("button", { name: "Delete history" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("History deleted")).toBeVisible();
  } finally {
    await new Promise<void>((ok) => tracker.close(() => ok()));
  }
});

test("the Options tab saves one draft, and asks before leaving it", async ({
  signedIn: page,
  daemon,
}) => {
  const t = makeTorrent({ name: "Sintel_2010", size: 256 * 1024, pieceLength: 65_536 });
  const other = makeTorrent({ name: "Tears_of_Steel", size: 128 * 1024, pieceLength: 65_536 });
  for (const x of [t, other]) {
    await daemon.api.POST("/api/v1/torrents", {
      body: {
        torrents: [x.base64],
        options: { stopped: true, category: "movies", auto_management: true },
      },
    });
  }
  const row = async () =>
    (await daemon.api.GET("/api/v1/torrents/{hash}", { params: { path: { hash: t.hash } } })).data;

  await page.goto(`${daemon.url}/torrents/${t.hash}?tab=options`);
  const details = page.getByRole("region", { name: "Details of Sintel_2010" });
  await expect(details.getByRole("tab", { name: "Options" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expectAccessible(page);
  await details.getByLabel("Upload limit", { exact: true }).fill("5000");
  await details.getByLabel("Peer connections", { exact: true }).fill("80");
  await details
    .getByRole("radiogroup", { name: "Ratio: where the limit comes from" })
    .getByRole("radio", { name: "Own" })
    .click();
  await details.getByLabel("Ratio limit").fill("2.5");
  await details
    .getByRole("radiogroup", { name: "When a limit is reached" })
    .getByRole("radio", { name: "Remove", exact: true })
    .click();
  await details.getByLabel("Comment").fill("from the open movie project");
  await details.getByRole("switch", { name: /^Sequential download/ }).focus();
  await page.keyboard.press("Space");
  const bar = details.getByRole("region", { name: "Unsaved changes" });
  await expect(bar).toContainText("6 unsaved changes");
  // The draft outlasts a switch of tab.
  await details.getByRole("tab", { name: "Files" }).click();
  await details.getByRole("tab", { name: "Options" }).click();
  await expect(bar).toContainText("6 unsaved changes");
  await bar.getByRole("button", { name: "Save" }).click();
  await expect(bar).toBeHidden();
  const saved = await row();
  expect(saved).toMatchObject({
    upload_limit: 5_000_000,
    max_connections: 80,
    comment: "from the open movie project",
    sequential: true,
    share_limits: {
      ratio: { mode: "limit", value: 2.5 },
      seeding_time: { mode: "global" },
      action: "remove",
    },
  });
  await expect(details.getByLabel("Upload limit", { exact: true })).toHaveValue("5 000");

  // Leaving the torrent with a change asks first.
  await details.getByLabel("Display name").fill("Sintel (2010)");
  await page.getByRole("option", { name: /Tears_of_Steel/ }).click();
  const leave = page.getByRole("alertdialog", { name: "Leave without saving?" });
  await expect(leave).toContainText("Display name");
  await leave.getByRole("button", { name: "Stay" }).click();
  await expect(page).toHaveURL(new RegExp(t.hash));
  await bar.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await row())?.name).toBe("Sintel (2010)");
  // An empty name gives the torrent back its own.
  await details.getByLabel("Display name").fill("");
  await bar.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await row())?.name).toBe("Sintel_2010");

  // Automatic management off, and the content moved.
  const auto = details.getByRole("switch", { name: /^Automatic management/ });
  await expect(auto).toBeChecked();
  await expect(details.getByRole("textbox", { name: "Save path" })).toBeDisabled();
  await auto.focus();
  await page.keyboard.press("Space");
  await expect(auto).not.toBeChecked();
  const target = `${daemon.savePath}/elsewhere`;
  await details.getByRole("textbox", { name: "Save path" }).fill(target);
  await expect(details).toContainText("Saving moves the content there.");
  await bar.getByRole("button", { name: "Save" }).click();
  await expect.poll(async () => (await row())?.save_path).toBe(target);
  expect((await row())?.auto_management).toBe(false);
});

test("a torrent's piece hashes, as the daemon has them", async ({ signedIn: page, daemon }) => {
  const t = makeTorrent({ name: "Hashes_e2e", size: 200 * 1024, pieceLength: 16_384 });
  t.writeContent(daemon.savePath);
  await daemon.api.POST("/api/v1/torrents", { body: { torrents: [t.base64] } });
  await daemon.waitFor(t.hash, (x) => x.state === "seeding", "a seed");
  const hashes =
    (
      await daemon.api.GET("/api/v1/torrents/{hash}/pieces/hashes", {
        params: { path: { hash: t.hash } },
      })
    ).data ?? [];
  expect(hashes).toHaveLength(13);

  await page.goto(`${daemon.url}/torrents/${t.hash}`);
  const details = page.getByRole("region", { name: "Details of Hashes_e2e" });
  await details.getByRole("button", { name: "More actions" }).click();
  await page.getByRole("menuitem", { name: "Piece hashes…" }).click();
  const dialog = page.getByRole("dialog", { name: "Piece hashes" });
  await expect(dialog).toContainText("13 pieces of 16 KiB · SHA-1");
  await expect(dialog).toContainText("13 of 13 verified");
  const table = dialog.getByRole("table", { name: "Piece hashes" });
  await expect(table.getByRole("row").first()).toContainText(hashes[0] ?? "-");
  await expect(table.getByRole("row").first()).toContainText("Have");
  await expectAccessible(page);

  // Found by the start of its hash, or its number.
  const find = dialog.getByLabel("Find a piece by number or hash");
  await find.fill((hashes[12] ?? "").slice(0, 8));
  await expect(dialog).toContainText("Piece 12");
  await find.fill("13");
  await expect(dialog).toContainText("No such piece");

  // Saved as text: one hash per line, in piece order.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    dialog.getByRole("button", { name: "Save as text" }).click(),
  ]);
  expect(download.suggestedFilename()).toBe("Hashes_e2e.sha1.txt");
  expect(readFileSync(await download.path(), "utf8")).toBe(`${hashes.join("\n")}\n`);
});
