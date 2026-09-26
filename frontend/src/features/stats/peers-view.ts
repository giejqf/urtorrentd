// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Peers & geo report: peers now (`/transfer/peers`) or peer traffic over
// a range (`/stats/geo`), placed by country on an equirectangular world
// (world.ts). GeoIP places a peer in a country and a network, never finer
// (ADR 0005), so every peer of a country meets at that country's point.

import type { Schemas } from "~/api/client";

import { COUNTRY_POINTS, STEP, TOP } from "./world";

type Peer = Schemas["TorrentPeer"];
type GeoRow = Schemas["GeoRow"];

const BOTTOM = TOP - 71 * STEP;

/** A country's point on a map `w` × `h`; `null` for codes the map does not have. */
export function countryPoint(code: string | null, w: number, h: number): [number, number] | null {
  const p = code ? COUNTRY_POINTS[code] : undefined;
  if (!p) return null;
  return project(p[0], p[1], w, h);
}

export function project(lon: number, lat: number, w: number, h: number): [number, number] {
  return [((lon + 180) / 360) * w, ((TOP - lat) / (TOP - BOTTOM)) * h];
}

let names: Intl.DisplayNames | null = null;

/** A country's name in English (`DE` → `Germany`); the code when unknown. */
export function countryName(code: string | null): string {
  if (!code) return "Not located";
  try {
    names ??= new Intl.DisplayNames(["en"], { type: "region" });
    return names.of(code) ?? code;
  } catch {
    return code;
  }
}

export interface Flow {
  /** The country code, or the peer's address. */
  key: string;
  country: string;
  label: string;
  /** Bytes per second (now) or bytes (a range). */
  down: number;
  up: number;
  peers: number;
}

/** Peers by country, largest flow first; the unlocated ones apart. */
export function countryFlows(peers: readonly Peer[]): { flows: Flow[]; unlocated: number } {
  const by = new Map<string, Flow>();
  let unlocated = 0;
  for (const p of peers) {
    if (!p.country) {
      unlocated += 1;
      continue;
    }
    const f = by.get(p.country) ?? {
      key: p.country,
      country: p.country,
      label: p.country,
      down: 0,
      up: 0,
      peers: 0,
    };
    f.down += p.download_rate;
    f.up += p.upload_rate;
    f.peers += 1;
    by.set(p.country, f);
  }
  return { flows: [...by.values()].sort(byFlow), unlocated };
}

/** Each located peer as a flow, largest first. */
export function peerFlows(peers: readonly Peer[]): Flow[] {
  return peers
    .filter((p) => p.country)
    .map((p) => ({
      key: `${p.hash}-${p.address}`,
      country: p.country ?? "",
      label: p.address,
      down: p.download_rate,
      up: p.upload_rate,
      peers: 1,
    }))
    .sort(byFlow);
}

/** Traffic by country over a range, as flows (bytes). */
export function historyFlows(rows: readonly GeoRow[]): { flows: Flow[]; unlocated: number } {
  let unlocated = 0;
  const flows: Flow[] = [];
  for (const r of rows) {
    if (!r.country) {
      unlocated += r.downloaded + r.uploaded;
      continue;
    }
    flows.push({
      key: r.country,
      country: r.country,
      label: r.country,
      down: r.downloaded,
      up: r.uploaded,
      peers: r.peers_max,
    });
  }
  return { flows: flows.sort(byFlow), unlocated };
}

function byFlow(a: Flow, b: Flow): number {
  return b.down + b.up - (a.down + a.up) || b.peers - a.peers || a.key.localeCompare(b.key);
}

/**
 * A curve from `a` to `b` bending to one side by `bend` of their distance
 * (a quadratic Bézier): `M ax ay Q cx cy bx by`.
 */
export function arc(a: [number, number], b: [number, number], bend: number): string {
  const [ax, ay] = a;
  const [bx, by] = b;
  const dx = bx - ax;
  const dy = by - ay;
  const cx = (ax + bx) / 2 - dy * bend;
  const cy = (ay + by) / 2 + dx * bend;
  const f = (n: number) => n.toFixed(1);
  return `M${f(ax)} ${f(ay)}Q${f(cx)} ${f(cy)} ${f(bx)} ${f(by)}`;
}

