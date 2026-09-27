// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The design's list (AGENTS.md 6.2, 6.3): 40px rows under 32px state
// headers, virtualized so 10 000 torrents cost only the rows on screen. A
// listbox: arrows and j/k move, Shift extends, Space starts or stops,
// Enter opens, Delete asks. Each row's box adds it to the selection or
// takes it out (shown on hover, and on every row while several are
// chosen); it is the option's own state, so it is not a control of its own.
// On a phone (AGENTS.md 6.3) a row takes two lines, the name above its
// state, progress, rate and size, and every row shows its box, since there
// is no hover and no modifier key to choose several.

import { createVirtualizer } from "@tanstack/solid-virtual";
import Check from "lucide-solid/icons/check";
import { createEffect, Index, type JSX, Match, on, Show, Switch } from "solid-js";

import type { Schemas } from "~/api/client";
import { ProgressRing } from "~/components/progress-ring";
import { StatusDot } from "~/components/status-dot";
import { Badge } from "~/components/ui/badge";
import {
  dash,
  formatBytes,
  formatCount,
  formatEta,
  formatPercent,
  formatRate,
  formatRatio,
} from "~/lib/format";
import { categoryTone, stateLook, tagSummary, toneBg, type Tone } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import type { ListItem } from "./view";

type TorrentSummary = Schemas["TorrentSummary"];

const toneStroke: Record<Tone, string> = {
  brand: "stroke-brand",
  ok: "stroke-ok",
  idle: "stroke-ok/45",
  warn: "stroke-warn",
  muted: "stroke-muted-foreground",
  subtle: "stroke-subtle",
  danger: "stroke-danger",
};

export const ROW = 40;
/** A phone's two-line row. */
export const ROW_COMPACT = 52;
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
  checkboxes: boolean;
  compact: boolean;
  onPointer: (e: MouseEvent) => void;
  onToggle: () => void;
}) {
  const look = () => stateLook(props.t);
  return (
    <div
      id={`row-${props.t.hash}`}
      role="option"
      aria-selected={props.selected}
      class={cn(
        "group grid w-full cursor-pointer items-center gap-3 border-b border-row-divider px-4 text-left select-none",
        props.compact
          ? "h-[52px] grid-cols-[16px_20px_minmax(0,1fr)]"
          : "h-10 grid-cols-[16px_20px_minmax(0,1fr)_64px_84px_48px_56px_88px]",
        props.selected ? "bg-accent" : "hover:bg-muted",
        props.focused && "shadow-[inset_2px_0_0_var(--brand)]",
      )}
      onClick={(e) => props.onPointer(e)}
      onContextMenu={(e) => props.onPointer(e)}
    >
      <span
        aria-hidden="true"
        class={cn(
          "flex size-3.5 items-center justify-center rounded-sm border transition-opacity",
          props.selected
            ? "border-primary bg-primary text-primary-foreground"
            : "border-border-strong bg-background",
          !props.checkboxes &&
            !props.compact &&
            !props.selected &&
            "opacity-0 group-hover:opacity-100",
        )}
        onClick={(e) => {
          e.stopPropagation();
          props.onToggle();
        }}
      >
        <Show when={props.selected}>
          <Check size={10} stroke-width={3.5} />
        </Show>
      </span>
      <ProgressRing
        progress={props.t.has_metadata ? props.t.progress : 0}
        class={toneStroke[look().tone]}
      />
      <Show
        when={props.compact}
        fallback={
          <>
            <Name t={props.t} label={look().label} />
            <div class="text-right mono text-sm text-muted-foreground">
              {props.t.has_metadata ? formatBytes(props.t.size) : dash}
            </div>
            <div class="truncate text-right mono text-sm">
              <Rate t={props.t} />
            </div>
            <div class="text-right mono text-sm text-muted-foreground">
              {formatRatio(props.t.ratio)}
            </div>
            <div class="text-right mono text-sm text-muted-foreground">
              {props.t.complete ? "" : formatEta(props.t.eta)}
            </div>
            <div class="flex min-w-0 items-center gap-1.5 text-sm text-muted-foreground">
              <StatusDot class={categoryTone(props.t.category)} />
              <span class={cn("truncate", props.t.category === null && "text-subtle")}>
                {props.t.category ?? "none"}
              </span>
            </div>
          </>
        }
      >
        <div class="flex min-w-0 flex-col gap-0.5">
          <Name t={props.t} label={look().label} />
          <div class="flex min-w-0 items-center gap-2 mono text-xs text-muted-foreground">
            <span class="flex-none">
              {props.t.complete || !props.t.has_metadata
                ? look().label
                : formatPercent(props.t.progress, 1)}
            </span>
            <span class="min-w-0 truncate">
              <Show
                when={props.t.download_rate > 0 || props.t.upload_rate > 0}
                fallback={props.t.complete || !props.t.has_metadata ? "" : look().label}
              >
                <Rate t={props.t} />
              </Show>
            </span>
            <Show when={!props.t.complete && props.t.eta !== null}>
              <span class="flex-none">{formatEta(props.t.eta)}</span>
            </Show>
            <span class="flex-1" />
            <span class="flex-none">{props.t.has_metadata ? formatBytes(props.t.size) : dash}</span>
          </div>
        </div>
      </Show>
    </div>
  );
}

function Name(props: { t: TorrentSummary; label: string }) {
  const tags = () => tagSummary(props.t.tags);
  return (
    <div class="flex min-w-0 items-center gap-2">
      <span class="truncate font-medium">{props.t.name}</span>
      <span class="sr-only">, {props.label}</span>
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
  /** Every row shows its box (several are chosen). */
  checkboxes: boolean;
  /** A phone's two-line rows. */
  compact: boolean;
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
    estimateSize: (i) =>
      props.items[i]?.kind === "group" ? GROUP : props.compact ? ROW_COMPACT : ROW,
    getItemKey: (i) => {
      const item = props.items[i];
      if (!item) return i;
      return item.kind === "group" ? `group:${item.group.key}` : item.hash;
    },
    overscan: 12,
  });
  // Rows change kind (a torrent moves between groups) or height (the
  // viewport became a phone's): measure again.
  createEffect(
    on(
      () => [props.items, props.compact],
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

  // One scroller for good: the virtualizer watches it from the start, and
  // an empty list (a search) shows its message inside it.
  return (
    <div ref={scroller} class="relative flex min-h-0 flex-1 flex-col overflow-auto">
      <Show when={props.items.length > 0} fallback={props.empty}>
        <div
          class="relative w-full flex-none outline-none focus-visible:shadow-[inset_0_0_0_1px_var(--ring)]"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
          role="listbox"
          aria-label="Torrents"
          aria-multiselectable="true"
          aria-activedescendant={props.focus ? `row-${props.focus}` : undefined}
          tabindex="0"
          onKeyDown={(e) => props.onKey(e)}
        >
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
                          checkboxes={props.checkboxes}
                          compact={props.compact}
                          onToggle={() => props.onSelect(t().hash, "toggle")}
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
      </Show>
    </div>
  );
}
