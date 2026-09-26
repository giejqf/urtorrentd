// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The RSS screen's part of the sidebar, as the design has it: every feed in
// its folders with what is unread and whether it works, the download rules
// with what they would take, and when the next refresh is due. Feeds and
// folders are added, changed and removed from here; a rule is made here
// and edited in the screen's panel.

import { useSearchParams } from "@solidjs/router";
import { createQuery } from "@tanstack/solid-query";
import Ellipsis from "lucide-solid/icons/ellipsis";
import Plus from "lucide-solid/icons/plus";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { PromptDialog } from "~/components/prompt-dialog";
import { StatusDot } from "~/components/status-dot";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { FilterItem, Section } from "~/features/shell/sidebar";
import { formatCount, formatTime } from "~/lib/format";

import {
  markFeedsRead,
  refreshFeeds,
  useArticles,
  useFeeds,
  useFolders,
  useRssChange,
  useRules,
} from "./data";
import { ConfirmDialog, FeedDialog } from "./dialogs";
import { newRule } from "./rule-form";
import { feedName, feedTree, inFolder, nextRefresh, scopeOf } from "./view";

type Feed = Schemas["RssFeed"];

export interface RssParams {
  feed?: string;
  folder?: string;
  rule?: string;
  show?: string;
  q?: string;
  [key: string]: string | undefined;
}

