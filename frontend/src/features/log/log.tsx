// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Log screen, as the design has it: the daemon's main log newest first
// by day, filtered by level and topic (the sidebar, in the URL) and by text
// (a regular expression), followed live or paused, exported as text; and
// one entry with its torrent, how often it came, the last day by hour and
// what recurs today. Every message is the daemon's, shown as text.

import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { createVirtualizer } from "@tanstack/solid-virtual";
import Copy from "lucide-solid/icons/copy";
import Download from "lucide-solid/icons/download";
import Search from "lucide-solid/icons/search";
import { createEffect, createMemo, createSignal, For, type JSX, on, Show } from "solid-js";
import { toast } from "solid-sonner";

import type { Schemas } from "~/api/client";
import { StatusDot } from "~/components/status-dot";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import { actions } from "~/features/torrents/actions";
import { useLive } from "~/features/shell/live";
import { PageHeader } from "~/features/shell/page-header";
import { formatCount, formatFullDateTime, formatTime } from "~/lib/format";
import { useWide } from "~/lib/use-wide";
import { cn } from "~/lib/utils";

import { LEVEL_DOTS, type LogParams } from "./sidebar";
import { useMainLog } from "./use-log";
import {
  byDay,
  exportText,
  filterEntries,
  foldRepeats,
  isLevel,
  isTopic,
  LEVEL_LABELS,
  perHour,
  recurring,
  type Row,
  sameMessage,
  TOPIC_LABELS,
} from "./view";

type Entry = Schemas["LogEntry"];
type Level = Schemas["LogLevel"];

const GLYPHS: Record<Level, string> = { info: "i", warning: "!", error: "×" };
const GLYPH_TONES: Record<Level, string> = {
  info: "bg-border-strong text-foreground-2",
  warning: "bg-warn text-background",
  error: "bg-danger text-background",
};

function Glyph(props: { level: Level; class?: string }) {
  return (
    <span
      class={cn(
        "inline-flex size-3.5 flex-none items-center justify-center rounded-[3px] font-sans text-[9px] font-bold",
        GLYPH_TONES[props.level],
        props.class,
      )}
    >
      <span aria-hidden="true">{GLYPHS[props.level]}</span>
      <span class="sr-only">{LEVEL_LABELS[props.level]}</span>
    </span>
  );
}

type Item = { kind: "day"; label: string; count: number } | { kind: "row"; row: Row };

