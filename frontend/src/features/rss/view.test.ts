// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import type { Schemas } from "~/api/client";

import {
  newRule,
  ruleChanged,
  ruleDraft,
  ruleProblems,
  ruleRequest,
  ruleSavePath,
} from "./rule-form";
import {
  byAge,
  feedName,
  feedsIn,
  feedTree,
  htmlText,
  nextRefresh,
  scopeOf,
  shownLink,
  visibleArticles,
  whenLabel,
} from "./view";

const TZ = "UTC";
const NOW = Date.UTC(2026, 8, 26, 10, 0, 0) / 1000;

function feed(id: number, folder: string | null, extra: Partial<Schemas["RssFeed"]> = {}) {
  return {
    id,
    url: `https://indexer.example/rss/${id}?passkey=secret`,
    name: null,
    title: `Feed ${id}`,
    folder,
    refresh_interval: null,
    last_refresh: null,
    error: null,
    loading: false,
    articles: 10,
    unread: id,
    ...extra,
  } satisfies Schemas["RssFeed"];
}

function article(
  feedId: number,
  id: string,
  hoursAgo: number | null,
  extra: Partial<Schemas["RssArticle"]> = {},
) {
  return {
    id,
    feed: feedId,
    title: `Title ${id}`,
    date: hoursAgo === null ? null : NOW - hoursAgo * 3600,
    link: null,
    torrent_url: null,
    description: null,
    author: null,
    size: null,
    read: false,
    downloaded: false,
    matched_rule: null,
    ...extra,
  } satisfies Schemas["RssArticle"];
}

const FEEDS = [
  feed(1, "linux"),
  feed(2, "linux/arm", { error: "HTTP 503" }),
  feed(3, null, { name: "My label" }),
  feed(4, "movies"),
];

describe("feeds", () => {
  it("reads the scope from the URL", () => {
    expect(scopeOf({})).toEqual({ kind: "all" });
    expect(scopeOf({ feed: "3" })).toEqual({ kind: "feed", id: 3 });
    expect(scopeOf({ feed: "x" })).toEqual({ kind: "all" });
    expect(scopeOf({ folder: "tv/anime" })).toEqual({ kind: "folder", path: "tv/anime" });
    expect(scopeOf({ rule: "Shows", feed: "1" })).toEqual({ kind: "rule", name: "Shows" });
  });

  it("puts feeds in their folders, nested, with what is unread", () => {
    const tree = feedTree(FEEDS, ["linux", "empty"]);
    expect(
      tree.map((n) =>
        n.kind === "folder"
          ? `${"  ".repeat(n.depth)}[${n.name}] ${n.unread} ${n.failing}`
          : `${"  ".repeat(n.depth)}${feedName(n.feed)}`,
      ),
    ).toEqual([
      "[empty] 0 0",
      "[linux] 3 1",
      "  [arm] 2 1",
      "    Feed 2",
      "  Feed 1",
      "[movies] 4 0",
      "  Feed 4",
      "My label",
    ]);
  });

  it("knows the feeds a scope covers", () => {
    const rules = [{ name: "R", feeds: [4, 1] }] as unknown as Schemas["RssRule"][];
    expect(feedsIn({ kind: "all" }, FEEDS, rules)).toEqual([1, 2, 3, 4]);
    expect(feedsIn({ kind: "folder", path: "linux" }, FEEDS, rules)).toEqual([1, 2]);
    expect(feedsIn({ kind: "feed", id: 9 }, FEEDS, rules)).toEqual([]);
    expect(feedsIn({ kind: "rule", name: "R" }, FEEDS, rules)).toEqual([4, 1]);
  });

  it("shows links by host only", () => {
    expect(shownLink("https://indexer.example/dl/123/PASSKEY/x.torrent")).toBe("indexer.example/…");
    expect(shownLink("https://example.org")).toBe("example.org");
    expect(shownLink("magnet:?xt=urn:btih:ABCDEF0123456789ABCD&tr=x")).toBe(
      "magnet · abcdef012345…",
    );
    expect(feedName(feed(9, null, { title: null }))).toBe("indexer.example");
  });

  it("says when the next refresh is due, by the daemon's rule", () => {
    const f = (last: number | null, every: number | null = null) => ({
      last_refresh: last,
      refresh_interval: every,
    });
    expect(nextRefresh([f(NOW - 600)], true, 900, NOW)).toBe(NOW + 300);
    expect(nextRefresh([f(NOW - 600, 3600), f(NOW - 100)], true, 900, NOW)).toBe(NOW + 800);
    expect(nextRefresh([f(null)], true, 900, NOW)).toBe(NOW);
    expect(nextRefresh([f(NOW - 2000)], true, 900, NOW)).toBe(NOW);
    expect(nextRefresh([f(NOW)], false, 900, NOW)).toBeNull();
  });
});

