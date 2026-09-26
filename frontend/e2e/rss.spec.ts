// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The RSS screen against a real daemon and a feed server on loopback
// (AGENTS.md 7.4): feeds added and changed from the sidebar, articles read
// and filtered, descriptions shown as text, links by host only, a rule made
// and edited with its dry run, and an article's torrent in the add dialog.

import { createServer } from "node:http";

import { expect, expectAccessible, test } from "./fixtures";

const hour = 3600e3;
const item = (n: number, title: string, hoursAgo: number, description: string) =>
  `<item><title>${title}</title><guid>item-${n}</guid><link>https://releases.example.org/${n}?token=do-not-show</link>` +
  `<author>Canonical</author><pubDate>${new Date(Date.now() - hoursAgo * hour).toUTCString()}</pubDate>` +
  `<description>${description}</description>` +
  `<enclosure url="magnet:?xt=urn:btih:${String(n).repeat(40)}&amp;tr=http://t.example/announce?passkey=do-not-show" length="${n * 1_000_000_000}" type="application/x-bittorrent"/></item>`;

const FEED = `<?xml version="1.0"?><rss version="2.0"><channel><title>Linux ISOs</title>${[
  item(
    1,
    "ubuntu-24.04.3-desktop-amd64.iso",
    2,
    "&lt;p&gt;Official image.&lt;/p&gt;&lt;script&gt;alert(1)&lt;/script&gt;&lt;p&gt;Seeded by the project.&lt;/p&gt;",
  ),
  item(2, "archlinux-2026.09.01-x86_64.iso", 30, "Monthly snapshot"),
  item(3, "debian-13.1.0-amd64-netinst.iso", 400, "Netinst"),
].join("")}</channel></rss>`;

