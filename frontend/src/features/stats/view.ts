// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// What the Overview shows, from the daemon's statistics (AGENTS.md rule 2:
// sums and shares of its counters, never estimates). A rate is bytes over
// the seconds recorded; time the daemon did not record is a gap, not zero.

import type { Schemas } from "~/api/client";

import { idleUnkept, valueClass } from "./idle-view";

type TransferPoint = Schemas["TransferPoint"];
type PeerBreakdown = Schemas["PeerBreakdown"];
type PeerDimension = Schemas["PeerDimension"];
type IdleSeed = Schemas["IdleSeed"];
type TimelineKind = Schemas["TimelineKind"];

export interface Totals {
  downloaded: number;
  uploaded: number;
}

export function totals(points: readonly TransferPoint[]): Totals {
  let downloaded = 0;
  let uploaded = 0;
  for (const p of points) {
    downloaded += p.downloaded;
    uploaded += p.uploaded;
  }
  return { downloaded, uploaded };
}

/** The change from `before` to `now` as a fraction; `null` when there was nothing before. */
export function change(now: number, before: number): number | null {
  return before > 0 ? (now - before) / before : null;
}

/** The most peers at one observation, and the bucket it fell in. */
export function peakPeers(points: readonly TransferPoint[]): { peers: number; t: number } | null {
  let best: { peers: number; t: number } | null = null;
  for (const p of points) {
    if (p.peers_max > 0 && (best === null || p.peers_max > best.peers)) {
      best = { peers: p.peers_max, t: p.t };
    }
  }
  return best;
}

export interface RatePoint {
  /** Bucket start, unix seconds. */
  t: number;
  /** Bytes per second while recorded; `null`: nothing recorded. */
  down: number | null;
  up: number | null;
}

/**
 * The daemon's buckets (`step` seconds) grouped into chart buckets of
 * `bucket` seconds from `from` to `to`, as average rates over the seconds
 * recorded. The bucket running now counts only its elapsed seconds.
 */
export function rateSeries(
  points: readonly TransferPoint[],
  step: number,
  bucket: number,
  from: number,
  to: number,
  now: number,
): RatePoint[] {
  const acc = new Map<number, { down: number; up: number; secs: number }>();
  for (const p of points) {
    const secs = Math.min(step, now - p.t);
    if (secs <= 0) continue;
    const b = Math.floor(p.t / bucket) * bucket;
    const a = acc.get(b) ?? { down: 0, up: 0, secs: 0 };
    a.down += p.downloaded;
    a.up += p.uploaded;
    a.secs += secs;
    acc.set(b, a);
  }
  const out: RatePoint[] = [];
  for (let t = Math.floor(from / bucket) * bucket; t <= to; t += bucket) {
    const a = acc.get(t);
    out.push(a ? { t, down: a.down / a.secs, up: a.up / a.secs } : { t, down: null, up: null });
  }
  return out;
}

export const DIMENSIONS = [
  { value: "client", label: "Client" },
  { value: "source", label: "How found" },
  { value: "transport", label: "Transport" },
  { value: "encryption", label: "Encryption" },
  { value: "ip_version", label: "IP version" },
  { value: "direction", label: "Who connected" },
] as const satisfies readonly { value: PeerDimension; label: string }[];

const KEY_LABELS: Partial<Record<PeerDimension, Record<string, string>>> = {
  source: {
    tracker: "Tracker",
    dht: "DHT",
    pex: "Peer exchange",
    lsd: "Local discovery",
    incoming: "Incoming",
    manual: "Added by hand",
    resume: "Resume data",
  },
  transport: { tcp: "TCP", utp: "µTP" },
  encryption: { rc4: "Encrypted (RC4)", plaintext: "Plaintext" },
  ip_version: { ipv4: "IPv4", ipv6: "IPv6" },
  direction: { incoming: "They connected", outgoing: "We connected" },
};

export function peerKeyLabel(dim: PeerDimension, key: string): string {
  return KEY_LABELS[dim]?.[key] ?? key;
}

export interface Share {
  label: string;
  bytes: number;
  /** Of every byte in the range, peers' and the unattributed ones. */
  share: number;
}

/**
 * The biggest values' shares of the traffic, then the rest as one line:
 * smaller values, peers that gave no value (a client name), and bytes not
 * tied to a peer (web seeds, the seconds since the last sample).
 */
export function shares(b: PeerBreakdown, metric: "uploaded" | "downloaded", show = 4): Share[] {
  const total = b.rows.reduce((n, r) => n + r[metric], 0) + b.unattributed[metric];
  if (total === 0) return [];
  const top = b.rows
    .filter((r) => r.key !== null && r[metric] > 0)
    .sort((x, y) => y[metric] - x[metric])
    .slice(0, show);
  const out: Share[] = top.map((r) => ({
    label: peerKeyLabel(b.dim, r.key ?? ""),
    bytes: r[metric],
    share: r[metric] / total,
  }));
  const rest = total - top.reduce((n, r) => n + r[metric], 0);
  if (rest > 0) out.push({ label: "Other or unknown", bytes: rest, share: rest / total });
  return out;
}

/** How an idle seed's upload compares with its size: red under 0.1×, amber under 1×. */
export function valueTone(value: number): "danger" | "warn" | null {
  const c = valueClass(value);
  return c === "idle" ? "danger" : c === "low" ? "warn" : null;
}

/**
 * The idle seeds that shared less than a tenth of their size, less those
 * tagged to keep: what Reclaim deletes.
 */
export function reclaimable(
  seeds: readonly IdleSeed[],
  tagsOf: (hash: string) => readonly string[],
): { hashes: string[]; bytes: number } {
  const picked = idleUnkept(seeds, tagsOf);
  return { hashes: picked.map((s) => s.hash), bytes: picked.reduce((n, s) => n + s.size, 0) };
}

export const KIND_DOTS: Record<TimelineKind, string> = {
  added: "bg-muted-foreground",
  metadata: "bg-brand",
  finished: "bg-ok",
  moved: "bg-warn",
  error: "bg-danger",
  removed: "bg-subtle",
  state: "bg-muted-foreground",
};

/** A group key as the chart names it. */
export function groupLabel(key: string | null): string {
  return key ?? "none";
}
