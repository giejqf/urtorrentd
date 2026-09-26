// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Connection and BitTorrent pages' forms: the settings as the user
// edits them, what changed, and the `PATCH /settings` body. A listen
// address that can be off is a switch and a text, kept while off. Pure and
// tested.

import type { Schemas } from "~/api/client";

import type { FormDiff } from "./form";

type Settings = Schemas["Settings"];
type SettingsPatch = Schemas["SettingsPatch"];

/** An IPv4 address as the daemon reads one (dotted quad, no leading zeros). */
export function isIpv4(text: string): boolean {
  const parts = text.split(".");
  return parts.length === 4 && parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p) && Number(p) <= 255);
}

/** An IPv6 address (no zone, no brackets). */
export function isIpv6(text: string): boolean {
  if (!text.includes(":") || /[[\]%/\s]/.test(text)) return false;
  try {
    return new URL(`http://[${text}]/`).hostname.length > 2;
  } catch {
    return false;
  }
}

export function isIp(text: string): boolean {
  return isIpv4(text) || isIpv6(text);
}

// ---------------------------------------------------------------------------
// Connection

export interface ConnectionDraft {
  listen_port: string;
  random_port: boolean;
  listen_interface: string | null;
  listen_v4_on: boolean;
  listen_v4: string;
  listen_v6_on: boolean;
  listen_v6: string;
  transports: Schemas["Transports"];
}

export type ConnectionField = keyof ConnectionDraft;

export function connectionDraft(s: Settings, prev?: ConnectionDraft): ConnectionDraft {
  return {
    listen_port: String(s.listen_port),
    random_port: s.random_port,
    listen_interface: s.listen_interface,
    listen_v4_on: s.listen_v4 !== null,
    listen_v4: s.listen_v4 ?? prev?.listen_v4 ?? "0.0.0.0",
    listen_v6_on: s.listen_v6 !== null,
    listen_v6: s.listen_v6 ?? prev?.listen_v6 ?? "::",
    transports: s.transports,
  };
}

export function connectionDiff(saved: Settings, d: ConnectionDraft): FormDiff<ConnectionField> {
  const patch: Record<string, unknown> = {};
  const changed = new Set<ConnectionField>();
  const names: string[] = [];
  const errors: Partial<Record<ConnectionField, string>> = {};
  const note = (field: ConnectionField, value: unknown) => {
    patch[field] = value;
    changed.add(field);
    names.push(field);
  };
  const fail = (field: ConnectionField, problem: string) => {
    errors[field] = problem;
    changed.add(field);
  };

  const port = d.listen_port.trim();
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65_535)
    fail("listen_port", "A port from 0 to 65535.");
  else if (Number(port) !== saved.listen_port) note("listen_port", Number(port));
  if (d.random_port !== saved.random_port) note("random_port", d.random_port);
  if (d.listen_interface !== saved.listen_interface) note("listen_interface", d.listen_interface);

  const family = (
    field: "listen_v4" | "listen_v6",
    on: boolean,
    text: string,
    valid: (t: string) => boolean,
    problem: string,
  ) => {
    const value = on ? text.trim() : null;
    if (value !== null && !valid(value)) fail(field, problem);
    else if (value !== saved[field]) note(field, value);
  };
  family("listen_v4", d.listen_v4_on, d.listen_v4, isIpv4, "An IPv4 address such as 0.0.0.0.");
  family("listen_v6", d.listen_v6_on, d.listen_v6, isIpv6, "An IPv6 address such as ::.");
  if (!d.listen_v4_on && !d.listen_v6_on) {
    fail("listen_v4", "IPv4 and IPv6 cannot both be off.");
  }
  if (d.transports !== saved.transports) note("transports", d.transports);
  return { patch: patch as SettingsPatch, changed, names, errors };
}

/** A port for "Random": unprivileged, clear of the ephemeral range's start. */
export function randomPort(random: () => number = Math.random): number {
  return 10_000 + Math.floor(random() * 50_000);
}

// ---------------------------------------------------------------------------
// BitTorrent

export interface BitTorrentDraft {
  dht: boolean;
  pex: boolean;
  lsd: boolean;
  /** Our own bootstrap routers instead of the identity's. */
  dht_bootstrap_custom: boolean;
  dht_bootstrap_nodes: string[];
  encryption: Schemas["Encryption"];
  identity: Schemas["Identity"];
}

export type BitTorrentField = keyof BitTorrentDraft;

export function bitTorrentDraft(s: Settings, prev?: BitTorrentDraft): BitTorrentDraft {
  return {
    dht: s.dht,
    pex: s.pex,
    lsd: s.lsd,
    dht_bootstrap_custom: s.dht_bootstrap_nodes !== null,
    dht_bootstrap_nodes: [...(s.dht_bootstrap_nodes ?? prev?.dht_bootstrap_nodes ?? [])],
    encryption: s.encryption,
    identity: s.identity,
  };
}

/** Why a bootstrap router is not `host:port`; `null` = it is. */
export function hostPortProblem(text: string): string | null {
  const m = /^(\[[0-9a-fA-F:.]+\]|[A-Za-z0-9.-]+):(\d{1,5})$/.exec(text);
  const port = m ? Number(m[2]) : 0;
  return m && port >= 1 && port <= 65_535 ? null : "host:port, such as router.example.org:6881.";
}

const sameList = (a: readonly string[] | null, b: readonly string[] | null) =>
  a === null || b === null ? a === b : a.length === b.length && a.every((x, i) => x === b[i]);

export function bitTorrentDiff(saved: Settings, d: BitTorrentDraft): FormDiff<BitTorrentField> {
  const patch: Record<string, unknown> = {};
  const changed = new Set<BitTorrentField>();
  const names: string[] = [];
  const note = (field: BitTorrentField, value: unknown) => {
    patch[field] = value;
    changed.add(field);
    names.push(field);
  };
  for (const f of ["dht", "pex", "lsd"] as const) if (d[f] !== saved[f]) note(f, d[f]);
  const nodes = d.dht_bootstrap_custom ? [...d.dht_bootstrap_nodes] : null;
  if (!sameList(nodes, saved.dht_bootstrap_nodes)) note("dht_bootstrap_nodes", nodes);
  if (d.encryption !== saved.encryption) note("encryption", d.encryption);
  if (d.identity !== saved.identity) note("identity", d.identity);
  return { patch: patch as SettingsPatch, changed, names, errors: {} };
}
