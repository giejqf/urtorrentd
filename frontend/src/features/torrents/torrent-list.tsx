// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The design's list (AGENTS.md 6.2, 6.3): 40px rows under 32px state
// headers, virtualized so 10 000 torrents cost only the rows on screen. A
// listbox: arrows and j/k move, Shift extends, Space starts or stops,
// Enter opens, Delete asks.

import { createVirtualizer } from "@tanstack/solid-virtual";
import { createEffect, Index, type JSX, Match, on, Show, Switch } from "solid-js";

import type { Schemas } from "~/api/client";
import { ProgressRing } from "~/components/progress-ring";
import { StatusDot } from "~/components/status-dot";
import { Badge } from "~/components/ui/badge";
import { dash, formatBytes, formatCount, formatEta, formatRate, formatRatio } from "~/lib/format";
import { categoryTone, stateLook, tagSummary, toneBg, type Tone } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import type { ListItem } from "./view";

type TorrentSummary = Schemas["TorrentSummary"];

const toneStroke: Record<Tone, string> = {
  brand: "stroke-brand",
  ok: "stroke-ok",
  warn: "stroke-warn",
  muted: "stroke-muted-foreground",
  subtle: "stroke-subtle",
  danger: "stroke-danger",
};

export const ROW = 40;
export const GROUP = 32;

export type SelectMode = "one" | "toggle" | "range";

function Rate(props: { t: TorrentSummary }) {
  return (
    <Switch fallback={<span class="text-subtle">{dash}</span>}>
      <Match when={props.t.download_rate > 0}>
        <span class="text-brand">
          <span aria-hidden="true">↓ </span>
          <span class="sr-only">downloading at </span>
          {formatRate(props.t.download_rate)}
        </span>
      </Match>
      <Match when={props.t.upload_rate > 0}>
        <span class="text-upload">
          <span aria-hidden="true">↑ </span>
          <span class="sr-only">uploading at </span>
          {formatRate(props.t.upload_rate)}
        </span>
      </Match>
    </Switch>
  );
}

function Row(props: {
  t: TorrentSummary;
  selected: boolean;
  focused: boolean;
  onPointer: (e: MouseEvent) => void;
}) {
  const look = () => stateLook(props.t);
  const tags = () => tagSummary(props.t.tags);
  return (
    <div
      id={`row-${props.t.hash}`}
      role="option"
      aria-selected={props.selected}
      class={cn(
        "grid h-10 w-full cursor-pointer grid-cols-[20px_minmax(0,1fr)_64px_84px_48px_56px_88px] items-center gap-3 border-b border-row-divider px-4 text-left select-none",
        props.selected ? "bg-accent" : "hover:bg-muted",
        props.focused && "shadow-[inset_2px_0_0_var(--brand)]",
      )}
      onClick={(e) => props.onPointer(e)}
      onContextMenu={(e) => props.onPointer(e)}
    >
      <ProgressRing
        progress={props.t.has_metadata ? props.t.progress : 0}
        class={toneStroke[look().tone]}
      />
      <div class="flex min-w-0 items-center gap-2">
        <span class="truncate font-medium">{props.t.name}</span>
        <span class="sr-only">, {look().label}</span>
        <Show when={tags().first}>
          {(first) => (
            <Badge>
              {first()}
              <Show when={tags().more > 0}>
                <span class="ml-1 text-subtle">+{tags().more}</span>
              </Show>
            </Badge>
          )}
        </Show>
      </div>
      <div class="text-right mono text-sm text-muted-foreground">
        {props.t.has_metadata ? formatBytes(props.t.size) : dash}
      </div>
      <div class="truncate text-right mono text-sm">
        <Rate t={props.t} />
      </div>
      <div class="text-right mono text-sm text-muted-foreground">{formatRatio(props.t.ratio)}</div>
      <div class="text-right mono text-sm text-muted-foreground">
        {props.t.complete ? "" : formatEta(props.t.eta)}
      </div>
      <div class="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
        <StatusDot class={categoryTone(props.t.category)} />
        <span class={cn("truncate", props.t.category === null && "text-subtle")}>
          {props.t.category ?? "none"}
        </span>
      </div>
    </div>
  );
}

