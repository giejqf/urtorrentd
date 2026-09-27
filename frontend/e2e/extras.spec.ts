// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// What a torrent client is expected to do beyond the designs, against real
// daemons (AGENTS.md 6.4): sources from anywhere (a magnet link the browser
// hands over, pasted, dropped) and the add dialog's download path; the tab
// title; the shortcuts, the accent and units, the quick speed limits; a peer
// banned from a torrent's peers, a tracker's endpoints, and a notification
// when a download finishes.

import { createServer } from "node:http";
import { join } from "node:path";

import { expect, expectAccessible, test } from "./fixtures";
import { makeTorrent } from "./torrent";

test("sources from anywhere, and where incomplete content stays", async ({
  signedIn: page,
  daemon,
}) => {
  const add = page.getByRole("dialog", { name: "Add torrents" });

  // A magnet link handed over by the browser: in the dialog, out of the address.
  const handed = `magnet:?xt=urn:btih:${"1".repeat(40)}&dn=handed-e2e`;
  await page.goto(`${daemon.url}/torrents?add=${encodeURIComponent(handed)}`);
  await expect(add).toBeVisible();
  await expect(add.getByLabel("Sources")).toHaveValue(handed);
  await expect(page).not.toHaveURL(/add=/);
  await add.getByRole("button", { name: "Cancel" }).click();
  await expect(add).toBeHidden();

  // Pasted on the page, then added with a folder for incomplete content.
  const pasted = `magnet:?xt=urn:btih:${"2".repeat(40)}&dn=pasted-e2e`;
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData("text/plain", text);
    document.body.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true }),
    );
  }, pasted);
  await expect(add.getByLabel("Sources")).toHaveValue(pasted);
  await expect(add).toContainText("Off: it downloads straight to the save path.");
  const incoming = join(daemon.savePath, "..", "incoming");
  await add.getByLabel("Keep incomplete in", { exact: true }).fill(incoming);
  await expect(add).toContainText("Moved to the save path when complete.");
  await expectAccessible(page);
  await add.getByRole("button", { name: "Add 1 torrent" }).click();
  await expect(add).toBeHidden();
  await expect
    .poll(
      async () =>
        (
          await daemon.api.GET("/api/v1/torrents/{hash}", {
            params: { path: { hash: "2".repeat(40) } },
          })
        ).data?.download_path,
    )
    .toBe(incoming);

  // A .torrent file dropped anywhere.
  const t = makeTorrent({ name: "dropped-e2e.bin", size: 64 * 1024, pieceLength: 16_384 });
  const data = await page.evaluateHandle((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], "dropped-e2e.torrent", { type: "application/x-bittorrent" }));
    return dt;
  }, t.base64);
  const shell = page.locator("#content");
  await shell.dispatchEvent("dragover", { dataTransfer: data });
  await shell.dispatchEvent("drop", { dataTransfer: data });
  await expect(add).toContainText("dropped-e2e.bin");
  await expect(add.getByRole("tab", { name: ".torrent file" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await add.getByRole("button", { name: "Cancel" }).click();

  // The tab's title says the rates, then the instance.
  await expect(page).toHaveTitle(/^↓ .+\/s ↑ .+\/s · urtorrentd$/);
});

test("shortcuts, accent and units, the quick speed limits", async ({ signedIn: page, daemon }) => {
  const t = makeTorrent({ name: "units-e2e.bin", size: 128 * 1024, pieceLength: 16_384 });
  await daemon.api.POST("/api/v1/torrents", {
    body: { torrents: [t.base64], options: { stopped: true } },
  });
  const list = page.getByRole("listbox", { name: "Torrents" });
  const row = list.getByRole("option", { name: /^units-e2e\.bin/ });
  await expect(row).toContainText("131 kB");

  // ? lists the keys.
  await page.keyboard.press("?");
  const keys = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(keys).toContainText("Switch the alternative limits");
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await expect(keys).toBeHidden();

  // Binary units and another accent, kept for the user.
  const menu = page.getByRole("button", { name: /instance menu$/ });
  await menu.click();
  await page.getByRole("menuitem", { name: "Units" }).click();
  await page.getByRole("menuitemradio", { name: "Binary (MiB, GiB)" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menu")).toHaveCount(0);
  await expect(row).toContainText("128 KiB");
  await menu.click();
  await page.getByRole("menuitem", { name: "Accent" }).click();
  await page.getByRole("menuitemradio", { name: "Green" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await expect(page.locator("html")).toHaveAttribute("data-accent", "green");
  await expect
    .poll(
      async () =>
        (
          await daemon.api.GET("/api/v1/client-data", {
            params: { query: { keys: "webui.units,webui.accent" } },
          })
        ).data,
    )
    .toEqual({ "webui.units": "binary", "webui.accent": "green" });

  // The footer's rates open the limits.
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByRole("button", { name: /^Speed limits:/ }).click();
  const limits = page.getByRole("dialog", { name: "Speed limits" });
  await limits.getByLabel("Download").fill("500");
  await limits.getByLabel("Download").press("Enter");
  await expect
    .poll(async () => (await daemon.api.GET("/api/v1/settings")).data?.download_limit)
    .toBe(500_000);
  await expectAccessible(page);
  await limits.getByRole("switch", { name: /Alternative limits/ }).focus();
  await page.keyboard.press("Space");
  await expect
    .poll(async () => (await daemon.api.GET("/api/v1/transfer")).data?.alt_speed_enabled)
    .toBe(true);
});

test("a finished download told, a tracker's endpoints, a peer banned", async ({
  signedIn: page,
  daemon,
  seeder,
}) => {
  test.setTimeout(120_000);
  const tracker = createServer((_, res) => {
    res.writeHead(200);
    res.end("d8:completei3e10:incompletei1e8:intervali1800e5:peers0:e");
  });
  await new Promise<void>((ok) => tracker.listen(0, "127.0.0.1", ok));
  const port = (tracker.address() as { port: number }).port;
  try {
    // Notifications, recorded instead of shown.
    await page.addInitScript(() => {
      const seen: [string, string | undefined][] = [];
      (window as unknown as { notes: typeof seen }).notes = seen;
      class Note {
        static permission = "granted";
        static requestPermission = () => Promise.resolve("granted");
        constructor(title: string, o?: { body?: string }) {
          seen.push([title, o?.body]);
        }
      }
      Object.defineProperty(window, "Notification", { value: Note, configurable: true });
    });
    await page.goto(`${daemon.url}/torrents`);
    await page.getByRole("button", { name: /instance menu$/ }).click();
    await page.getByRole("menuitemcheckbox", { name: "Notify when downloads finish" }).click();
    await expect
      .poll(
        async () =>
          (
            await daemon.api.GET("/api/v1/client-data", {
              params: { query: { keys: "webui.notify" } },
            })
          ).data?.["webui.notify"],
      )
      .toBe("on");

    await seeder.api.PATCH("/api/v1/settings", { body: { upload_limit: 150_000 } });
    const small = makeTorrent({ name: "told-e2e.bin", size: 300 * 1024, pieceLength: 16_384 });
    const big = makeTorrent({
      name: "banned-e2e.bin",
      size: 4 * 1024 * 1024,
      pieceLength: 65_536,
      trackers: [`http://127.0.0.1:${port}/announce`],
    });
    for (const t of [small, big]) {
      t.writeContent(seeder.savePath);
      await seeder.api.POST("/api/v1/torrents", { body: { torrents: [t.base64] } });
      await seeder.waitFor(t.hash, (x) => x.state === "seeding", "the seed");
    }
    const connect = async (hash: string) => {
      await daemon.api.POST("/api/v1/torrents", {
        body: { torrents: [(hash === small.hash ? small : big).base64] },
      });
      await daemon.api.POST("/api/v1/torrents/peers", {
        body: { hashes: [hash], peers: [await seeder.peerAddress()] },
      });
    };
    await connect(small.hash);
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { notes: unknown[] }).notes), {
        timeout: 30_000,
      })
      .toEqual([["Download finished", "told-e2e.bin"]]);

    // The tracker, announced through each listen socket.
    await connect(big.hash);
    await page.goto(`${daemon.url}/torrents/${big.hash}?tab=trackers`);
    const details = page.getByRole("region", { name: "Details of banned-e2e.bin" });
    const row = details.getByRole("listitem", { name: /^127\.0\.0\.1/ });
    await row.getByRole("button", { name: /endpoints?$/ }).click();
    const endpoints = row.getByRole("list", { name: /^Endpoints of 127\.0\.0\.1/ });
    await expect(endpoints).toContainText("from ");
    await expect(endpoints).toContainText("working · 3 seeds · 1 leechers", { timeout: 20_000 });
    await expectAccessible(page);

    // The seeder banned from the torrent's peers.
    await details.getByRole("tab", { name: "Peers" }).click();
    await details.getByRole("button", { name: /^Peer 127\..*: actions$/ }).click();
    await page.getByRole("menuitem", { name: "Ban this address…" }).click();
    const ask = page.getByRole("alertdialog", { name: `Ban ${seeder.peerIp}?` });
    await expect(ask).toContainText("on every torrent");
    await ask.getByRole("button", { name: "Ban" }).click();
    await expect
      .poll(async () => (await daemon.api.GET("/api/v1/settings")).data?.banned_ips)
      .toContain(seeder.peerIp);
  } finally {
    await new Promise<void>((ok) => tracker.close(() => ok()));
  }
});