/** A line width for a flow against the largest: 1.5 to 6px, by square root. */
export function flowWidth(v: number, most: number): number {
  if (!(most > 0) || v <= 0) return 0;
  return 1.5 + 4.5 * Math.sqrt(v / most);
}

export interface Totals {
  down: number;
  up: number;
  /** Peers sending to us / receiving from us. */
  sending: number;
  receiving: number;
  countries: number;
  torrents: number;
}

export function totals(peers: readonly Peer[]): Totals {
  const countries = new Set<string>();
  const torrents = new Set<string>();
  let down = 0;
  let up = 0;
  let sending = 0;
  let receiving = 0;
  for (const p of peers) {
    down += p.download_rate;
    up += p.upload_rate;
    if (p.download_rate > 0) sending += 1;
    if (p.upload_rate > 0) receiving += 1;
    if (p.country) countries.add(p.country);
    torrents.add(p.hash);
  }
  return { down, up, sending, receiving, countries: countries.size, torrents: torrents.size };
}

export interface Split {
  label: string;
  /** 0 to 1. */
  share: number;
}

export interface Connections {
  transport: Split[];
  encryption: Split[];
  direction: Split[];
  source: Split[];
}

const SOURCE_LABELS: Record<string, string> = {
  tracker: "tracker",
  dht: "DHT",
  pex: "PEX",
  lsd: "LSD",
  incoming: "incoming",
  manual: "by hand",
  resume: "resume data",
};

/**
 * Shares of a total: in the order given, zeros kept (a bar's colours
 * follow the order), or the ones above zero largest first.
 */
function split(pairs: readonly [string, number][], largestFirst = false): Split[] {
  const total = pairs.reduce((n, [, v]) => n + v, 0);
  if (total === 0) return [];
  const out = pairs.map(([label, v]) => ({ label, share: v / total }));
  return largestFirst ? out.filter((s) => s.share > 0).sort((a, b) => b.share - a.share) : out;
}

/** How the peers now connect, by count. */
export function liveConnections(peers: readonly Peer[]): Connections {
  const count = (f: (p: Peer) => boolean) => peers.filter(f).length;
  const sources = new Map<string, number>();
  for (const p of peers) sources.set(p.source, (sources.get(p.source) ?? 0) + 1);
  return {
    transport: split([
      ["TCP", count((p) => p.transport === "tcp")],
      ["µTP", count((p) => p.transport === "utp")],
    ]),
    encryption: split([
      ["encrypted", count((p) => p.encrypted)],
      ["plaintext", count((p) => !p.encrypted)],
    ]),
    direction: split([
      ["incoming", count((p) => p.incoming)],
      ["outgoing", count((p) => !p.incoming)],
    ]),
    source: split(
      [...sources].map(([k, v]) => [SOURCE_LABELS[k] ?? k, v]),
      true,
    ),
  };
}

const HISTORY_LABELS: Record<string, string> = {
  tcp: "TCP",
  utp: "µTP",
  rc4: "encrypted",
  plaintext: "plaintext",
  ipv4: "IPv4",
  ipv6: "IPv6",
  ...SOURCE_LABELS,
  outgoing: "outgoing",
};

/** The order two-part splits are drawn in (their colours follow it). */
const ORDER: Record<string, readonly string[]> = {
  transport: ["tcp", "utp"],
  encryption: ["rc4", "plaintext"],
  direction: ["incoming", "outgoing"],
};

/** How the traffic of a range split, from `/stats/peers` (peers' bytes both ways). */
export function historySplit(b: Schemas["PeerBreakdown"] | undefined): Split[] {
  if (!b) return [];
  const bytes = (key: string) =>
    b.rows.filter((r) => r.key === key).reduce((n, r) => n + r.downloaded + r.uploaded, 0);
  const order = ORDER[b.dim];
  if (order) return split(order.map((k) => [HISTORY_LABELS[k] ?? k, bytes(k)]));
  return split(
    b.rows
      .filter((r) => r.key !== null)
      .map((r) => [HISTORY_LABELS[r.key ?? ""] ?? r.key ?? "", r.downloaded + r.uploaded]),
    true,
  );
}

/** Addresses to ban: the IP of each `ip:port` (IPv6 in brackets). */
export function peerIp(address: string): string {
  const v6 = /^\[(.*)\]:\d+$/.exec(address);
  if (v6) return v6[1] ?? address;
  const i = address.lastIndexOf(":");
  return i < 0 ? address : address.slice(0, i);
}
