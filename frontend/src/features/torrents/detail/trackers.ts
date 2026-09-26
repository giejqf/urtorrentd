// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Trackers tab's model: how a tracker stands in one line, where URLs
// typed one per line go, and the trackers new public torrents get that
// this one lacks. A URL shows as its host only (it can carry a passkey);
// the whole URL appears only in its edit field. Pure and tested.

import type { Schemas } from "~/api/client";
import { formatCount } from "~/lib/format";

type Tracker = Schemas["TrackerInfo"];

/** The URL's scheme (`udp`, `https`), or `null` when it has none. */
export function trackerScheme(url: string): string | null {
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url.trim());
  return m?.[1]?.toLowerCase() ?? null;
}

/** One line on how a tracker stands, and how it reads. */
export function trackerLine(t: Tracker): { text: string; tone: "ok" | "danger" | "muted" } {
  switch (t.status) {
    case "working": {
      const parts = ["working"];
      if (t.seeders !== null) parts.push(`${formatCount(t.seeders)} seeds`);
      if (t.leechers !== null) parts.push(`${formatCount(t.leechers)} leechers`);
      if (t.downloaded !== null) parts.push(`${formatCount(t.downloaded)} completed`);
      return { text: parts.join(" · "), tone: "ok" };
    }
    case "updating":
      return { text: "announcing…", tone: "muted" };
    case "not_working": {
      const why = t.message ?? "not working";
      return {
        text: t.fails > 1 ? `${why} · failed ${formatCount(t.fails)} times` : why,
        tone: "danger",
      };
    }
    case "not_contacted":
      return { text: "not contacted yet", tone: "muted" };
  }
}

/** URLs typed one per line (or separated by spaces), each once. */
export function typedUrls(text: string): string[] {
  return [...new Set(text.split(/\s+/).filter((u) => u !== ""))];
}

/** The tier after the last, where URLs added together share one. */
export function nextTier(trackers: readonly Pick<Tracker, "tier">[]): number {
  return trackers.reduce((n, t) => Math.max(n, t.tier + 1), 0);
}

/** Why a typed tracker URL cannot be added; `null` when it can. */
export function trackerUrlProblem(url: string): string | null {
  const scheme = trackerScheme(url);
  if (scheme !== "http" && scheme !== "https" && scheme !== "udp") {
    return "An http, https or udp URL.";
  }
  try {
    const host = new URL(url.replace(/^udp:/i, "http:")).hostname;
    return host === "" ? "A URL with a host." : null;
  } catch {
    return "Not a URL.";
  }
}

/** Of the lists new public torrents get, the trackers this torrent lacks, each once. */
export function missingTrackers(
  have: readonly Pick<Tracker, "url">[],
  lists: readonly (readonly string[])[],
): string[] {
  const present = new Set(have.map((t) => t.url));
  const out: string[] = [];
  for (const url of lists.flat()) {
    if (!present.has(url) && !out.includes(url)) out.push(url);
  }
  return out;
}
