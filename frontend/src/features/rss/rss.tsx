// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The RSS screen, as the design has it: the articles of every feed, a
// folder, a feed, or what a rule takes (the sidebar, in the URL), newest
// first by age, filtered by what they are (unread, downloaded, matched) and
// by title; refreshed and marked read by the scope; and one article, or the
// rule, in the panel. Titles and descriptions come from strangers: text.

import { useSearchParams } from "@solidjs/router";
import { createVirtualizer } from "@tanstack/solid-virtual";
import RefreshCw from "lucide-solid/icons/refresh-cw";
import Search from "lucide-solid/icons/search";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";

import { api, type Schemas, unwrap } from "~/api/client";
import { StatusDot } from "~/components/status-dot";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import { PageHeader } from "~/features/shell/page-header";
import { AddDialog } from "~/features/torrents/add/add-dialog";
import { formatBytes, formatCount } from "~/lib/format";
import { useWide } from "~/lib/use-wide";
import { cn } from "~/lib/utils";

import { ArticlePanel } from "./article-panel";
import {
  markFeedsRead,
  refreshFeeds,
  useArticles,
  useFeeds,
  useMatches,
  useRssChange,
  useRules,
} from "./data";
import { RuleDialog, RuleSummary } from "./rule-dialog";
import type { RssParams } from "./sidebar";
import {
  byAge,
  feedName,
  feedsIn,
  isShow,
  scopeOf,
  SHOWS,
  visibleArticles,
  whenLabel,
} from "./view";

type Article = Schemas["RssArticle"];

type Item = { kind: "group"; label: string; count: number } | { kind: "article"; a: Article };

const keyOf = (a: Pick<Article, "feed" | "id">) => `${a.feed}\u0000${a.id}`;