function LogList(props: {
  items: readonly Item[];
  selected: number | null;
  onSelect: (e: Entry) => void;
  footer: JSX.Element;
  empty: JSX.Element;
}) {
  let scroller: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer({
    get count() {
      return props.items.length;
    },
    getScrollElement: () => scroller ?? null,
    estimateSize: (i) => (props.items[i]?.kind === "day" ? 28 : 29),
    getItemKey: (i) => {
      const it = props.items[i];
      return it?.kind === "row" ? it.row.entry.id : `day:${it?.label ?? i}`;
    },
    overscan: 16,
  });
  // Rows keep their measured heights: an element is one entry (below), so
  // nothing is measured again when entries arrive (`measure()` would drop
  // every height).
  return (
    <div ref={scroller} class="relative min-h-0 flex-1 overflow-auto">
      <Show when={props.items.length > 0} fallback={props.empty}>
        <div
          role="list"
          aria-label="Main log"
          class="relative w-full"
          style={{ height: `${virtualizer.getTotalSize()}px` }}
        >
          {/* One element per entry (not per position): each keeps its measured height. */}
          <For each={virtualizer.getVirtualItems().map((v) => v.key)}>
            {(key) => {
              const v = () => virtualizer.getVirtualItems().find((x) => x.key === key);
              const item = () => props.items[v()?.index ?? -1];
              return (
                <div
                  data-index={v()?.index}
                  ref={(el) => queueMicrotask(() => virtualizer.measureElement(el))}
                  class="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${v()?.start ?? 0}px)` }}
                  role="listitem"
                >
                  <Show
                    when={(() => {
                      const it = item();
                      return it?.kind === "row" ? it.row : null;
                    })()}
                    fallback={
                      <div class="flex h-7 items-center gap-2 border-y border-divider bg-card px-4 text-xs font-medium text-muted-foreground">
                        {(() => {
                          const it = item();
                          return it?.kind === "day" ? it.label : "";
                        })()}
                        <span class="mono font-normal text-subtle">
                          {(() => {
                            const it = item();
                            return it?.kind === "day" ? it.count : "";
                          })()}
                        </span>
                      </div>
                    }
                  >
                    {(r) => (
                      <button
                        type="button"
                        aria-current={props.selected === r().entry.id ? "true" : undefined}
                        class={cn(
                          "grid w-full grid-cols-[64px_16px_minmax(0,1fr)_44px] items-start gap-2.5 border-b border-muted px-4 py-[5px] text-left mono text-sm leading-normal",
                          props.selected === r().entry.id ? "bg-accent" : "hover:bg-muted",
                        )}
                        onClick={() => props.onSelect(r().entry)}
                      >
                        <span class="text-subtle">{formatTime(r().entry.time)}</span>
                        <Glyph level={r().entry.level} class="mt-0.5" />
                        <span
                          class={cn(
                            "break-words whitespace-pre-wrap",
                            r().entry.level === "info" ? "text-foreground-2" : "text-foreground",
                          )}
                        >
                          {r().entry.message}
                        </span>
                        <span class="text-right text-subtle">
                          <Show when={r().count > 1}>
                            <span class="sr-only">repeated </span>×{r().count}
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
        {props.footer}
      </Show>
    </div>
  );
}

function Prop(props: { label: string; children: JSX.Element }) {
  return (
    <div class="grid min-h-7 grid-cols-[110px_minmax(0,1fr)] items-center gap-3 text-sm">
      <span class="text-subtle">{props.label}</span>
      <span class="flex min-w-0 items-center gap-1.5">{props.children}</span>
    </div>
  );
}

function Heading(props: { children: JSX.Element; aside?: JSX.Element }) {
  return (
    <div class="flex items-center justify-between gap-3">
      <h3 class="m-0 text-xs font-medium tracking-[0.04em] text-subtle uppercase">
        {props.children}
      </h3>
      {props.aside}
    </div>
  );
}

function LastDay(props: { entries: readonly Entry[]; now: number }) {
  const hours = createMemo(() => perHour(props.entries, props.now));
  const top = () => Math.max(1, ...hours().map((h) => h.info + h.warning + h.error));
  const scale = (n: number) => (n / top()) * 58;
  const label = () => {
    const total = hours().reduce(
      (a, h) => ({
        info: a.info + h.info,
        warning: a.warning + h.warning,
        error: a.error + h.error,
      }),
      { info: 0, warning: 0, error: 0 },
    );
    return `Last 24 hours: ${total.info} info, ${total.warning} warnings, ${total.error} errors`;
  };
  return (
    <div class="flex flex-col gap-2">
      <Heading
        aside={
          <span class="flex gap-2.5 text-xs text-muted-foreground">
            <For each={["info", "warning", "error"] as const}>
              {(l) => (
                <span class="flex items-center gap-1">
                  <StatusDot class={LEVEL_DOTS[l]} />
                  {l}
                </span>
              )}
            </For>
          </span>
        }
      >
        Last 24 hours
      </Heading>
      <svg viewBox="0 0 388 80" class="block h-auto w-full" role="img" aria-label={label()}>
        <line x1="0" x2="388" y1="66" y2="66" class="stroke-border" />
        <For each={hours()}>
          {(h, i) => {
            const x = () => i() * 16 + 2;
            const ih = () => scale(h.info);
            const wh = () => scale(h.warning);
            const eh = () => scale(h.error);
            return (
              <g>
                <rect x={x()} y={66 - ih()} width="12" height={ih()} class="fill-border-strong" />
                <rect x={x()} y={66 - ih() - wh()} width="12" height={wh()} class="fill-warn" />
                <rect
                  x={x()}
                  y={66 - ih() - wh() - eh()}
                  width="12"
                  height={eh()}
                  class="fill-danger"
                />
              </g>
            );
          }}
        </For>
        <g class="fill-faint mono" font-size="9">
          <text x="0" y="78">
            {hours()[0] ? formatTime(hours()[0]?.start ?? 0).slice(0, 5) : ""}
          </text>
          <text x="194" y="78" text-anchor="middle">
            {hours()[12] ? formatTime(hours()[12]?.start ?? 0).slice(0, 5) : ""}
          </text>
          <text x="388" y="78" text-anchor="end">
            now
          </text>
        </g>
      </svg>
    </div>
  );
}

function EntryPanel(props: {
  entry: Entry | null;
  entries: readonly Entry[];
  now: number;
  onFilter: (message: string) => void;
}) {
  const live = useLive();
  const navigate = useNavigate();
  const torrent = () => {
    const h = props.entry?.torrent;
    return h ? (live.state.torrents[h] ?? null) : null;
  };
  const same = () => (props.entry ? sameMessage(props.entries, props.entry, props.now) : null);
  const again = createMemo(() => recurring(props.entries, props.now));
  const copy = async () => {
    const e = props.entry;
    if (!e) return;
    try {
      await navigator.clipboard.writeText(
        `${formatFullDateTime(e.time)} ${e.level} ${TOPIC_LABELS[e.topic]}: ${e.message}`,
      );
      toast.success("Entry copied");
    } catch {
      toast.error("The browser did not allow copying.");
    }
  };
  return (
    <div class="flex h-full min-h-0 flex-col bg-card">
      <div class="flex h-12 flex-none items-center gap-1 border-b border-divider pr-3 pl-4">
        <span class="min-w-0 flex-1 truncate mono text-sm text-subtle">
          {props.entry ? `entry #${props.entry.id}` : "Main log"}
        </span>
        <Show when={props.entry}>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Copy the entry"
            onClick={() => void copy()}
          >
            <Copy />
          </Button>
        </Show>
      </div>
      <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
        <Show
          when={props.entry}
          fallback={
            <p class="m-0 text-sm text-subtle">
              Choose an entry to see what it is about and how often it came.
            </p>
          }
        >
          {(e) => (
            <>
              <div class="flex flex-col gap-2.5">
                <div class="flex items-center gap-2">
                  <span class="inline-flex h-[22px] items-center gap-1.5 rounded-md border border-border bg-muted px-2 text-sm font-medium">
                    <StatusDot class={LEVEL_DOTS[e().level]} />
                    {LEVEL_LABELS[e().level]}
                  </span>
                  <span class="mono text-sm text-muted-foreground">
                    {formatFullDateTime(e().time)}
                  </span>
                </div>
                <div
                  class="rounded-lg border border-divider bg-background p-3 mono text-base leading-normal break-words whitespace-pre-wrap"
                  tabIndex={0}
                  aria-label="Message"
                >
                  {e().message}
                </div>
                <Show when={torrent()}>
                  {(t) => (
                    <div class="flex gap-2">
                      <Button
                        variant="outline"
                        class="flex-1"
                        onClick={() => navigate(`/torrents/${t().hash}`)}
                      >
                        Open torrent
                      </Button>
                      <Show when={e().topic === "trackers" || e().topic === "torrents"}>
                        <Button
                          variant="outline"
                          class="flex-1"
                          onClick={() => void actions.reannounce([t().hash])}
                        >
                          Reannounce
                        </Button>
                      </Show>
                    </div>
                  )}
                </Show>
              </div>
              <div class="flex flex-col">
                <Heading>Context</Heading>
                <div class="mt-1.5 flex flex-col">
                  <Prop label="About">{TOPIC_LABELS[e().topic]}</Prop>
                  <Show when={e().torrent}>
                    {(h) => (
                      <Prop label="Torrent">
                        <Show
                          when={torrent()}
                          fallback={
                            <span class="truncate text-subtle">
                              not in the session · <span class="mono">{h().slice(0, 12)}…</span>
                            </span>
                          }
                        >
                          {(t) => (
                            <A href={`/torrents/${t().hash}`} class="truncate hover:underline">
                              {t().name}
                            </A>
                          )}
                        </Show>
                      </Prop>
                    )}
                  </Show>
                  <Prop label="Same message">
                    {(same()?.lastDay ?? 1) > 1
                      ? `${same()?.lastDay} times in the last day`
                      : "once in the last day"}
                    <Show when={(same()?.lastDay ?? 1) > 1}>
                      <button
                        type="button"
                        class="text-subtle underline-offset-2 hover:text-foreground hover:underline"
                        onClick={() => props.onFilter(e().message)}
                      >
                        show them
                      </button>
                    </Show>
                  </Prop>
                  <Prop label="First seen">
                    <span class="mono">{formatFullDateTime(same()?.first ?? e().time)}</span>
                  </Prop>
                </div>
              </div>
            </>
          )}
        </Show>
        <LastDay entries={props.entries} now={props.now} />
        <div class="flex flex-col gap-1.5">
          <Heading>Recurring today</Heading>
          <Show
            when={again().length > 0}
            fallback={<p class="m-0 text-sm text-subtle">Nothing came twice today.</p>}
          >
            <ul class="m-0 flex list-none flex-col p-0">
              <For each={again()}>
                {(r) => (
                  <li class="grid h-7 grid-cols-[minmax(0,1fr)_40px] items-center gap-2 text-sm">
                    <button
                      type="button"
                      class="flex min-w-0 items-center gap-2 text-left hover:text-foreground"
                      title={r.message}
                      onClick={() => props.onFilter(r.message)}
                    >
                      <Glyph level={r.level} />
                      <span class="truncate mono text-xs text-muted-foreground">{r.message}</span>
                    </button>
                    <span class="text-right mono text-xs text-subtle">×{r.count}</span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>
      </div>
    </div>
  );
}

/** A regular expression that matches exactly this text. */
const literally = (text: string) => `^${text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;

export default function Log() {
  const [params, setParams] = useSearchParams<LogParams>();
  const log = useMainLog();
  const wide = useWide();
  const [selected, setSelected] = createSignal<number | null>(null);
  /** While paused, the last entry shown; `null` = following. */
  const [paused, setPaused] = createSignal<number | null>(null);
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));
  createEffect(
    on(
      () => log.data,
      () => setNow(Math.floor(Date.now() / 1000)),
    ),
  );

  const all = () => log.data ?? [];
  const shown = createMemo(() => {
    const p = paused();
    return p === null ? all() : all().filter((e) => e.id <= p);
  });
  const waiting = () => {
    const p = paused();
    return p === null ? 0 : all().filter((e) => e.id > p).length;
  };
  const filter = () => ({
    level: isLevel(params.level) ? params.level : null,
    topic: isTopic(params.topic) ? params.topic : null,
    text: params.q ?? "",
  });
  const filtered = createMemo(() => filterEntries(shown(), filter()));
  const items = createMemo<Item[]>(() =>
    byDay(foldRepeats(filtered()), now()).flatMap((g) => [
      { kind: "day" as const, label: g.label, count: g.rows.length },
      ...g.rows.map((row) => ({ kind: "row" as const, row })),
    ]),
  );
  const entry = () => {
    const id = selected();
    return id === null ? null : (all().find((e) => e.id === id) ?? null);
  };
  const lastId = () => all().at(-1)?.id;

  const select = (e: Entry) => {
    setSelected(e.id);
    // Reading one entry holds the view still.
    if (paused() === null) setPaused(lastId() ?? null);
  };
  const follow = () => {
    if (paused() === null) setPaused(lastId() ?? null);
    else setPaused(null);
  };
  const exportLog = () => {
    const blob = new Blob([exportText(filtered())], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    a.href = url;
    a.download = `urtorrentd-log-${stamp}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const panel = () => (
    <EntryPanel
      entry={entry()}
      entries={all()}
      now={now()}
      onFilter={(m) => setParams({ q: literally(m) })}
    />
  );

  return (
    <div class="flex min-w-0 flex-1">
      <main class="flex min-w-0 flex-1 flex-col border-r border-divider">
        <PageHeader
          title="Main log"
          count={
            <span class="mono text-xs text-subtle">
              {formatCount(filtered().length)} of {formatCount(shown().length)}
            </span>
          }
        >
          <label class="hidden h-7 w-60 items-center gap-1.5 rounded-md border border-border px-2 focus-within:border-ring focus-within:shadow-focus md:flex">
            <Search size={13} class="flex-none text-subtle" />
            <input
              class="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle"
              placeholder="Filter messages… (regex ok)"
              aria-label="Filter messages"
              value={params.q ?? ""}
              spellcheck={false}
              onInput={(e) =>
                setParams({ q: e.currentTarget.value || undefined }, { replace: true })
              }
            />
          </label>
          <Button
            variant="outline"
            size="sm"
            aria-pressed={paused() === null}
            class={cn(paused() === null && "border-border-strong bg-accent text-foreground")}
            onClick={follow}
          >
            <StatusDot
              class={cn(paused() === null ? "bg-ok motion-safe:animate-pulse" : "bg-faint")}
            />
            {paused() === null ? "Following" : "Follow"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={exportLog}
            disabled={filtered().length === 0}
          >
            <Download />
            Export
          </Button>
        </PageHeader>
        <LogList
          items={items()}
          selected={selected()}
          onSelect={select}
          empty={
            <p class="m-0 p-4 text-sm text-subtle">
              {log.isLoading
                ? "Reading the log…"
                : shown().length === 0
                  ? "The log is empty."
                  : "No entry matches."}
            </p>
          }
          footer={
            <div class="flex items-center gap-2 px-4 py-2.5 mono text-xs text-subtle" role="status">
              <Show
                when={paused() === null}
                fallback={
                  <>
                    <StatusDot class="bg-faint" />
                    paused ·{" "}
                    {waiting() === 1 ? "1 new entry" : `${formatCount(waiting())} new entries`}
                    <button type="button" class="underline underline-offset-2" onClick={follow}>
                      follow
                    </button>
                  </>
                }
              >
                <StatusDot class="bg-faint motion-safe:animate-pulse" />
                waiting for new entries · GET /log?after={lastId() ?? 0}
              </Show>
            </div>
          }
        />
      </main>
      <Show when={wide()}>
        <aside class="flex w-[420px] flex-none flex-col" aria-label="Log entry">
          {panel()}
        </aside>
      </Show>
      <Sheet open={!wide() && selected() !== null} onOpenChange={(o) => !o && setSelected(null)}>
        <SheetContent position="right" class="w-full max-w-[420px] p-0">
          <SheetTitle class="sr-only">Log entry</SheetTitle>
          {panel()}
        </SheetContent>
      </Sheet>
    </div>
  );
}
