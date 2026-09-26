// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The reports' queries. A range ending now moves with a clock that ticks
// once a minute (the daemon writes its buckets once a minute), and the last
// answer stays on screen while the next one loads.

import { createQuery, keepPreviousData } from "@tanstack/solid-query";
import { type Accessor, createSignal, onCleanup } from "solid-js";

import { api, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";

/** Unix seconds, to the minute, updated every minute. */
export function useMinuteClock(): Accessor<number> {
  const minute = () => Math.floor(Date.now() / 60_000) * 60;
  const [now, setNow] = createSignal(minute());
  const timer = setInterval(() => setNow(minute()), 5_000);
  onCleanup(() => clearInterval(timer));
  return now;
}

type Span = { from: number; to: number };

const REFRESH = 60_000;

export function useTransfer(span: Accessor<Span | null>) {
  return createQuery(() => {
    const s = span();
    const query = { from: s?.from ?? 0, to: s?.to ?? 0 };
    return {
      queryKey: keys.statsReport("transfer", query),
      queryFn: () => unwrap(api.GET("/api/v1/stats/transfer", { params: { query } })),
      enabled: s !== null,
      placeholderData: keepPreviousData,
      refetchInterval: REFRESH,
      retry: false,
    };
  });
}

export function useTop(span: Accessor<Span>, by: Accessor<Schemas["TopMetric"]>) {
  return createQuery(() => {
    const query = { ...span(), by: by(), limit: 5 };
    return {
      queryKey: keys.statsReport("top", query),
      queryFn: () => unwrap(api.GET("/api/v1/stats/top", { params: { query } })),
      placeholderData: keepPreviousData,
      refetchInterval: REFRESH,
      retry: false,
    };
  });
}

export function useCategories(span: Accessor<Span>) {
  return createQuery(() => {
    const query = { ...span(), group: "category" as const, limit: 6 };
    return {
      queryKey: keys.statsReport("groups", query),
      queryFn: () => unwrap(api.GET("/api/v1/stats/groups", { params: { query } })),
      placeholderData: keepPreviousData,
      refetchInterval: REFRESH,
      retry: false,
    };
  });
}

export function usePeers(span: Accessor<Span>, dim: Accessor<Schemas["PeerDimension"]>) {
  return createQuery(() => {
    const query = { ...span(), dim: dim(), limit: 250 };
    return {
      queryKey: keys.statsReport("peers", query),
      queryFn: () => unwrap(api.GET("/api/v1/stats/peers", { params: { query } })),
      placeholderData: keepPreviousData,
      refetchInterval: REFRESH,
      retry: false,
    };
  });
}

export function useIdleSeeds() {
  return createQuery(() => {
    const query = { days: 30, limit: 50 };
    return {
      queryKey: keys.statsReport("idle-seeds", query),
      queryFn: () => unwrap(api.GET("/api/v1/stats/idle-seeds", { params: { query } })),
      refetchInterval: REFRESH,
      retry: false,
    };
  });
}

export function useTimeline(limit: number) {
  return createQuery(() => {
    const query = { limit };
    return {
      queryKey: keys.statsReport("timeline", query),
      queryFn: () => unwrap(api.GET("/api/v1/stats/timeline", { params: { query } })),
      refetchInterval: 30_000,
      retry: false,
    };
  });
}

export function useTrackerStats(span: Accessor<Span>, by: Accessor<Schemas["TopMetric"]>) {
  return createQuery(() => {
    // From the hour's start, so the first hour counts whole; the daemon
    // picks hours when it keeps them for the range, else days. 40 hosts
    // keep 90 days of hours within its series limit; longer is in days.
    const s = span();
    const query = {
      from: Math.floor(s.from / 3600) * 3600,
      to: s.to,
      by: by(),
      limit: 40,
      series: true,
      ...(s.to - s.from > 91 * 86_400 ? { step: "day" as const } : {}),
    };
    return {
      queryKey: keys.statsReport("trackers", query),
      queryFn: () => unwrap(api.GET("/api/v1/stats/trackers", { params: { query } })),
      placeholderData: keepPreviousData,
      refetchInterval: REFRESH,
      retry: false,
    };
  });
}

/** Tracker hosts across the torrents now, with the ones failing. */
export function useTrackerHosts() {
  return createQuery(() => ({
    queryKey: keys.trackerHosts(),
    queryFn: () => unwrap(api.GET("/api/v1/torrents/trackers")),
    refetchInterval: 10_000,
  }));
}