/** A row of the tree: the item, and its menu beside it. */
function TreeRow(props: {
  indent: number;
  active: boolean;
  label: JSX.Element;
  count?: number;
  menuLabel: string;
  onSelect: () => void;
  menu: JSX.Element;
}) {
  return (
    <div class="group relative">
      <FilterItem
        label={props.label}
        count={props.count ? props.count : undefined}
        strong={(props.count ?? 0) > 0}
        indent={props.indent}
        active={props.active}
        onClick={() => props.onSelect()}
        class="pr-8"
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          as="button"
          aria-label={props.menuLabel}
          class="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-sidebar text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-[expanded]:opacity-100"
        >
          <Ellipsis size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent class="w-48">{props.menu}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export default function RssSidebar(props: { onNavigate?: () => void }) {
  const [params, setParams] = useSearchParams<RssParams>();
  const feeds = useFeeds();
  const folders = useFolders();
  const rules = useRules();
  const articles = useArticles();
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
  }));
  const change = useRssChange();
  const scope = () => scopeOf(params);

  const [feedDialog, setFeedDialog] = createSignal<{ feed: Feed | null; folder: string | null }>();
  const [prompt, setPrompt] = createSignal<
    { kind: "folder" } | { kind: "rename"; path: string } | { kind: "rule" } | null
  >(null);
  const [removing, setRemoving] = createSignal<
    { kind: "feed"; feed: Feed } | { kind: "folder"; path: string } | null
  >(null);

  const list = () => feeds.data ?? [];
  const tree = createMemo(() => feedTree(list(), folders.data ?? []));
  const unread = () => list().reduce((n, f) => n + f.unread, 0);
  const matched = createMemo(() => {
    const m = new Map<string, number>();
    for (const a of articles.data ?? []) {
      if (a.matched_rule !== null) m.set(a.matched_rule, (m.get(a.matched_rule) ?? 0) + 1);
    }
    return m;
  });
  const now = () => Math.floor(Date.now() / 1000);
  const next = () => {
    const s = settings.data;
    return s ? nextRefresh(list(), s.rss_enabled, s.rss_refresh_interval, now()) : null;
  };

  const go = (p: Partial<RssParams>) => {
    setParams({ feed: undefined, folder: undefined, rule: undefined, ...p });
    props.onNavigate?.();
  };

  const feedsOfFolder = (path: string) =>
    list()
      .filter((f) => inFolder(f.folder, path))
      .map((f) => f.id);

  const onPrompt = async (value: string) => {
    const p = prompt();
    if (!p) return;
    if (p.kind === "folder") {
      await change(
        unwrap(api.POST("/api/v1/rss/folders", { body: { path: value } })),
        "The folder could not be made.",
        `Folder ${value} made`,
      );
    } else if (p.kind === "rename") {
      const cut = p.path.lastIndexOf("/");
      const to = cut < 0 ? value : `${p.path.slice(0, cut)}/${value}`;
      const done = await change(
        unwrap(api.POST("/api/v1/rss/folders/move", { body: { from: p.path, to } })),
        "The folder could not be renamed.",
      );
      if (done !== undefined && scope().kind === "folder") go({ folder: to });
    } else {
      if ((rules.data ?? []).some((r) => r.name === value)) {
        toast.error(`A rule named ${value} exists.`);
        return;
      }
      const made = await change(
        unwrap(
          api.PUT("/api/v1/rss/rules/{name}", {
            params: { path: { name: value } },
            body: newRule(),
          }),
        ),
        "The rule could not be made.",
      );
      if (made) go({ rule: made.name });
    }
  };
  const onRemove = async () => {
    const r = removing();
    if (!r) return;
    if (r.kind === "feed") {
      await change(
        unwrap(api.DELETE("/api/v1/rss/feeds/{id}", { params: { path: { id: r.feed.id } } })),
        "The feed could not be removed.",
        `${feedName(r.feed)} removed`,
      );
      if (scope().kind === "feed") go({});
    } else {
      await change(
        unwrap(api.POST("/api/v1/rss/folders/remove", { body: { path: r.path } })),
        "The folder could not be removed.",
        `Folder ${r.path} removed`,
      );
      if (scope().kind === "folder") go({});
    }
  };

  const feedDot = (f: Feed) =>
    f.loading ? "bg-warn motion-safe:animate-pulse" : f.error !== null ? "bg-danger" : "bg-ok";

  return (
    <>
      <div class="flex min-h-0 flex-1 flex-col overflow-auto px-2 py-2">
        <Section
          title="Feeds"
          action={
            <DropdownMenu>
              <DropdownMenuTrigger
                as="button"
                aria-label="Add a feed or folder"
                class="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              >
                <Plus size={12} stroke-width={2.5} />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="w-44">
                <DropdownMenuItem
                  onSelect={() =>
                    setFeedDialog({
                      feed: null,
                      folder: scope().kind === "folder" ? (params.folder ?? null) : null,
                    })
                  }
                >
                  Add feed…
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPrompt({ kind: "folder" })}>
                  New folder…
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          }
        >
          <FilterItem
            label={
              <>
                <StatusDot class="bg-foreground" />
                All articles
              </>
            }
            count={unread() || undefined}
            strong={unread() > 0}
            active={scope().kind === "all"}
            onClick={() => go({})}
          />
          <For each={tree()}>
            {(node) =>
              node.kind === "folder" ? (
                <TreeRow
                  indent={node.depth}
                  active={scope().kind === "folder" && params.folder === node.path}
                  label={
                    <>
                      <StatusDot class="bg-faint" />
                      <span class="truncate" title={node.path}>
                        {node.name}
                      </span>
                    </>
                  }
                  count={node.unread}
                  menuLabel={`Folder ${node.path}: actions`}
                  onSelect={() => go({ folder: node.path })}
                  menu={
                    <>
                      <DropdownMenuItem
                        onSelect={() =>
                          void change(refreshFeeds(feedsOfFolder(node.path)), "Not refreshed.")
                        }
                      >
                        Refresh
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() =>
                          void change(markFeedsRead(feedsOfFolder(node.path)), "Not marked.")
                        }
                      >
                        Mark all read
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => setFeedDialog({ feed: null, folder: node.path })}
                      >
                        Add feed here…
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => setPrompt({ kind: "rename", path: node.path })}
                      >
                        Rename…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        class="text-danger"
                        onSelect={() => setRemoving({ kind: "folder", path: node.path })}
                      >
                        Remove…
                      </DropdownMenuItem>
                    </>
                  }
                />
              ) : (
                <TreeRow
                  indent={node.depth}
                  active={scope().kind === "feed" && params.feed === String(node.feed.id)}
                  label={
                    <>
                      <StatusDot class={feedDot(node.feed)} />
                      <span class="truncate" title={node.feed.error ?? undefined}>
                        {feedName(node.feed)}
                      </span>
                      <Show when={node.feed.error !== null}>
                        <span class="sr-only"> (failing)</span>
                      </Show>
                    </>
                  }
                  count={node.feed.unread}
                  menuLabel={`${feedName(node.feed)}: actions`}
                  onSelect={() => go({ feed: String(node.feed.id) })}
                  menu={
                    <>
                      <DropdownMenuItem
                        onSelect={() => void change(refreshFeeds([node.feed.id]), "Not refreshed.")}
                      >
                        Refresh
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => void change(markFeedsRead([node.feed.id]), "Not marked.")}
                      >
                        Mark all read
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onSelect={() => setFeedDialog({ feed: node.feed, folder: null })}
                      >
                        Edit…
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        class="text-danger"
                        onSelect={() => setRemoving({ kind: "feed", feed: node.feed })}
                      >
                        Remove…
                      </DropdownMenuItem>
                    </>
                  }
                />
              )
            }
          </For>
          <Show when={feeds.isSuccess && list().length === 0}>
            <p class="m-0 px-2 py-1 text-sm text-subtle">No feed yet.</p>
          </Show>
        </Section>
        <Section
          title="Rules"
          action={
            <button
              type="button"
              aria-label="New rule"
              class="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
              onClick={() => setPrompt({ kind: "rule" })}
            >
              <Plus size={12} stroke-width={2.5} />
            </button>
          }
        >
          <For each={rules.data ?? []}>
            {(r) => (
              <FilterItem
                label={
                  <>
                    <StatusDot class={r.enabled ? "bg-ok" : "bg-faint"} />
                    <span class="truncate">{r.name}</span>
                  </>
                }
                count={r.enabled ? (matched().get(r.name) ?? 0) : "off"}
                title={r.enabled ? "Articles it would take now" : "Off"}
                active={scope().kind === "rule" && params.rule === r.name}
                onClick={() => go({ rule: r.name })}
              />
            )}
          </For>
          <Show when={rules.isSuccess && (rules.data ?? []).length === 0}>
            <p class="m-0 px-2 py-1 text-sm text-subtle">No rule yet.</p>
          </Show>
        </Section>
      </div>
      <div class="flex flex-none flex-col gap-1.5 border-t border-divider px-3 py-2.5 mono text-xs text-subtle">
        <div class="flex flex-wrap justify-between gap-x-2">
          <span>
            {settings.data?.rss_enabled === false
              ? "polling off"
              : next() === null
                ? "nothing to refresh"
                : `next refresh ${formatTime(next() ?? 0).slice(0, 5)}`}
          </span>
          <Show when={settings.data}>
            {(s) => (
              <span class="flex-none">every {Math.round(s().rss_refresh_interval / 60)} min</span>
            )}
          </Show>
        </div>
        <div class="flex flex-wrap justify-between gap-x-2">
          <span>
            {formatCount(list().length)} {list().length === 1 ? "feed" : "feeds"}
            {list().some((f) => f.error !== null)
              ? ` · ${list().filter((f) => f.error !== null).length} failing`
              : ""}
          </span>
          <span class="flex-none">
            {formatCount((articles.data ?? []).filter((a) => a.downloaded).length)} auto-added
          </span>
        </div>
      </div>

      <FeedDialog
        open={feedDialog() !== undefined}
        feed={feedDialog()?.feed ?? null}
        folder={feedDialog()?.folder ?? null}
        folders={folders.data ?? []}
        onClose={() => setFeedDialog(undefined)}
        onSaved={(f) => {
          void change(Promise.resolve(f), "", feedDialog()?.feed ? "Feed saved" : "Feed added");
          if (!feedDialog()?.feed) go({ feed: String(f.id) });
        }}
      />
      <PromptDialog
        open={prompt() !== null}
        title={
          prompt()?.kind === "folder"
            ? "New folder"
            : prompt()?.kind === "rename"
              ? "Rename folder"
              : "New rule"
        }
        label={prompt()?.kind === "rule" ? "Rule name" : "Folder name"}
        action={prompt()?.kind === "rename" ? "Rename" : "Make"}
        initial={(() => {
          const p = prompt();
          return p?.kind === "rename" ? p.path.slice(p.path.lastIndexOf("/") + 1) : "";
        })()}
        onClose={() => setPrompt(null)}
        onSubmit={(v) => void onPrompt(v)}
      />
      <ConfirmDialog
        open={removing() !== null}
        title={(() => {
          const r = removing();
          return r?.kind === "feed"
            ? `Remove ${feedName(r.feed)}?`
            : `Remove folder ${r?.path ?? ""}?`;
        })()}
        description={
          removing()?.kind === "feed"
            ? "Its articles go with it. Torrents a rule added stay."
            : "Its feeds and their articles go with it. Torrents a rule added stay."
        }
        action="Remove"
        onClose={() => setRemoving(null)}
        onConfirm={() => void onRemove()}
      />
    </>
  );
}
