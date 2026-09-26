// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Banned addresses page's arithmetic: what a typed line bans (single
// addresses for `banned_ips`, blocks and ranges for `banned_ip_ranges`, a
// port dropped), what kind an entry is, how many IPv4 addresses the list
// covers, and the peer log counted by day. Pure and tested.

import type { Schemas } from "~/api/client";

import { isIp, isIpv4, isIpv6 } from "./network-form";

export type BanKind = "single" | "CIDR" | "range";

export function banKind(entry: string): BanKind {
  if (entry.includes("/")) return "CIDR";
  if (entry.includes("-")) return "range";
  return "single";
}

/** An address without the port a peer address carries (`1.2.3.4:6881`, `[fd00::1]:6881`). */
function withoutPort(token: string): string {
  const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(token);
  if (bracketed?.[1] !== undefined) return bracketed[1];
  const v4 = /^(\d+\.\d+\.\d+\.\d+):\d+$/.exec(token);
  return v4?.[1] ?? token;
}

function cidrProblem(token: string): boolean {
  const [ip, bits, extra] = token.split("/");
  if (ip === undefined || bits === undefined || extra !== undefined || !/^\d{1,3}$/.test(bits)) {
    return true;
  }
  if (isIpv4(ip)) return Number(bits) > 32;
  if (isIpv6(ip)) return Number(bits) > 128;
  return true;
}

/** IPv4 as a number, `null` for anything else. */
export function ipv4Number(ip: string): number | null {
  if (!isIpv4(ip)) return null;
  return ip.split(".").reduce((n, p) => n * 256 + Number(p), 0);
}

function rangeProblem(token: string): boolean {
  const [a, b, extra] = token.split("-");
  if (a === undefined || b === undefined || extra !== undefined) return true;
  if (isIpv4(a) && isIpv4(b)) return (ipv4Number(a) ?? 0) > (ipv4Number(b) ?? 0);
  return !(isIpv6(a) && isIpv6(b));
}

export interface ParsedBans {
  ips: string[];
  ranges: string[];
  /** What could not be read, as typed. */
  bad: string[];
}

/** One or more entries, separated by commas or spaces. */
export function parseBans(text: string): ParsedBans {
  const out: ParsedBans = { ips: [], ranges: [], bad: [] };
  for (const raw of text.split(/[,\s]+/)) {
    const token = raw.trim();
    if (token === "") continue;
    if (token.includes("/")) {
      if (cidrProblem(token)) out.bad.push(token);
      else out.ranges.push(token);
    } else if (token.includes("-")) {
      if (rangeProblem(token)) out.bad.push(token);
      else out.ranges.push(token);
    } else {
      const ip = withoutPort(token);
      if (isIp(ip)) out.ips.push(ip);
      else out.bad.push(token);
    }
  }
  return out;
}

/** The IPv4 addresses the list covers, overlaps counted once; and its IPv6 entries. */
export function coverage(
  ips: readonly string[],
  ranges: readonly string[],
): {
  v4: number;
  v6Entries: number;
} {
  const spans: [number, number][] = [];
  let v6Entries = 0;
  for (const ip of ips) {
    const n = ipv4Number(ip);
    if (n === null) v6Entries += 1;
    else spans.push([n, n]);
  }
  for (const r of ranges) {
    if (r.includes("/")) {
      const [ip, bits] = r.split("/");
      const n = ipv4Number(ip ?? "");
      if (n === null) {
        v6Entries += 1;
        continue;
      }
      const size = 2 ** (32 - Number(bits));
      const first = Math.floor(n / size) * size;
      spans.push([first, first + size - 1]);
    } else {
      const [a, b] = r.split("-");
      const x = ipv4Number(a ?? "");
      const y = ipv4Number(b ?? "");
      if (x === null || y === null) v6Entries += 1;
      else spans.push([x, y]);
    }
  }
  spans.sort((p, q) => p[0] - q[0]);
  let v4 = 0;
  let end = -1;
  for (const [a, b] of spans) {
    if (b <= end) continue;
    v4 += b - Math.max(a, end + 1) + 1;
    end = b;
  }
  return { v4, v6Entries };
}

type PeerLogEntry = Schemas["PeerLogEntry"];

/** Bans in the peer log per day (local days), the last `days` of them, oldest first. */
export function bansPerDay(
  entries: readonly PeerLogEntry[],
  now: Date,
  days = 30,
): { day: Date; engine: number; settings: number }[] {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const out = Array.from({ length: days }, (_, i) => ({
    day: new Date(today.getFullYear(), today.getMonth(), today.getDate() - (days - 1 - i)),
    engine: 0,
    settings: 0,
  }));
  const first = out[0]?.day.getTime() ?? 0;
  for (const e of entries) {
    if (!e.banned) continue;
    const t = new Date(e.time * 1000);
    if (t.getTime() < first) continue;
    const d = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    const i = out.findIndex((x) => x.day.getTime() === d.getTime());
    const slot = out[i];
    if (slot) slot[e.source] += 1;
  }
  return out;
}
