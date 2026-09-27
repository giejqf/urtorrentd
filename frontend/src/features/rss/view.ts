// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The RSS screen's arithmetic over what the daemon keeps: the scope in the
// URL (every feed, a folder, a feed, a rule), feeds in their folders with
// unread counts, the articles in view by age, how links are shown (their
// host only: feed and torrent URLs carry passkeys), a description's text,
// when the next refresh is due, and where a rule's downloads go. Pure and
// tested.

import type { Schemas } from "~/api/client";
import { formatShortDate, localDay } from "~/lib/format";

type Feed = Schemas["RssFeed"];
type Article = Schemas["RssArticle"];
type Rule = Schemas["RssRule"];

export type Scope =
  | { kind: "all" }
  | { kind: "folder"; path: string }
  | { kind: "feed"; id: number }
  | { kind: "rule"; name: string };

export type Show = "all" | "unread" | "downloaded" | "matched";

export const SHOWS: readonly { value: Show; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unread", label: "Unread" },
  { value: "downloaded", label: "Downloaded" },
  { value: "matched", label: "Matches a rule" },
];

/** The URL's search parameters as a scope. */
export function scopeOf(p: { feed?: string; folder?: string; rule?: string }): Scope {
  if (p.rule !== undefined) return { kind: "rule", name: p.rule };
  if (p.feed !== undefined && /^\d+$/.test(p.feed)) return { kind: "feed", id: Number(p.feed) };
  if (p.folder !== undefined) return { kind: "folder", path: p.folder };
  return { kind: "all" };
}

export function isShow(s: string | undefined): s is Show {
  return SHOWS.some((x) => x.value === s);
}

/** A URL's host, or the text itself when it is not a URL. */
export function hostOf(url: string): string {
  try {
    const h = new URL(url).host;
    return h === "" ? url : h;
  } catch {
    return url;
  }
}

/** A feed's name: its label, else its own title, else its host. */
export function feedName(f: Pick<Feed, "name" | "title" | "url">): string {
  return f.name ?? f.title ?? hostOf(f.url);
}

/**
 * A link as the screen shows it: the host and "/…" (the rest can carry a
 * passkey); a magnet link as its info-hash's start.
 */
export function shownLink(url: string): string {
  if (url.toLowerCase().startsWith("magnet:")) {
    const m = /xt=urn:btih:([0-9a-z]+)/i.exec(url);
    return m?.[1] ? `magnet · ${m[1].slice(0, 12).toLowerCase()}…` : "magnet link";
  }
  try {
    const u = new URL(url);
    const rest = u.pathname !== "/" || u.search !== "";
    return `${u.host}${rest ? "/…" : ""}`;
  } catch {
    return "a link";
  }
}

/** Whether a folder path is a folder or inside it. */
export function inFolder(folder: string | null, path: string): boolean {
  return folder !== null && (folder === path || folder.startsWith(`${path}/`));
}

export type TreeNode =
  | { kind: "folder"; path: string; name: string; depth: number; unread: number; failing: number }
  | { kind: "feed"; feed: Feed; depth: number };

/** Every folder with its feeds under it (folders first, by name), then the feeds at the top. */
export function feedTree(feeds: readonly Feed[], folders: readonly string[]): TreeNode[] {
  const all = new Set(folders);
  for (const f of feeds) {
    if (f.folder === null) continue;
    const parts = f.folder.split("/");
    for (let i = 1; i <= parts.length; i += 1) all.add(parts.slice(0, i).join("/"));
  }
  const byName = (a: Feed, b: Feed) => feedName(a).localeCompare(feedName(b));
  const out: TreeNode[] = [];
  const walk = (parent: string | null, depth: number) => {
    const children = [...all]
      .filter((p) => {
        const cut = p.lastIndexOf("/");
        return parent === null ? cut < 0 : p.slice(0, cut) === parent && cut >= 0;
      })
      .sort((a, b) => a.localeCompare(b));
    for (const path of children) {
      const inside = feeds.filter((f) => inFolder(f.folder, path));
      out.push({
        kind: "folder",
        path,
        name: path.slice(path.lastIndexOf("/") + 1),
        depth,
        unread: inside.reduce((n, f) => n + f.unread, 0),
        failing: inside.filter((f) => f.error !== null).length,
      });
      walk(path, depth + 1);
      for (const f of feeds.filter((x) => x.folder === path).sort(byName)) {
        out.push({ kind: "feed", feed: f, depth: depth + 1 });
      }
    }
  };
  walk(null, 0);
  for (const f of feeds.filter((x) => x.folder === null).sort(byName)) {
    out.push({ kind: "feed", feed: f, depth: 0 });
  }
  return out;
}

