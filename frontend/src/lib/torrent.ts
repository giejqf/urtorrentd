// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Torrent semantics as the daemon defines them (AGENTS.md 4.4): how a state
// shows, which list group it falls in, and the daemon's list filters.

import type { Schemas } from "~/api/client";

type TorrentSummary = Schemas["TorrentSummary"];
type TorrentState = Schemas["TorrentState"];
type TorrentFilter = Schemas["TorrentFilter"];
type TorrentErrorKind = Schemas["TorrentErrorKind"];

/** A state colour; `toneBg` / `toneText` hold its classes. */
export type Tone = "brand" | "ok" | "idle" | "warn" | "muted" | "subtle" | "danger";

export const toneBg: Record<Tone, string> = {
  brand: "bg-brand",
  ok: "bg-ok",
  idle: "bg-ok/45",
  warn: "bg-warn",
  muted: "bg-muted-foreground",
  subtle: "bg-subtle",
  danger: "bg-danger",
};

export const toneText: Record<Tone, string> = {
  brand: "text-brand",
  ok: "text-ok",
  idle: "text-muted-foreground",
  warn: "text-warn",
  muted: "text-muted-foreground",
  subtle: "text-subtle",
  danger: "text-danger",
};

/** The list's groups, in the design's order. */
export type GroupKey =
  | "downloading"
  | "metadata"
  | "checking"
  | "moving"
  | "queued"
  | "seeding"
  | "idle"
  | "stalled"
  | "stopped"
  | "held"
  | "error"
  | "unknown";

export interface Group {
  key: GroupKey;
  label: string;
  tone: Tone;
}

export const GROUPS: readonly Group[] = [
  { key: "downloading", label: "Downloading", tone: "brand" },
  { key: "metadata", label: "Fetching metadata", tone: "warn" },
  { key: "checking", label: "Checking", tone: "warn" },
  { key: "moving", label: "Moving", tone: "warn" },
  { key: "queued", label: "Queued", tone: "muted" },
  { key: "seeding", label: "Seeding", tone: "ok" },
  { key: "idle", label: "Idle", tone: "idle" },
  { key: "stalled", label: "Stalled", tone: "muted" },
  { key: "stopped", label: "Stopped", tone: "subtle" },
  { key: "held", label: "Held", tone: "muted" },
  { key: "error", label: "Error", tone: "danger" },
  { key: "unknown", label: "Unknown", tone: "subtle" },
];

/** How one torrent's state shows: its label, colour and group. */
export interface StateLook {
  group: GroupKey;
  label: string;
  tone: Tone;
}

const STATES: Record<TorrentState, StateLook> = {
  downloading: { group: "downloading", label: "Downloading", tone: "brand" },
  seeding: { group: "seeding", label: "Seeding", tone: "ok" },
  metadata: { group: "metadata", label: "Fetching metadata", tone: "warn" },
  checking_queued: { group: "checking", label: "Queued for check", tone: "warn" },
  checking: { group: "checking", label: "Checking", tone: "warn" },
  moving: { group: "moving", label: "Moving", tone: "warn" },
  queued: { group: "queued", label: "Queued", tone: "muted" },
  held: { group: "held", label: "Held", tone: "muted" },
  stopped: { group: "stopped", label: "Stopped", tone: "subtle" },
  error: { group: "error", label: "Error", tone: "danger" },
  unknown: { group: "unknown", label: "Unknown", tone: "subtle" },
};

const STALLED: StateLook = { group: "stalled", label: "Stalled", tone: "muted" };
const IDLE: StateLook = { group: "idle", label: "Idle", tone: "idle" };

/**
 * A torrent's look. The daemon's `stalled` means "running but moving no
 * payload": for a download that is a problem (Stalled: no data arrives),
 * for a seed it is normal (Idle: nobody is downloading from it).
 */
export function stateLook(t: Pick<TorrentSummary, "state" | "stalled">): StateLook {
  if (t.stalled && t.state === "downloading") return STALLED;
  if (t.stalled && t.state === "seeding") return IDLE;
  return STATES[t.state];
}

const ERROR_KINDS: Record<TorrentErrorKind, string> = {
  content_missing: "Files missing",
  io: "Disk error",
  metadata: "Bad metadata",
  other: "Error",
};

/** What stopped a torrent in the `error` state. */
export function errorKindLabel(kind: TorrentErrorKind | null): string {
  return kind === null ? "Error" : ERROR_KINDS[kind];
}

type FilterFields = Pick<
  TorrentSummary,
  "state" | "stalled" | "complete" | "download_rate" | "upload_rate"
>;

/**
 * Whether a torrent passes one of the daemon's list filters. Mirrors
 * `filter_matches` in crates/urtorrentd/src/daemon/view.rs exactly: note
 * that Downloading means "not complete" whatever the state, and that
 * Stopped includes Held.
 */
export function filterMatches(f: TorrentFilter, t: FilterFields): boolean {
  const running = !(t.state === "stopped" || t.state === "error" || t.state === "held");
  const active = t.download_rate > 0 || t.upload_rate > 0;
  switch (f) {
    case "all":
      return true;
    case "downloading":
      return !t.complete;
    case "seeding":
      return t.complete && running;
    case "completed":
      return t.complete;
    case "stopped":
      return t.state === "stopped" || t.state === "held";
    case "running":
      return running;
    case "active":
      return active;
    case "inactive":
      return !active;
    case "stalled":
      return t.stalled;
    case "stalled_seeding":
      return t.stalled && t.state === "seeding";
    case "stalled_downloading":
      return t.stalled && t.state === "downloading";
    case "checking":
      return t.state === "checking" || t.state === "checking_queued";
    case "moving":
      return t.state === "moving";
    case "errored":
      return t.state === "error";
  }
}

/** Every filter the daemon knows, in `TorrentFilter`'s order. */
export const FILTERS: readonly TorrentFilter[] = [
  "all",
  "downloading",
  "seeding",
  "completed",
  "stopped",
  "running",
  "active",
  "inactive",
  "stalled",
  "stalled_seeding",
  "stalled_downloading",
  "checking",
  "moving",
  "errored",
];

/**
 * The host of a tracker (or any) URL, lower-cased: lists show hosts, never
 * full URLs, which often carry passkeys (AGENTS.md rule 6). `null` when the
 * text is not a URL with a host.
 */
export function trackerHost(url: string | null): string | null {
  if (url === null) return null;
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "" ? null : host.replace(/^\[(.*)\]$/, "$1");
  } catch {
    return null;
  }
}

/** A row shows its first tag and how many more there are. */
export function tagSummary(tags: readonly string[]): { first: string | null; more: number } {
  return { first: tags[0] ?? null, more: Math.max(tags.length - 1, 0) };
}

const CATEGORY_TONES = ["bg-cat-1", "bg-cat-2", "bg-cat-3", "bg-cat-4", "bg-cat-5", "bg-cat-6"];

/** A category's dot colour: stable for its name. No category is grey. */
export function categoryTone(name: string | null): string {
  if (name === null || name === "") return "bg-border-strong";
  let h = 0;
  for (let i = 0; i < name.length; i += 1) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return CATEGORY_TONES[h % CATEGORY_TONES.length] ?? "bg-cat-1";
}