function ArticleList(props: {
  items: readonly Item[];
  feedLabel: (id: number) => string;
  selected: string | null;
  now: number;
  onSelect: (a: Article) => void;
  empty: string;
}) {
  let scroller: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer({
    get count() {
      return props.items.length;
    },
    getScrollElement: () => scroller ?? null,
    estimateSize: (i) => (props.items[i]?.kind === "group" ? 30 : 40),
    getItemKey: (i) => {
      const it = props.items[i];
      return it?.kind === "article" ? keyOf(it.a) : `group:${it?.label ?? i}`;
    },
    overscan: 12,
  });
  createEffect(
    on(
      () => props.items,
      () => virtualizer.measure(),
      { defer: true },
    ),
  );
  return (
    <div ref={scroller} class="relative min-h-0 flex-1 overflow-auto">
      <Show
        when={props.items.length > 0}
        fallback={<p class="m-0 p-4 text-sm text-subtle">{props.empty}</p>}
      >
        <div
          role="list"
          aria-label="Articles"
          class="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          <For each={virtualizer.getVirtualItems()}>
            {(v) => {
              const item = () => props.items[v.index];
              return (
                <div
                  role="listitem"
                  class="absolute top-0 left-0 w-full"
                  style={{ height: `${v.size}px`, transform: `translateY(${v.start}px)` }}
                >
                  <Show
                    when={(() => {
                      const it = item();
                      return it?.kind === "article" ? it.a : null;
                    })()}
                    fallback={
                      <div class="flex h-[30px] items-center gap-2 border-y border-divider bg-card px-4 text-sm font-medium text-foreground-2">
                        {(() => {
                          const it = item();
                          return it?.kind === "group" ? it.label : "";
                        })()}
                        <span class="mono text-xs font-normal text-subtle">
                          {(() => {
                            const it = item();
                            return it?.kind === "group" ? it.count : "";
                          })()}
                        </span>
                      </div>
                    }
                  >
                    {(a) => (
                      <button
                        type="button"
                        aria-current={props.selected === keyOf(a()) ? "true" : undefined}
                        class={cn(
                          "grid h-10 w-full grid-cols-[14px_minmax(0,1fr)_20px] items-center gap-2.5 border-b border-row-divider px-4 text-left sm:grid-cols-[14px_minmax(0,1fr)_120px_64px_58px_20px]",
                          props.selected === keyOf(a()) ? "bg-accent" : "hover:bg-muted",
                        )}
                        onClick={() => props.onSelect(a())}
                      >
                        <StatusDot class={a().read ? "bg-transparent" : "bg-brand"} />
                        <span class="flex min-w-0 flex-col leading-tight">
                          <span
                            class={cn(
                              "truncate",
                              a().read ? "text-muted-foreground" : "font-medium text-foreground",
                            )}
                          >
                            {a().title}
                            <Show when={!a().read}>
                              <span class="sr-only"> (unread)</span>
                            </Show>
                          </span>
                          <span class="truncate text-xs text-subtle">
                            {[a().author, whenLabel(a().date, props.now)]
                              .filter((x) => x !== null)
                              .join(" · ")}
                          </span>
                        </span>
                        <span class="hidden h-[18px] max-w-[120px] items-center justify-self-start truncate rounded border border-border px-1.5 text-xs text-muted-foreground sm:inline-flex">
                          {props.feedLabel(a().feed)}
                        </span>
                        <span class="hidden text-right mono text-sm text-muted-foreground sm:block">
                          {a().size === null ? "" : formatBytes(a().size ?? 0)}
                        </span>
                        <span class="hidden text-right mono text-sm text-muted-foreground sm:block">
                          {whenLabel(a().date, props.now)}
                        </span>
                        <span class="flex justify-center text-sm text-ok">
                          <Show when={a().downloaded}>
                            <span aria-hidden="true">✓</span>
                            <span class="sr-only">downloaded</span>
                          </Show>
                        </span>
                      </button>
                    )}
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

export default function Rss() {
  const [params, setParams] = useSearchParams<RssParams>();
  const feeds = useFeeds();
  const rules = useRules();
  const articles = useArticles();
  const change = useRssChange();
  const wide = useWide();
  const scope = () => scopeOf(params);
  const ruleName = () => {
    const s = scope();
    return s.kind === "rule" ? s.name : null;
  };
  const matches = useMatches(ruleName);
  const show = () => (isShow(params.show) ? params.show : "all");
  const [selected, setSelected] = createSignal<string | null>(null);
  const [adding, setAdding] = createSignal<string | null>(null);
  // Choosing another scope starts without an article.
  createEffect(
    on(
      () => [params.feed, params.folder, params.rule],
      () => setSelected(null),
    ),
  );

  const now = () => Math.floor(Date.now() / 1000);
  const feedList = () => feeds.data ?? [];
  const feedById = createMemo(() => new Map(feedList().map((f) => [f.id, f])));
  const rule = () => (rules.data ?? []).find((r) => r.name === ruleName());
  const source = () => (scope().kind === "rule" ? (matches.data ?? []) : (articles.data ?? []));
  const visible = createMemo(() =>
    visibleArticles(source(), scope(), feedList(), show(), params.q ?? ""),
  );
  const items = createMemo<Item[]>(() =>
    byAge(visible(), now()).flatMap((g) => [
      { kind: "group" as const, label: g.label, count: g.articles.length },
      ...g.articles.map((a) => ({ kind: "article" as const, a })),
    ]),
  );
  // The article as read now (a mark changes it), else as shown.
  const article = () => {
    const key = selected();
    if (key === null) return null;
    return (
      (articles.data ?? []).find((a) => keyOf(a) === key) ??
      source().find((a) => keyOf(a) === key) ??
      null
    );
  };
  const title = () => {
    const s = scope();
    switch (s.kind) {
      case "all":
        return "All articles";
      case "folder":
        return s.path;
      case "feed": {
        const f = feedById().get(s.id);
        return f ? feedName(f) : "Feed";
      }
      case "rule":
        return `Rule · ${s.name}`;
    }
  };
  const inScope = () => feedsIn(scope(), feedList(), rules.data ?? []);
  const unread = () => visible().filter((a) => !a.read).length;

  const refresh = () => {
    const ids = inScope();
    if (ids.length > 0)
      void change(refreshFeeds(scope().kind === "all" ? "all" : ids), "Not refreshed.");
  };
  const markAll = () => {
    const ids = inScope();
    if (ids.length > 0)
      void change(
        markFeedsRead(scope().kind === "all" ? "all" : ids),
        "Not marked.",
        "Marked read",
      );
  };
  const markOne = (a: Article, read: boolean) =>
    void change(
      unwrap(
        api.POST("/api/v1/rss/feeds/{id}/read", {
          params: { path: { id: a.feed } },
          body: { articles: [a.id], unread: !read },
        }),
      ),
      "Not marked.",
    );

  const panel = () => (
    <Show
      when={article()}
      fallback={
        <Show
          when={rule()}
          fallback={
            <div class="flex h-full items-center justify-center bg-card p-6 text-center text-sm text-subtle">
              Choose an article to read it, download it, or see which rule takes it.
            </div>
          }
        >
          {(r) => (
            <RuleSummary
              rule={r()}
              feeds={feedList()}
              matches={matches.data?.length}
              onEdit={() => setParams({ edit: "1" })}
            />
          )}
        </Show>
      }
    >
      {(a) => (
        <ArticlePanel
          article={a()}
          feed={feedById().get(a().feed)}
          rule={(rules.data ?? []).find((r) => r.name === a().matched_rule)}
          onDownload={() => setAdding(a().torrent_url ?? a().link)}
          onRead={(read) => markOne(a(), read)}
          onRule={(name) => {
            setParams({ feed: undefined, folder: undefined, rule: name, edit: "1" });
            setSelected(null);
          }}
        />
      )}
    </Show>
  );

  return (
    <div class="flex min-w-0 flex-1">
      <main class="flex min-w-0 flex-1 flex-col border-r border-divider">
        <PageHeader
          title={title()}
          count={
            <span class="mono text-xs text-subtle">
              {formatCount(visible().length)} · {formatCount(unread())} unread
            </span>
          }
        >
          <Button variant="outline" size="sm" disabled={inScope().length === 0} onClick={refresh}>
            <RefreshCw />
            Refresh
          </Button>
          <Show when={scope().kind !== "rule"}>
            <Button variant="outline" size="sm" disabled={inScope().length === 0} onClick={markAll}>
              Mark all read
            </Button>
          </Show>
        </PageHeader>
        <div class="flex h-10 flex-none items-center gap-1.5 overflow-x-auto border-b border-divider px-4 max-sm:h-auto max-sm:flex-wrap max-sm:py-2">
          <div role="group" aria-label="Show" class="flex gap-1.5">
            <For each={SHOWS}>
              {(s) => (
                <button
                  type="button"
                  aria-pressed={show() === s.value}
                  class={cn(
                    "inline-flex h-[26px] items-center rounded-full border px-2.5 text-sm font-medium whitespace-nowrap",
                    show() === s.value
                      ? "border-border-strong bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:text-foreground",
                  )}
                  onClick={() => setParams({ show: s.value === "all" ? undefined : s.value })}
                >
                  {s.label}
                </button>
              )}
            </For>
          </div>
          <div class="flex-1" />
          <label class="flex h-7 w-[200px] flex-none items-center gap-1.5 rounded-md border border-border px-2 focus-within:border-ring focus-within:shadow-focus max-sm:w-full">
            <Search size={13} class="flex-none text-subtle" />
            <input
              class="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle"
              placeholder="Filter titles…"
              aria-label="Filter titles"
              value={params.q ?? ""}
              onInput={(e) =>
                setParams({ q: e.currentTarget.value || undefined }, { replace: true })
              }
            />
          </label>
        </div>
        <ArticleList
          items={items()}
          feedLabel={(id) => {
            const f = feedById().get(id);
            return f ? feedName(f) : "";
          }}
          selected={selected()}
          now={now()}
          onSelect={(a) => setSelected(keyOf(a))}
          empty={
            articles.isLoading || (scope().kind === "rule" && matches.isLoading)
              ? "Reading…"
              : feedList().length === 0
                ? "No feed yet: add one from the sidebar."
                : scope().kind === "rule"
                  ? "Its filters take nothing from its feeds now."
                  : "No article here."
          }
        />
      </main>
      <Show when={wide()}>
        <aside class="flex w-[420px] flex-none flex-col" aria-label="Article">
          {panel()}
        </aside>
      </Show>
      <Sheet
        open={!wide() && (selected() !== null || rule() !== undefined)}
        onOpenChange={(o) => {
          if (!o) {
            if (selected() !== null) setSelected(null);
            else setParams({ rule: undefined });
          }
        }}
      >
        <SheetContent position="right" class="w-full max-w-[420px] p-0">
          <SheetTitle class="sr-only">Article</SheetTitle>
          {panel()}
        </SheetContent>
      </Sheet>
      <RuleDialog
        rule={params.edit ? rule() : undefined}
        feeds={feedList()}
        onClose={() => setParams({ edit: undefined })}
        onRenamed={(name) => setParams({ rule: name, edit: undefined })}
        onDeleted={() => setParams({ rule: undefined, edit: undefined })}
      />
      <AddDialog
        open={adding() !== null}
        links={adding() ?? undefined}
        onClose={() => setAdding(null)}
      />
    </div>
  );
}
