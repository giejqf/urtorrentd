// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { createQuery } from "@tanstack/solid-query";

import { api, unwrap } from "~/api/client";
import { keys } from "~/api/keys";

/**
 * `GET /app`: versions, start time, settings waiting for a restart, the time
 * zone, the fetched tracker list (followed every second until a fetch is
 * done).
 */
export function useAppInfo() {
  return createQuery(() => ({
    queryKey: keys.app(),
    queryFn: () => unwrap(api.GET("/api/v1/app")),
    refetchInterval: (q) => {
      const t = q.state.data?.fetched_trackers;
      const pending = t && (t.fetching || (t.fetched === null && t.error === null));
      return pending ? 1000 : 30_000;
    },
  }));
}

/** The machine the daemon runs on (`GET /app/system`), read every half minute. */
export function useSystemInfo() {
  return createQuery(() => ({
    queryKey: keys.system(),
    queryFn: () => unwrap(api.GET("/api/v1/app/system")),
    refetchInterval: 30_000,
  }));
}

/** `GET /stats`: what the statistics database holds (503 while it cannot be opened). */
export function useStatsInfo() {
  return createQuery(() => ({
    queryKey: keys.stats(),
    queryFn: () => unwrap(api.GET("/api/v1/stats")),
    refetchInterval: 60_000,
    retry: false,
  }));
}