test("rss: feeds, articles, a rule and its dry run", async ({ signedIn: page, daemon }) => {
  let hits = 0;
  const server = createServer((req, res) => {
    hits += 1;
    if (!(req.url ?? "").startsWith("/linux.xml")) {
      res.writeHead(503);
      res.end();
      return;
    }
    res.writeHead(200, { "content-type": "application/rss+xml" });
    res.end(FEED);
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const port = (server.address() as { port: number }).port;
  try {
    await page.goto(`${daemon.url}/rss`);
    await expect(page.getByRole("heading", { name: "All articles", level: 1 })).toBeVisible();
    await expect(page.getByText("No feed yet: add one from the sidebar.")).toBeVisible();

    // A feed added from the sidebar, in a folder.
    await page.getByRole("button", { name: "Add a feed or folder" }).click();
    await page.getByRole("menuitem", { name: "Add feed…" }).click();
    const add = page.getByRole("dialog", { name: "Add feed" });
    await add.getByLabel("URL").fill(`http://127.0.0.1:${port}/linux.xml?passkey=do-not-show`);
    await add.getByLabel("Folder").fill("linux");
    await expectAccessible(page);
    await add.getByRole("button", { name: "Add feed" }).click();
    await expect(add).toBeHidden();
    const sidebar = page.getByRole("complementary", { name: "Sidebar" });
    const feeds = sidebar.getByRole("region", { name: "Feeds" });
    await expect(feeds.getByRole("button", { name: /^Linux ISOs \d+$/ })).toBeVisible();
    await expect(feeds.getByRole("button", { name: /^linux 3$/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Linux ISOs", level: 1 })).toBeVisible();
    const list = page.getByRole("list", { name: "Articles" });
    await expect(list.getByRole("button")).toHaveCount(3);
    await expect(page.locator("body")).not.toContainText("do-not-show");

    // One article: its text, links by host, marks.
    await list.getByRole("button", { name: /ubuntu-24\.04\.3-desktop/ }).click();
    const panel = page.getByRole("complementary", { name: "Article" });
    await expect(
      panel.getByRole("heading", { name: "ubuntu-24.04.3-desktop-amd64.iso" }),
    ).toBeVisible();
    await expect(panel.getByLabel("Description")).toHaveText(
      "Official image.\n\nSeeded by the project.",
    );
    await expect(panel).toContainText("releases.example.org/…");
    await expect(panel).toContainText("magnet · 111111111111…");
    await expect(panel).not.toContainText("do-not-show");
    await expect(panel).toContainText("Unread");
    await panel.getByRole("button", { name: "Mark read" }).click();
    await expect(panel.getByRole("button", { name: "Mark unread" })).toBeVisible();
    const read = async () =>
      (await daemon.api.GET("/api/v1/rss/articles")).data?.find((a) => a.id === "item-1")?.read;
    await expect.poll(read).toBe(true);
    await panel.getByRole("button", { name: "Mark unread" }).click();
    await expect.poll(read).toBe(false);

    // Its torrent, in the add dialog.
    await panel.getByRole("button", { name: "Download" }).click();
    const adding = page.getByRole("dialog", { name: "Add torrents" });
    await expect(adding.getByRole("textbox").first()).toHaveValue(/^magnet:\?xt=urn:btih:1{40}/);
    await page.keyboard.press("Escape");
    await expect(adding).toBeHidden();

    // Filters: unread, a title.
    await page.getByRole("button", { name: "Unread", exact: true }).click();
    await expect(list.getByRole("button")).toHaveCount(3);
    await page.getByLabel("Filter titles").fill("arch");
    await expect(list.getByRole("button")).toHaveCount(1);
    await page.getByLabel("Filter titles").fill("");
    await page.getByRole("button", { name: "All", exact: true }).click();

    // A rule: made, edited, and what it takes.
    await sidebar.getByRole("button", { name: "New rule" }).click();
    const prompt = page.getByRole("dialog", { name: "New rule" });
    await prompt.getByLabel("Rule name").fill("Ubuntu");
    await prompt.getByRole("button", { name: "Make" }).click();
    await expect(page.getByRole("heading", { name: "Rule · Ubuntu", level: 1 })).toBeVisible();
    const editor = page.getByRole("form", { name: "Rule Ubuntu" });
    await expect(editor).toContainText("Its filters take 0 of the articles kept");
    await editor.getByLabel("Must contain").fill("ubuntu*");
    await editor.getByText("Linux ISOs", { exact: true }).click();
    await expectAccessible(page);
    await editor.getByRole("button", { name: "Save rule" }).click();
    await expect(editor).toContainText("Its filters take 1 of the articles kept");
    await expect(list.getByRole("button")).toHaveCount(1);
    const rules = (await daemon.api.GET("/api/v1/rss/rules")).data ?? [];
    expect(rules[0]).toMatchObject({ name: "Ubuntu", must_contain: "ubuntu*", feeds: [1] });

    // Back to every article: the match is shown, and how it would be added.
    await feeds.getByRole("button", { name: /^All articles/ }).click();
    await page.getByRole("button", { name: "Matches a rule" }).click();
    await expect(list.getByRole("button")).toHaveCount(1);
    await list.getByRole("button").first().click();
    await expect(panel).toContainText("Matches “Ubuntu”");
    await expect(panel).toContainText("Would be added as");
    await panel.getByRole("button", { name: "Edit rule" }).click();
    await expect(page.getByRole("heading", { name: "Rule · Ubuntu", level: 1 })).toBeVisible();

    // Feeds: refresh, mark read, rename, remove.
    await feeds.getByRole("button", { name: /^All articles/ }).click();
    const before = hits;
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect.poll(() => hits).toBeGreaterThan(before);
    await page.getByRole("button", { name: "Mark all read" }).click();
    await expect
      .poll(async () => (await daemon.api.GET("/api/v1/rss/feeds")).data?.[0]?.unread)
      .toBe(0);
    await feeds.getByRole("button", { name: "Linux ISOs: actions" }).click();
    await page.getByRole("menuitem", { name: "Edit…" }).click();
    const edit = page.getByRole("dialog", { name: "Edit feed" });
    await expect(edit.getByLabel("URL")).toHaveValue(/passkey=do-not-show/);
    await edit.getByLabel("Name").fill("Ubuntu and friends");
    await edit.getByRole("button", { name: "Save feed" }).click();
    await expect(feeds.getByRole("button", { name: /^Ubuntu and friends/ }).first()).toBeVisible();
    await feeds.getByRole("button", { name: "Ubuntu and friends: actions" }).click();
    await page.getByRole("menuitem", { name: "Remove…" }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove" }).click();
    await expect(feeds.getByRole("button", { name: /^Ubuntu and friends/ })).toHaveCount(0);
    expect((await daemon.api.GET("/api/v1/rss/feeds")).data).toEqual([]);
  } finally {
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});