/** The feeds a scope covers. */
export function feedsIn(scope: Scope, feeds: readonly Feed[], rules: readonly Rule[]): number[] {
  switch (scope.kind) {
    case "all":
      return feeds.map((f) => f.id);
    case "folder":
      return feeds.filter((f) => inFolder(f.folder, scope.path)).map((f) => f.id);
    case "feed":
      return feeds.some((f) => f.id === scope.id) ? [scope.id] : [];
    case "rule":
      return rules.find((r) => r.name === scope.name)?.feeds ?? [];
  }
}

/** The articles a scope shows (a rule's are its matches, asked of the daemon). */
export function visibleArticles(
  articles: readonly Article[],
  scope: Scope,
  feeds: readonly Feed[],
  show: Show,
  text: string,
): Article[] {
  const ids = new Set(
    scope.kind === "folder"
      ? feeds.filter((f) => inFolder(f.folder, scope.path)).map((f) => f.id)
      : [],
  );
  const words = text.trim().toLowerCase();
  return articles.filter(
    (a) =>
      (scope.kind !== "feed" || a.feed === scope.id) &&
      (scope.kind !== "folder" || ids.has(a.feed)) &&
      (show === "all" ||
        (show === "unread" && !a.read) ||
        (show === "downloaded" && a.downloaded) ||
        (show === "matched" && a.matched_rule !== null)) &&
      (words === "" || a.title.toLowerCase().includes(words)),
  );
}

export interface ArticleGroup {
  key: string;
  label: string;
  articles: Article[];
}

/** Articles (newest first) by age: today, yesterday, earlier this week, older, undated. */
export function byAge(
  articles: readonly Article[],
  now: number,
  timeZone?: string,
): ArticleGroup[] {
  const today = localDay(now, { timeZone });
  const yesterday = localDay(now - 86_400, { timeZone });
  const order = ["today", "yesterday", "week", "older", "undated"] as const;
  const labels = {
    today: "Today",
    yesterday: "Yesterday",
    week: "Earlier this week",
    older: "Older",
    undated: "Undated",
  };
  const groups = new Map<(typeof order)[number], Article[]>();
  for (const a of articles) {
    const day = a.date === null ? null : localDay(a.date, { timeZone });
    const key =
      day === null
        ? "undated"
        : day === today
          ? "today"
          : day === yesterday
            ? "yesterday"
            : a.date !== null && a.date > now - 7 * 86_400
              ? "week"
              : "older";
    const list = groups.get(key) ?? [];
    list.push(a);
    groups.set(key, list);
  }
  return order
    .filter((k) => groups.has(k))
    .map((k) => ({ key: k, label: labels[k], articles: groups.get(k) ?? [] }));
}

/** When an article came, short: `12 min`, `13 h`, else its date (`Sep 24`). */
export function whenLabel(date: number | null, now: number, timeZone?: string): string {
  if (date === null) return "—";
  const age = now - date;
  if (age >= 0 && age < 3600) return `${Math.max(Math.floor(age / 60), 1)} min`;
  if (age >= 0 && age < 86_400) return `${Math.floor(age / 3600)} h`;
  return formatShortDate(date, { timeZone });
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
};

/**
 * A description as plain text: the feed's HTML with its tags dropped
 * (breaks and blocks as new lines), entities decoded, spaces tidied. It is
 * never rendered as HTML (AGENTS.md rule 6).
 */
export function htmlText(html: string): string {
  const text = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/?\s*(p|div|li|tr|h[1-6]|blockquote|pre|ul|ol|table)\b[^>]*>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e.startsWith("#x") || e.startsWith("#X")) {
        const n = parseInt(e.slice(2), 16);
        return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      if (e.startsWith("#")) {
        const n = parseInt(e.slice(1), 10);
        return Number.isFinite(n) && n <= 0x10ffff ? String.fromCodePoint(n) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    });
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t\r\f\v]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * When the next refresh is due: a feed is due its interval (its own, else
 * the setting) after its last refresh, and at once when never refreshed
 * (the daemon's rule). `null` while polling is off.
 */
export function nextRefresh(
  feeds: readonly Pick<Feed, "refresh_interval" | "last_refresh">[],
  enabled: boolean,
  every: number,
  now: number,
): number | null {
  if (!enabled || feeds.length === 0) return null;
  return Math.max(
    now,
    Math.min(
      ...feeds.map((f) =>
        f.last_refresh === null ? now : f.last_refresh + Math.max(60, f.refresh_interval ?? every),
      ),
    ),
  );
}

/** Whether the jar sends a cookie for `domain` to `host` (that host and its subdomains). */
export function cookieFor(domain: string, host: string): boolean {
  const d = domain.toLowerCase().replace(/^\./, "");
  return host === d || host.endsWith(`.${d}`);
}
