// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// One article, as the design has it: its title and whether it is read,
// downloaded or matched; Download (the add dialog, with its torrent) and
// Mark read; where it comes from (links by host only: they can carry
// passkeys; the article's page opens on a click); its description as text;
// and how the rule that matches it would add it.

import { createQuery } from "@tanstack/solid-query";
import DownloadIcon from "lucide-solid/icons/download";
import ExternalLink from "lucide-solid/icons/external-link";
import { For, type JSX, Show } from "solid-js";

import { api, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { StatusDot } from "~/components/status-dot";
import { Button } from "~/components/ui/button";
import { useLive } from "~/features/shell/live";
import { dash, formatBytes, formatFullDateTime } from "~/lib/format";
import { categoryTone } from "~/lib/torrent";

import { ruleSavePath } from "./rule-form";
import { feedName, htmlText, shownLink } from "./view";

type Article = Schemas["RssArticle"];
type Feed = Schemas["RssFeed"];
type Rule = Schemas["RssRule"];

function Pill(props: { dot: string; children: JSX.Element }) {
  return (
    <span class="inline-flex h-[22px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-sm font-medium whitespace-nowrap">
      <StatusDot class={props.dot} />
      {props.children}
    </span>
  );
}

export function Prop(props: { label: string; children: JSX.Element; title?: string }) {
  return (
    <div class="grid min-h-7 grid-cols-[90px_minmax(0,1fr)] items-center gap-3 text-sm">
      <span class="text-subtle">{props.label}</span>
      <span class="flex min-w-0 items-center gap-1.5" title={props.title}>
        {props.children}
      </span>
    </div>
  );
}

export function Heading(props: { children: JSX.Element; aside?: JSX.Element }) {
  return (
    <div class="flex items-center justify-between gap-3">
      <h3 class="m-0 text-xs font-medium tracking-[0.04em] text-subtle uppercase">
        {props.children}
      </h3>
      {props.aside}
    </div>
  );
}

export function ArticlePanel(props: {
  article: Article;
  feed: Feed | undefined;
  rule: Rule | undefined;
  onDownload: () => void;
  onRead: (read: boolean) => void;
  onRule: (name: string) => void;
}) {
  const live = useLive();
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
  }));
  const a = () => props.article;
  const text = () => (a().description ? htmlText(a().description ?? "") : "");
  const source = () => a().torrent_url ?? a().link;
  return (
    <div class="flex h-full min-h-0 flex-col bg-card">
      <div class="flex h-12 flex-none items-center gap-1 border-b border-divider pr-3 pl-4">
        <span class="min-w-0 flex-1 truncate text-sm text-subtle">
          {props.feed ? feedName(props.feed) : "A feed"} <span aria-hidden="true">›</span> article
        </span>
        <Show when={a().link}>
          {(link) => (
            <Button
              as="a"
              href={link()}
              target="_blank"
              rel="noopener noreferrer"
              variant="ghost"
              size="icon"
              aria-label="Open the article's page"
            >
              <ExternalLink />
            </Button>
          )}
        </Show>
      </div>
      <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <div class="flex flex-col gap-2.5">
          <h2 class="m-0 text-md leading-snug font-semibold break-words">{a().title}</h2>
          <div class="flex flex-wrap items-center gap-2">
            <Show when={a().downloaded}>
              <Pill dot="bg-ok">Added by a rule</Pill>
            </Show>
            <Show when={a().matched_rule !== null && !a().downloaded}>
              <Pill dot="bg-warn">Matches “{a().matched_rule}”</Pill>
            </Show>
            <Show when={!a().read}>
              <Pill dot="bg-brand">Unread</Pill>
            </Show>
          </div>
          <div class="flex gap-2">
            <Button class="flex-1" disabled={source() === null} onClick={() => props.onDownload()}>
              <DownloadIcon />
              Download
            </Button>
            <Button variant="outline" onClick={() => props.onRead(!a().read)}>
              {a().read ? "Mark unread" : "Mark read"}
            </Button>
          </div>
        </div>

        <div class="flex flex-col">
          <Heading>Article</Heading>
          <div class="mt-1.5 flex flex-col">
            <Prop label="Feed">
              <StatusDot class={props.feed?.error ? "bg-danger" : "bg-ok"} />
              <span class="truncate">{props.feed ? feedName(props.feed) : dash}</span>
            </Prop>
            <Prop label="Published">
              <span class="mono">{formatFullDateTime(a().date)}</span>
            </Prop>
            <Prop label="Author">
              <span class="truncate">{a().author ?? dash}</span>
            </Prop>
            <Prop label="Size">
              <span class="mono">{a().size === null ? dash : formatBytes(a().size ?? 0)}</span>
            </Prop>
            <Prop label="Torrent">
              <span class="truncate mono text-xs text-muted-foreground">
                {a().torrent_url ? shownLink(a().torrent_url ?? "") : dash}
              </span>
            </Prop>
            <Prop label="Link">
              <span class="truncate mono text-xs text-muted-foreground">
                {a().link ? shownLink(a().link ?? "") : dash}
              </span>
            </Prop>
          </div>
        </div>

        <Show when={text() !== ""}>
          <div class="flex flex-col gap-2">
            <Heading>Description</Heading>
            <div
              class="rounded-lg border border-divider bg-background p-3 text-sm leading-normal break-words whitespace-pre-line text-foreground-2"
              tabIndex={0}
              aria-label="Description"
            >
              {text()}
            </div>
          </div>
        </Show>

        <Show when={props.rule}>
          {(r) => (
            <div class="flex flex-col gap-2">
              <Heading
                aside={
                  <Button
                    variant="outline"
                    size="sm"
                    class="h-[22px] px-2 text-xs"
                    onClick={() => props.onRule(r().name)}
                  >
                    Edit rule
                  </Button>
                }
              >
                {a().downloaded ? "Added as" : "Would be added as"}
              </Heading>
              <div class="flex flex-col">
                <Prop label="Rule">
                  <span class="truncate">{r().name}</span>
                </Prop>
                <Prop label="Category">
                  <Show
                    when={r().add_options.category}
                    fallback={<span class="text-subtle">none</span>}
                  >
                    {(c) => (
                      <>
                        <StatusDot class={categoryTone(c())} />
                        <span class="truncate">{c()}</span>
                      </>
                    )}
                  </Show>
                </Prop>
                <Prop label="Tags">
                  <Show
                    when={(r().add_options.tags ?? []).length > 0}
                    fallback={<span class="text-subtle">none</span>}
                  >
                    <span class="flex flex-wrap gap-1">
                      <For each={r().add_options.tags ?? []}>
                        {(t) => (
                          <span class="inline-flex h-[18px] items-center rounded border border-border px-1.5 text-xs text-muted-foreground">
                            {t}
                          </span>
                        )}
                      </For>
                    </span>
                  </Show>
                </Prop>
                <Show when={settings.data}>
                  {(s) => {
                    const path = () => ruleSavePath(r().add_options, live.state.categories, s());
                    return (
                      <Prop label="Save path" title={path()}>
                        <span class="truncate mono text-xs">{path()}</span>
                      </Prop>
                    );
                  }}
                </Show>
                <Prop label="Starts">
                  <span class="text-muted-foreground">
                    {r().add_options.stopped === true
                      ? "stopped"
                      : r().add_options.stopped === false
                        ? "at once"
                        : settings.data?.add_stopped
                          ? "stopped (the setting)"
                          : "at once (the setting)"}
                  </span>
                </Prop>
                <Prop label="Smart filter">
                  <span class="text-muted-foreground">
                    {r().smart_filter ? "on" : "off"} · ignore {r().ignore_days} d
                  </span>
                </Prop>
              </div>
            </div>
          )}
        </Show>
      </div>
    </div>
  );
}