function GroupHeader(props: { item: Extract<ListItem, { kind: "group" }> }) {
  return (
    <div
      aria-hidden="true"
      class="flex h-8 items-center gap-2 border-y border-divider bg-card px-4 text-sm font-medium text-foreground-2"
    >
      <StatusDot class={toneBg[props.item.group.tone]} />
      {props.item.group.label}
      <span class="mono text-xs text-subtle">{formatCount(props.item.count)}</span>
      <span class="flex-1" />
      <span class="flex gap-3 mono text-xs text-subtle">
        <Show when={props.item.down > 0}>
          <span>↓ {formatRate(props.item.down)}</span>
        </Show>
        <Show when={props.item.up > 0}>
          <span>↑ {formatRate(props.item.up)}</span>
        </Show>
      </span>
    </div>
  );
}

export function TorrentList(props: {
  items: readonly ListItem[];
  torrents: Record<string, TorrentSummary>;
  selected: ReadonlySet<string>;
  focus: string | null;
  onSelect: (hash: string, mode: SelectMode) => void;
  onKey: (e: KeyboardEvent) => void;
  empty?: JSX.Element;
}) {
  let scroller: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer({
    get count() {
      return props.items.length;
    },
    getScrollElement: () => scroller ?? null,
    estimateSize: (i) => (props.items[i]?.kind === "group" ? GROUP : ROW),
    getItemKey: (i) => {
      const item = props.items[i];
      if (!item) return i;
      return item.kind === "group" ? `group:${item.group.key}` : item.hash;
    },
    overscan: 12,
  });
  // Rows change kind (a torrent moves between groups): measure again.
  createEffect(
    on(
      () => props.items,
      () => virtualizer.measure(),
      { defer: true },
    ),
  );
  // Keep the focused torrent in view as the keyboard moves it.
  createEffect(
    on(
      () => props.focus,
      (hash) => {
        if (!hash) return;
        const i = props.items.findIndex((it) => it.kind === "torrent" && it.hash === hash);
        if (i >= 0) virtualizer.scrollToIndex(i, { align: "auto" });
      },
    ),
  );

  const mode = (e: MouseEvent): SelectMode =>
    e.shiftKey ? "range" : e.metaKey || e.ctrlKey ? "toggle" : "one";

  return (
    <Show
      when={props.items.length > 0}
      fallback={<div class="min-h-0 flex-1 overflow-auto">{props.empty}</div>}
    >
      <div
        ref={scroller}
        class="relative min-h-0 flex-1 overflow-auto outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
        role="listbox"
        aria-label="Torrents"
        aria-multiselectable="true"
        aria-activedescendant={props.focus ? `row-${props.focus}` : undefined}
        tabindex="0"
        onKeyDown={(e) => props.onKey(e)}
      >
        <div class="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          <Index each={virtualizer.getVirtualItems()}>
            {(v) => {
              const item = () => props.items[v().index];
              return (
                <div
                  class="absolute top-0 left-0 w-full"
                  style={{ height: `${v().size}px`, transform: `translateY(${v().start}px)` }}
                >
                  <Switch>
                    <Match
                      when={(() => {
                        const it = item();
                        return it?.kind === "group" ? it : null;
                      })()}
                    >
                      {(g) => <GroupHeader item={g()} />}
                    </Match>
                    <Match
                      when={(() => {
                        const it = item();
                        return it?.kind === "torrent" ? props.torrents[it.hash] : null;
                      })()}
                    >
                      {(t) => (
                        <Row
                          t={t()}
                          selected={props.selected.has(t().hash)}
                          focused={props.focus === t().hash}
                          onPointer={(e) => {
                            if (e.type === "contextmenu" && props.selected.has(t().hash)) return;
                            props.onSelect(t().hash, e.type === "contextmenu" ? "one" : mode(e));
                          }}
                        />
                      )}
                    </Match>
                  </Switch>
                </div>
              );
            }}
          </Index>
        </div>
      </div>
    </Show>
  );
}
