// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// RSS as the screen and its sidebar share it: feeds (read every second
// while one refreshes, or was never read: a feed just added), folders,
// rules, and the articles of every feed (the newest 5000); and the
// changes, each followed by a fresh read.

import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";

type Feed = Schemas["RssFeed"];

const loading = (feeds: readonly Feed[] | undefined) =>
  feeds?.some((f) => f.loading || f.last_refresh === null) ?? false;

export function useFeeds() {
  return createQuery(() => ({
    queryKey: keys.rssFeeds(),
    queryFn: () => unwrap(api.GET("/api/v1/rss/feeds")),
    refetchInterval: (q) => (loading(q.state.data) ? 1000 : 15_000),
  }));
}

export function useFolders() {
  return createQuery(() => ({
    queryKey: keys.rssFolders(),
    queryFn: () => unwrap(api.GET("/api/v1/rss/folders")),
  }));
}

export function useRules() {
  return createQuery(() => ({
    queryKey: keys.rssRules(),
    queryFn: () => unwrap(api.GET("/api/v1/rss/rules")),
    refetchInterval: 30_000,
  }));
}

export function useArticles() {
  const client = useQueryClient();
  return createQuery(() => ({
    queryKey: keys.rssArticles(),
    queryFn: () => unwrap(api.GET("/api/v1/rss/articles", { params: { query: { limit: 5000 } } })),
    refetchInterval: () => (loading(client.getQueryData(keys.rssFeeds())) ? 2000 : 15_000),
  }));
}

/** What a rule's filters take from its feeds (a dry run). */
export function useMatches(rule: () => string | null) {
  return createQuery(() => ({
    queryKey: keys.rssMatches(rule() ?? ""),
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/rss/rules/{name}/matches", {
          params: { path: { name: rule() ?? "" } },
        }),
      ),
    enabled: rule() !== null,
    retry: false,
  }));
}

/** Run a change; on failure say why. Every RSS read is refreshed after. */
export function useRssChange() {
  const client = useQueryClient();
  return async function change<T>(
    what: Promise<T>,
    failed: string,
    done?: string,
  ): Promise<T | undefined> {
    try {
      const r = await what;
      if (done) toast.success(done);
      return r;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : failed);
      return undefined;
    } finally {
      await client.invalidateQueries({ queryKey: keys.rss() });
    }
  };
}

/** Refresh feeds now. */
export function refreshFeeds(ids: number[] | "all") {
  return unwrap(api.POST("/api/v1/rss/feeds/refresh", { body: { feeds: ids } }));
}

/** Mark every article of feeds read. */
export function markFeedsRead(ids: number[] | "all") {
  return unwrap(api.POST("/api/v1/rss/feeds/read", { body: { feeds: ids } }));
}
