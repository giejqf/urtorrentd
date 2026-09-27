// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// A MaxMind DB writer for tests (format: maxmind.github.io/MaxMind-DB), the
// daemon's own `tests/common/mmdb.rs` in TypeScript: country or ASN
// records for IPv4 networks, so tests locate loopback addresses without a
// real database. 24-bit records; more specific networks must come after the
// ones they split.

import { renameSync, writeFileSync } from "node:fs";

type V = string | { u16: number } | { u32: number } | { u64: bigint } | V[] | { [key: string]: V };

function head(out: number[], type: number, size: number): void {
  let first: number;
  const extra: number[] = [];
  if (size < 29) first = size;
  else if (size < 285) {
    first = 29;
    extra.push(size - 29);
  } else {
    first = 30;
    extra.push(((size - 285) >> 8) & 0xff, (size - 285) & 0xff);
  }
  if (type <= 7) out.push((type << 5) | first);
  else out.push(first, type - 7);
  out.push(...extra);
}

function uint(n: bigint): number[] {
  const bytes: number[] = [];
  let x = n;
  while (x > 0n) {
    bytes.unshift(Number(x & 0xffn));
    x >>= 8n;
  }
  return bytes;
}

function encode(v: V, out: number[]): void {
  if (typeof v === "string") {
    const b = [...Buffer.from(v, "utf8")];
    head(out, 2, b.length);
    out.push(...b);
  } else if (Array.isArray(v)) {
    head(out, 11, v.length);
    for (const x of v) encode(x, out);
  } else if ("u16" in v && typeof v.u16 === "number") {
    const b = uint(BigInt(v.u16));
    head(out, 5, b.length);
    out.push(...b);
  } else if ("u32" in v && typeof v.u32 === "number") {
    const b = uint(BigInt(v.u32));
    head(out, 6, b.length);
    out.push(...b);
  } else if ("u64" in v && typeof v.u64 === "bigint") {
    const b = uint(v.u64);
    head(out, 9, b.length);
    out.push(...b);
  } else {
    const entries = Object.entries(v as Record<string, V>);
    head(out, 7, entries.length);
    for (const [k, x] of entries) {
      encode(k, out);
      encode(x, out);
    }
  }
}

/** GeoLite2-Country's layout. */
export function country(code: string, name: string): V {
  return {
    country: { iso_code: code, names: { en: name } },
    registered_country: { iso_code: code },
  };
}

/** GeoLite2-ASN's (and DB-IP ASN Lite's) layout. */
export function asn(number: number, org: string): V {
  return { autonomous_system_number: { u32: number }, autonomous_system_organization: org };
}

type Child = { kind: "empty" } | { kind: "node"; at: number } | { kind: "data"; at: number };

/** Write an IPv4 country database: each network (`127.0.10.0/24`) with its record. */
export function writeCountryDb(path: string, entries: [string, V][]): void {
  writeFileSync(`${path}.tmp`, mmdbBytes("GeoLite2-Country", entries));
  // Written then renamed, as a download would be.
  renameSync(`${path}.tmp`, path);
}

/** An IPv4 database of `type` (`DBIP-ASN-Lite`, ...): each network with its record. */
export function mmdbBytes(type: string, entries: [string, V][]): Buffer {
  const nodes: [Child, Child][] = [[{ kind: "empty" }, { kind: "empty" }]];
  const data: number[] = [];
  const offsets: number[] = [];
  entries.forEach(([cidr, value], i) => {
    offsets.push(data.length);
    encode(value, data);
    const [ip = "", bits = "32"] = cidr.split("/");
    const len = Number(bits);
    const addr = ip.split(".").reduce((n, o) => n * 256 + Number(o), 0);
    let n = 0;
    for (let depth = 0; depth < len; depth += 1) {
      const bit = Math.floor(addr / 2 ** (31 - depth)) % 2;
      const node = nodes[n];
      if (!node) throw new Error("mmdb: broken tree");
      if (depth === len - 1) {
        node[bit] = { kind: "data", at: i };
        break;
      }
      const child = node[bit];
      if (child?.kind === "node") {
        n = child.at;
      } else {
        const other = child ?? { kind: "empty" };
        nodes.push([other, other]);
        n = nodes.length - 1;
        node[bit] = { kind: "node", at: n };
      }
    }
  });
  const count = nodes.length;
  const record = (c: Child): number =>
    c.kind === "empty" ? count : c.kind === "node" ? c.at : count + 16 + (offsets[c.at] ?? 0);
  const out: number[] = [];
  for (const [l, r] of nodes) {
    for (const x of [record(l), record(r)]) out.push((x >> 16) & 0xff, (x >> 8) & 0xff, x & 0xff);
  }
  out.push(...new Array<number>(16).fill(0));
  out.push(...data);
  out.push(0xab, 0xcd, 0xef, ...Buffer.from("MaxMind.com"));
  encode(
    {
      binary_format_major_version: { u16: 2 },
      binary_format_minor_version: { u16: 0 },
      build_epoch: { u64: 1_700_000_000n },
      database_type: type,
      description: { en: "urtorrentd test data" },
      ip_version: { u16: 4 },
      languages: ["en"],
      node_count: { u32: count },
      record_size: { u16: 24 },
    },
    out,
  );
  return Buffer.from(out);
}
