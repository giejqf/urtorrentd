// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The add dialog's logic, without the DOM: what the user typed as sources,
// the form turned into the request's `options`, and per-file choices.

import type { Schemas } from "~/api/client";

type AddOptions = Schemas["AddOptions"];

export type SourceKind = "magnet" | "hash" | "url";

export interface LinkSource {
  /** The line as typed (what is sent). */
  text: string;
  kind: SourceKind;
  /** What to call it before its metadata is known. */
  label: string;
}

/** The magnet's display name (`dn`), if it has one. */
function magnetName(text: string): string | null {
  const q = text.slice(text.indexOf("?") + 1);
  for (const part of q.split("&")) {
    const [k, v] = part.split("=");
    if (k === "dn" && v) {
      try {
        return decodeURIComponent(v.replace(/\+/g, " "));
      } catch {
        return v;
      }
    }
  }
  return null;
}

/** The last path segment of a URL, or its host. */
function urlName(text: string): string {
  try {
    const u = new URL(text);
    const last = u.pathname
      .split("/")
      .filter((s) => s !== "")
      .at(-1);
    return last ? decodeURIComponent(last) : u.hostname;
  } catch {
    return text;
  }
}

/** A URL's host (what may be shown of it: URLs can carry passkeys). */
export function urlHost(text: string): string {
  try {
    return new URL(text).hostname;
  } catch {
    return "";
  }
}

/**
 * The sources in the text, one per line, each once: magnet links, bare
 * info-hashes (40 hex or 32 base32 characters) and http(s) URLs. Lines
 * that are none of these are returned apart.
 */
export function parseSources(text: string): { sources: LinkSource[]; invalid: string[] } {
  const sources: LinkSource[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || seen.has(line)) continue;
    seen.add(line);
    if (/^magnet:\?/i.test(line)) {
      sources.push({ text: line, kind: "magnet", label: magnetName(line) ?? "Magnet link" });
    } else if (/^[0-9a-f]{40}$/i.test(line) || /^[a-z2-7]{32}$/i.test(line)) {
      sources.push({ text: line, kind: "hash", label: line.toLowerCase() });
    } else if (/^https?:\/\/\S+$/i.test(line)) {
      sources.push({ text: line, kind: "url", label: urlName(line) });
    } else {
      invalid.push(line);
    }
  }
  return { sources, invalid };
}

/** `9c2b7e41f0d3…f3a2c1`. */
export function shortHash(hash: string): string {
  return hash.length > 20 ? `${hash.slice(0, 12)}…${hash.slice(-6)}` : hash;
}

export type Layout = Schemas["ContentLayout"];
export type Stop = Schemas["StopCondition"];

export interface AddForm {
  savePath: string;
  category: string | null;
  tags: string[];
  layout: Layout;
  stop: Stop;
  start: boolean;
  autoManagement: boolean;
  sequential: boolean;
  firstLast: boolean;
  /** Share limits from the category (or the settings): the torrent's all `global`. */
  inheritLimits: boolean;
  /** kB/s; empty = unlimited. */
  downloadLimit: string;
  uploadLimit: string;
  /** Used when not inheriting; empty = no ratio limit. */
  ratio: string;
}

function kiloToBytes(text: string, what: string): number | null | string {
  const t = text.trim().replace(",", ".");
  if (t === "" || t === "∞") return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return `${what}: a number of kB/s, or empty for none.`;
  return Math.round(n * 1000);
}

/** The request's `options`, or what is wrong with the form. */
export function addOptions(f: AddForm): { options: AddOptions } | { error: string } {
  const down = kiloToBytes(f.downloadLimit, "Download limit");
  if (typeof down === "string") return { error: down };
  const up = kiloToBytes(f.uploadLimit, "Upload limit");
  if (typeof up === "string") return { error: up };
  const options: AddOptions = {
    save_path: f.autoManagement ? null : f.savePath.trim() || null,
    category: f.category,
    tags: f.tags,
    content_layout: f.layout,
    stop_condition: f.stop,
    stopped: !f.start,
    auto_management: f.autoManagement,
    sequential: f.sequential,
    first_last_piece_priority: f.firstLast,
    download_limit: down,
    upload_limit: up,
  };
  if (!f.inheritLimits) {
    const t = f.ratio.trim().replace(",", ".");
    let ratio: Schemas["RatioLimit"] = { mode: "unlimited" };
    if (t !== "" && t !== "∞") {
      const n = Number(t);
      if (!Number.isFinite(n) || n < 0)
        return { error: "Ratio limit: a number, or empty for none." };
      ratio = { mode: "limit", value: n };
    }
    options.share_limits = {
      ratio,
      seeding_time: { mode: "unlimited" },
      inactive_seeding_time: { mode: "unlimited" },
      action: null,
    };
  }
  return { options };
}

/** File priorities the dialog offers: skipped is the checkbox. */
export const PRIORITIES = [
  { value: 1, label: "Low" },
  { value: 4, label: "Normal" },
  { value: 6, label: "High" },
  { value: 7, label: "Maximum" },
] as const;

export const NORMAL = 4;

export function priorityLabel(p: number): string {
  if (p === 0) return "Skip";
  return PRIORITIES.find((x) => x.value === p)?.label ?? `Priority ${p}`;
}

/** Bytes of the files not skipped. */
export function selectedSize(
  files: readonly Schemas["MetadataFile"][],
  priorities: readonly number[] | undefined,
): number {
  return files.reduce((n, f, i) => n + ((priorities?.[i] ?? NORMAL) > 0 ? f.size : 0), 0);
}

/** The priorities to send: none when every file is left as it is. */
export function filePriorities(priorities: readonly number[] | undefined): number[] | undefined {
  if (!priorities || priorities.every((p) => p === NORMAL)) return undefined;
  return [...priorities];
}

/**
 * Where an automatically managed torrent of this category is saved: its
 * category's path, absolute or relative to the default save path, or the
 * default save path and the category's name (the daemon's rule, `Category`
 * in the schema).
 */
export function categoryPath(
  defaultPath: string,
  name: string | null,
  category: Schemas["Category"] | undefined,
): string {
  if (name === null) return defaultPath;
  const own = category?.save_path;
  const join = (a: string, b: string) => `${a.replace(/\/+$/, "")}/${b}`;
  if (own === null || own === undefined || own === "") return join(defaultPath, name);
  return own.startsWith("/") ? own : join(defaultPath, own);
}