describe("articles", () => {
  const ARTICLES = [
    article(1, "a", 2, { matched_rule: "R" }),
    article(2, "b", 20, { read: true }),
    article(4, "c", 30, { downloaded: true, read: true, matched_rule: "R" }),
    article(3, "d", 100),
    article(1, "e", 24 * 20),
    article(3, "f", null),
  ];

  it("filters by scope, kind and title", () => {
    const ids = (a: Schemas["RssArticle"][]) => a.map((x) => x.id).join("");
    const all = { kind: "all" } as const;
    expect(ids(visibleArticles(ARTICLES, all, FEEDS, "all", ""))).toBe("abcdef");
    expect(ids(visibleArticles(ARTICLES, all, FEEDS, "unread", ""))).toBe("adef");
    expect(ids(visibleArticles(ARTICLES, all, FEEDS, "downloaded", ""))).toBe("c");
    expect(ids(visibleArticles(ARTICLES, all, FEEDS, "matched", ""))).toBe("ac");
    expect(
      ids(visibleArticles(ARTICLES, { kind: "folder", path: "linux" }, FEEDS, "all", "")),
    ).toBe("abe");
    expect(ids(visibleArticles(ARTICLES, { kind: "feed", id: 3 }, FEEDS, "all", "TITLE D"))).toBe(
      "d",
    );
  });

  it("groups by age and says when", () => {
    expect(byAge(ARTICLES, NOW, TZ).map((g) => [g.label, g.articles.length])).toEqual([
      ["Today", 1],
      ["Yesterday", 2],
      ["Earlier this week", 1],
      ["Older", 1],
      ["Undated", 1],
    ]);
    expect(whenLabel(NOW - 90, NOW, TZ)).toBe("1 min");
    expect(whenLabel(NOW - 13 * 3600, NOW, TZ)).toBe("13 h");
    expect(whenLabel(NOW - 3 * 86_400, NOW, TZ)).toBe("Sep 23");
    expect(whenLabel(null, NOW, TZ)).toBe("—");
  });

  it("turns a description's HTML into text, never markup", () => {
    expect(
      htmlText(
        '<p>Official image.&nbsp;SHA-256 &amp; signatures.</p><p>Seeded <b>by</b> the project.<br/>2 &lt;GB&gt; &#8212; &#x263A;</p><script>alert(1)</script><img src=x onerror="x">',
      ),
    ).toBe("Official image. SHA-256 & signatures.\n\nSeeded by the project.\n2 <GB> — ☺");
    expect(htmlText("plain   text\n\n\n\nmore")).toBe("plain text\n\nmore");
  });
});

describe("rules", () => {
  const RULE = {
    name: "Shows",
    enabled: true,
    must_contain: "show 1080p",
    must_not_contain: "",
    use_regex: false,
    episode_filter: "",
    smart_filter: true,
    feeds: [1],
    ignore_days: 0,
    add_options: { category: "tv", tags: ["x"], upload_limit: 1000 },
    last_match: null,
    matched_episodes: [],
  } satisfies Schemas["RssRule"];

  it("edits a rule and keeps the add options it does not show", () => {
    const d = ruleDraft(RULE);
    expect(ruleChanged(RULE, d)).toBe(false);
    expect(ruleProblems(d)).toEqual({});
    const next = {
      ...d,
      feeds: [1, 4],
      start: "stopped" as const,
      save_path_on: true,
      save_path: "/data/tv",
    };
    expect(ruleChanged(RULE, next)).toBe(true);
    expect(ruleRequest(RULE, next)).toMatchObject({
      feeds: [1, 4],
      add_options: {
        category: "tv",
        tags: ["x"],
        upload_limit: 1000,
        save_path: "/data/tv",
        stopped: true,
      },
      reset_history: false,
    });
    expect(
      ruleProblems({ ...d, name: " ", ignore_days: "x", save_path_on: true, save_path: "rel" }),
    ).toEqual({
      name: "A rule needs a name.",
      ignore_days: "Days, 0 for none.",
      save_path: "An absolute path, starting with /.",
    });
    // A new rule reads no feed: it takes nothing until given one.
    expect(newRule().feeds).toEqual([]);
  });

  it("says where a rule's downloads go", () => {
    const s = { save_path: "/data", auto_management: false, category_paths_in_manual_mode: false };
    const cats = { tv: { save_path: "shows", download_path: null } } as unknown as Record<
      string,
      Schemas["Category"]
    >;
    expect(ruleSavePath({ category: "tv" }, cats, s)).toBe("/data");
    expect(ruleSavePath({ category: "tv", auto_management: true }, cats, s)).toBe("/data/shows");
    expect(ruleSavePath({ category: "new" }, cats, { ...s, auto_management: true })).toBe(
      "/data/new",
    );
    expect(ruleSavePath({ save_path: "/x" }, cats, s)).toBe("/x");
    expect(
      ruleSavePath({ category: "tv" }, cats, { ...s, category_paths_in_manual_mode: true }),
    ).toBe("/data/shows");
  });
});
