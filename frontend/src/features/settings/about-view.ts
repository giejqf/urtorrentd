// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// What the About page says: how long the daemon has run, and the
// diagnostics a bug report needs. Diagnostics carry versions, the machine,
// the engine and network settings and counts, never an address, a path, a
// URL or a name (reports get pasted in public). Pure and tested.

import type { Schemas } from "~/api/client";
import { formatBytes, formatDuration } from "~/lib/format";

import type { Pending } from "./engine-form";

/** `12 d 4 h`: an uptime by its two largest units, spaced as the design has it. */
export function uptime(seconds: number): string {
  return formatDuration(seconds).replace(/(\d+)([a-z]+)/g, "$1 $2");
}

export interface DiagnosticsInput {
  app: Schemas["AppInfo"];
  system: Schemas["SystemInfo"] | null;
  settings: Schemas["Settings"];
  stats: Schemas["StatsInfo"] | null;
  transfer: Schemas["TransferInfo"] | null;
  /** Torrents by state. */
  states: Partial<Record<Schemas["TorrentState"], number>>;
  pending: readonly Pending[];
  ui: string;
  browser: string;
  now: number;
}

const iso = (unix: number) => new Date(unix * 1000).toISOString().slice(0, 16) + "Z";
const onOff = (b: boolean) => (b ? "on" : "off");

/** A plain-text report, one fact per line. */
export function diagnostics(d: DiagnosticsInput): string {
  const { app, system: sys, settings: s, stats, transfer } = d;
  const r = app.running;
  const lines = [
    `urtorrentd ${app.version} · API ${app.api_version} · ${app.library}`,
    `Web UI ${d.ui}`,
    `Up ${formatDuration(Math.max(d.now - app.started_at, 0))} (since ${iso(app.started_at)})`,
  ];
  if (sys) {
    lines.push(
      `Machine: ${sys.cpus} CPUs${sys.cpu_model ? ` (${sys.cpu_model})` : ""} · kernel ${sys.kernel}` +
        (sys.memory !== null ? ` · ${formatBytes(sys.memory)} memory` : ""),
      `Open files: ${sys.open_files ?? "?"} of ${sys.open_files_limit ?? "no limit"}` +
        ` (hard ${sys.open_files_hard_limit ?? "no limit"})`,
    );
    if (sys.save_path_fs) {
      const fs = sys.save_path_fs;
      lines.push(
        `Save path: ${fs.fs_type ?? "unknown file system"} · ${formatBytes(fs.total)} · ${formatBytes(fs.free)} free`,
      );
    }
  }
  lines.push(
    `Engine: hash_threads ${r.hash_threads} · max_checking ${r.max_checking}` +
      ` · max_open_files ${r.max_open_files} · max_concurrent_announces ${r.max_concurrent_announces}` +
      ` · disk_thread ${onOff(r.disk_thread)} · piece_extent_affinity ${onOff(r.piece_extent_affinity)}` +
      ` · zero_copy_send ${onOff(r.zero_copy_send)}`,
    `Waiting for a restart: ${
      d.pending.length === 0
        ? "nothing"
        : d.pending.map((p) => `${p.setting} ${p.running} → ${p.saved}`).join(" · ")
    }${app.restart_waiting ? " (restart waiting for idle torrents)" : ""}`,
    `Network: identity ${s.identity} · encryption ${s.encryption} · transports ${s.transports}` +
      ` · DHT ${onOff(s.dht)} · PEX ${onOff(s.pex)} · LSD ${onOff(s.lsd)}` +
      ` · interface ${s.listen_interface === null ? "any" : "pinned"}` +
      ` · IPv4 ${onOff(s.listen_v4 !== null)} · IPv6 ${onOff(s.listen_v6 !== null)}`,
  );
  if (transfer) {
    lines.push(
      `Connection: ${transfer.connection_status} · ${transfer.peers} peers · ${transfer.dht_nodes} DHT nodes`,
    );
  }
  const states = Object.entries(d.states)
    .filter(([, n]) => (n ?? 0) > 0)
    .map(([k, n]) => `${k} ${n}`);
  const total = Object.values(d.states).reduce((a, n) => a + (n ?? 0), 0);
  lines.push(`Torrents: ${total}${states.length > 0 ? ` (${states.join(", ")})` : ""}`);
  lines.push(
    `Queue: ${s.queueing_enabled ? `on, ${s.max_active_downloads ?? "∞"} down / ${s.max_active_uploads ?? "∞"} up / ${s.max_active_torrents ?? "∞"} total` : "off"}`,
    `Statistics: ${
      stats
        ? `${onOff(stats.enabled)} · ${formatBytes(stats.size)} · ${stats.torrents} torrents (${stats.removed} removed)`
        : "unavailable"
    }`,
    `GeoIP: ${
      [app.geoip.country, app.geoip.asn]
        .filter((g) => g !== null)
        .map((g) => g.database_type ?? `not loaded`)
        .join(" · ") || "none"
    }`,
    `Browser: ${d.browser}`,
  );
  return lines.join("\n");
}
