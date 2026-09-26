// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// TanStack Query keys, one per API resource (AGENTS.md 4.2). A mutation
// invalidates the keys it changes; keys nest so `torrent(hash)` covers every
// part of one torrent.

export type TorrentPart = "files" | "peers" | "trackers" | "webseeds" | "pieces";

export const keys = {
  authStatus: () => ["auth", "status"] as const,
  app: () => ["app"] as const,
  system: () => ["app", "system"] as const,
  cookies: () => ["app", "cookies"] as const,
  account: () => ["auth", "account"] as const,
  sessions: () => ["auth", "sessions"] as const,
  loginBans: () => ["auth", "bans"] as const,
  requestCheck: () => ["auth", "check"] as const,
  stats: () => ["stats"] as const,
  geoStats: (dim: "country" | "asn") => ["stats", "geo", dim] as const,
  settings: () => ["settings"] as const,
  torrent: (hash: string) => ["torrent", hash] as const,
  torrentPart: (hash: string, part: TorrentPart) => ["torrent", hash, part] as const,
  log: () => ["log"] as const,
  peerLog: () => ["log", "peers"] as const,
  clientData: (keys: readonly string[]) => ["client-data", ...keys] as const,
};
