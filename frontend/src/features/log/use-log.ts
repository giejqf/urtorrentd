// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The main log as the Log screen and its sidebar share it: read once, then
// only what is newer (`GET /log?after=`) every 2 s, and kept up to what the
// daemon keeps. Ids start over when the daemon restarts, so the log is kept
// per run (its start time).

import { createQuery, useQueryClient } from "@tanstack/solid-query";

import { api, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { useAppInfo } from "~/features/settings/app-info";

type Entry = Schemas["LogEntry"];

/** What the daemon keeps of its main log (`log.rs`). */
const KEPT = 10_000;

export function useMainLog() {
  const client = useQueryClient();
  const app = useAppInfo();
  const run = () => app.data?.started_at ?? 0;
  return createQuery(() => ({
    queryKey: keys.mainLog(run()),
    queryFn: async () => {
      const key = keys.mainLog(run());
      const before = client.getQueryData<Entry[]>(key) ?? [];
      const last = before.at(-1)?.id;
      const more = await unwrap(
        api.GET("/api/v1/log", { params: { query: last === undefined ? {} : { after: last } } }),
      );
      if (more.length === 0) return before;
      const all = before.concat(more);
      return all.length > KEPT ? all.slice(-KEPT) : all;
    },
    enabled: app.data !== undefined,
    refetchInterval: 2000,
    structuralSharing: false,
  }));
}

/** The peer log (bans), as Settings › Banned addresses reads it. */
export function usePeerLog() {
  return createQuery(() => ({
    queryKey: keys.peerLog(),
    queryFn: () => unwrap(api.GET("/api/v1/log/peers")),
    refetchInterval: 10_000,
  }));
}
