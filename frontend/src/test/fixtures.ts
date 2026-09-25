// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Test fixtures typed against the schema (`satisfies`), so they cannot
// drift from what the daemon sends (AGENTS.md 7.2).

import type { Schemas } from "~/api/client";

type TorrentSummary = Schemas["TorrentSummary"];

export function torrent(overrides: Partial<TorrentSummary> = {}): TorrentSummary {
  const base = {
    hash: "4f6a1ad0b6a3e1e8b2c9f7d2a5e4b3c1d0f9e8a7",
    name: "ubuntu-24.04.3-desktop-amd64.iso",
    state: "seeding",
    stalled: false,
    forced: false,
    complete: true,
    error: null,
    error_kind: null,
    progress: 1,
    size: 6_300_000_000,
    total_size: 6_300_000_000,
    completed: 6_300_000_000,
    left: 0,
    downloaded: 6_300_000_000,
    uploaded: 26_500_000_000,
    downloaded_session: 0,
    uploaded_session: 1_200_000_000,
    wasted: 0,
    ratio: 4.21,
    download_rate: 0,
    upload_rate: 2_400_000,
    eta: null,
    download_limit: null,
    upload_limit: 5_000_000,
    max_connections: 50,
    max_uploads: null,
    peers: 38,
    seeds: 0,
    swarm_seeds: 412,
    swarm_leechers: 38,
    availability: null,
    save_path: "/data/linux",
    download_path: null,
    content_path: "/data/linux/ubuntu-24.04.3-desktop-amd64.iso",
    root_path: null,
    category: "linux",
    tags: ["iso", "keep"],
    added_on: 1_757_668_440,
    completed_on: 1_757_669_000,
    last_activity: 1_758_700_000,
    seen_complete: 1_758_700_000,
    active_time: 1_000_000,
    seeding_time: 1_051_200,
    queue_position: 0,
    auto_management: false,
    sequential: false,
    first_last_piece_priority: false,
    private: false,
    has_metadata: true,
    piece_size: 2 * 1024 * 1024,
    pieces_have: 3072,
    pieces_total: 3072,
    tracker: "https://torrent.ubuntu.com/announce",
    trackers_count: 1,
    magnet_uri: "magnet:?xt=urn:btih:4f6a1ad0b6a3e1e8b2c9f7d2a5e4b3c1d0f9e8a7",
    comment: null,
    created_by: null,
    creation_date: null,
    share_limits: {
      ratio: { mode: "global" },
      seeding_time: { mode: "global" },
      inactive_seeding_time: { mode: "global" },
      action: null,
    },
    popularity: null,
    next_announce_in: 1450,
  } satisfies TorrentSummary;
  return { ...base, ...overrides };
}

export function transfer(
  overrides: Partial<Schemas["TransferInfo"]> = {},
): Schemas["TransferInfo"] {
  const base = {
    download_rate: 8_100_000,
    upload_rate: 3_200_000,
    downloaded_session: 0,
    uploaded_session: 0,
    downloaded_total: 0,
    uploaded_total: 0,
    ratio: null,
    download_limit: null,
    upload_limit: null,
    alt_speed_enabled: false,
    connection_status: "connected",
    listen_port: 6881,
    peers: 148,
    connections: 148,
    dht_nodes: 312,
    external_v4: null,
    external_v6: null,
    free_space: 1_210_000_000_000,
    disk_jobs_pending: 0,
  } satisfies Schemas["TransferInfo"];
  return { ...base, ...overrides };
}

export function sync(overrides: Partial<Schemas["SyncResponse"]> = {}): Schemas["SyncResponse"] {
  const base = {
    rev: 1,
    full: true,
    torrents: {},
    torrents_removed: [],
    categories: {},
    categories_removed: [],
    tags: [],
    transfer: transfer(),
  } satisfies Schemas["SyncResponse"];
  return { ...base, ...overrides };
}
