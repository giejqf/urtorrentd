// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Stats › Timeline as designed: what happened to torrents (`/stats/timeline`,
// every event kept), shown by kind, as one lane per torrent over the range
// and as a feed by day; beside it what needs attention now (the live
// store and the trackers failing) and the range in numbers. Exported as CSV.

import { A, useSearchParams } from "@solidjs/router";
import { createVirtualizer } from "@tanstack/solid-virtual";
import Download from "lucide-solid/icons/download";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { ApiError, type Schemas } from "~/api/client";
import { Button } from "~/components/ui/button";
import { useStatsInfo } from "~/features/settings/app-info";
import { Segmented } from "~/features/settings/controls";
import { useLive } from "~/features/shell/live";
import { PageHeader } from "~/features/shell/page-header";
import { actions } from "~/features/torrents/actions";
import { DeleteDialog } from "~/features/torrents/delete-dialog";
import {
  formatAgo,
  formatClock,
  formatCount,
  formatDate,
  formatDuration,
  formatShortDate,
} from "~/lib/format";
import { errorKindLabel } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { tickLabel } from "./chart";
import { useAllTimeline, useMinuteClock, useTrackerHosts } from "./data";
import { Card, download, Empty, fileStamp, TorrentPicker } from "./parts";
import { type RangeParams, rangeOf, TIMELINE_PRESETS } from "./range";
import {
  attention,
  contexts,
  describe,
  feedRows,
  hiddenKinds,
  KIND_OF,
  kindCounts,
  KINDS,
  type LaneState,
  lanes,
  medianDownload,
  timelineCsv,
} from "./timeline-view";

type Ev = Schemas["TimelineEvent"];

interface TimelineParams extends RangeParams {
  hash?: string;
  hide?: string;
}

const LANE_FILL: Record<LaneState, string> = {
  downloading: "var(--brand)",
  seeding: "var(--ok)",
  metadata: "var(--warn)",
  stopped: "var(--border-strong)",
  error: "var(--danger)",
  unknown: "var(--border)",
};

export default function Timeline() {
  const [params, setParams] = useSearchParams<TimelineParams>();
  const now = useMinuteClock();
  const info = useStatsInfo();
  const q = useAllTimeline();
  const live = useLive();
  const all = () => q.data ?? [];
  const oldest = () => {
    const list = all();
    return list.length > 0 ? (list[list.length - 1]?.t ?? null) : null;
  };
  const range = createMemo(() => rangeOf(params, TIMELINE_PRESETS, "30d", now(), oldest()));
  const scope = () => params.hash ?? null;
  const scoped = createMemo(() => {
    const h = scope();
    return h ? all().filter((e) => e.hash === h) : all();
  });
  const inRange = createMemo(() =>
    scoped().filter((e) => e.t >= range().from && e.t <= range().to),
  );
  const hidden = () => hiddenKinds(params.hide);
  const shown = createMemo(() => inRange().filter((e) => !hidden().has(e.kind)));
  const counts = createMemo(() => kindCounts(inRange()));
  const toggleKind = (k: Schemas["TimelineKind"]) => {
    const next = new Set(hidden());
    if (next.has(k)) next.delete(k);
    else next.add(k);
    setParams({ hide: next.size > 0 ? [...next].join(",") : undefined });
  };
  const torrents = createMemo(() => {
    const seen = new Map<string, { hash: string; name: string; n: number }>();
    for (const e of all()) {
      const t = seen.get(e.hash) ?? { hash: e.hash, name: e.name ?? e.hash.slice(0, 12), n: 0 };
      t.n += 1;
      seen.set(e.hash, t);
    }
    return [...seen.values()].map((t) => ({
      hash: t.hash,
      name: t.name,
      meta: `${t.n} ${t.n === 1 ? "event" : "events"}`,
    }));
  });
  const unavailable = () => info.error instanceof ApiError && info.error.status === 503;
  const exportCsv = () =>
    download(`urtorrentd-timeline-${fileStamp()}.csv`, timelineCsv(shown()), "text/csv");
  return (
    <div class="flex min-w-0 flex-1 flex-col">
      <PageHeader
        title="Timeline"
        count={
          <span class="mono text-xs text-subtle">
            {formatCount(shown().length)} of {formatCount(inRange().length)} events
          </span>
        }
      >
        <TorrentPicker
          options={torrents()}
          value={scope()}
          onChange={(h) => setParams({ hash: h ?? undefined })}
        />
        <Segmented
          label="Range"
          options={TIMELINE_PRESETS}
          value={range().preset ?? "30d"}
          onChange={(v) =>
            setParams({ range: v === "30d" ? undefined : v, from: undefined, to: undefined })
          }
        />
        <Button variant="outline" size="sm" disabled={shown().length === 0} onClick={exportCsv}>
          <Download />
          Export
        </Button>
      </PageHeader>
      <div class="flex h-11 flex-none items-center gap-1.5 overflow-x-auto border-b border-divider px-4">
        <span class="mr-1 text-sm text-subtle">Show</span>
        <For each={KINDS}>
          {(k) => {
            const on = () => !hidden().has(k.kind);
            return (
              <button
                type="button"
                aria-pressed={on()}
                class={cn(
                  "flex h-[26px] flex-none items-center gap-1.5 rounded-full border px-2.5 text-sm font-medium whitespace-nowrap transition-colors",
                  on()
                    ? "border-border-strong bg-accent text-foreground"
                    : "border-border text-muted-foreground hover:text-foreground",
                )}
                onClick={() => toggleKind(k.kind)}
              >
                <Glyph kind={k.kind} size="sm" />
                {k.label}
                <span class="mono text-xs text-subtle">{counts()[k.kind]}</span>
              </button>
            );
          }}
        </For>
        <span class="flex-1" />
        <span class="flex-none text-sm whitespace-nowrap text-subtle">
          {formatShortDate(range().from)} – {formatDate(range().to)}
        </span>
      </div>
      <Show
        when={!unavailable()}
        fallback={
          <Empty>
            Statistics are unavailable: the daemon could not open its statistics database. The log
            says why.
          </Empty>
        }
      >
        <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
          <Lanes
            events={scoped()}
            from={range().from}
            to={range().to}
            hidden={hidden()}
            current={(h) => live.state.torrents[h]?.state ?? null}
          />
          <div class="grid min-h-[480px] flex-1 gap-4 xl:grid-cols-[minmax(0,1fr)_320px]">
            <Feed events={shown()} all={scoped()} now={now()} />
            <div class="flex min-h-0 flex-col gap-4">
              <Attention now={now()} />
              <Summary
                events={inRange()}
                counts={counts()}
                from={range().from}
                to={range().to}
                words={range().words}
              />
            </div>
          </div>
        </div>
      </Show>
      <Show when={q.isError && !unavailable()}>
        <Empty>The timeline could not be read.</Empty>
      </Show>
    </div>
  );
}

function Glyph(props: { kind: Schemas["TimelineKind"]; size?: "sm" | "md" }) {
  const k = () => KIND_OF[props.kind];
  return (
    <span
      class={cn(
        "inline-flex flex-none items-center justify-center rounded-full mono font-semibold text-background",
        props.size === "sm" ? "size-3.5 text-[10px]" : "size-[22px] text-xs",
        k().tone,
      )}
      aria-hidden="true"
    >
      {k().glyph}
    </span>
  );
}

function Lanes(props: {
  events: readonly Ev[];
  from: number;
  to: number;
  hidden: ReadonlySet<Schemas["TimelineKind"]>;
  current: (hash: string) => Schemas["TorrentState"] | null;
}) {
  let box!: HTMLDivElement;
  const [width, setWidth] = createSignal(1100);
  onMount(() => {
    const ro = new ResizeObserver(() => setWidth(Math.max(480, box.clientWidth)));
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });
  const list = createMemo(() => lanes(props.events, props.from, props.to, props.current));
  const NAME = 230;
  const ROW = 22;
  const TOP = 22;
  const x = (t: number) =>
    NAME +
    ((Math.min(Math.max(t, props.from), props.to) - props.from) / (props.to - props.from)) *
      (width() - NAME - 12);
  const ticks = createMemo(() => {
    const span = props.to - props.from;
    const step =
      span <= 2 * 86_400
        ? 6 * 3600
        : span <= 10 * 86_400
          ? 86_400
          : span <= 45 * 86_400
            ? 7 * 86_400
            : 30 * 86_400;
    const out: number[] = [];
    for (let t = Math.ceil(props.from / step) * step; t < props.to; t += step) out.push(t);
    return out;
  });
  const height = () => TOP + list().length * ROW + 6;
  return (
    <Card
      class="max-sm:hidden"
      title="Lifecycles"
      sub="One lane per torrent that changed in the range: its state between events, the events on the lane"
      actions={
        <ul class="m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0 text-xs text-muted-foreground">
          <For
            each={[
              ["downloading", "var(--brand)"],
              ["seeding", "var(--ok)"],
              ["fetching metadata", "var(--warn)"],
              ["stopped, queued", "var(--border-strong)"],
            ]}
          >
            {([label, fill]) => (
              <li class="flex items-center gap-1.5">
                <span
                  class="h-1.5 w-3.5 rounded-xs"
                  style={{ background: fill }}
                  aria-hidden="true"
                />
                {label}
              </li>
            )}
          </For>
          <li class="flex items-center gap-1.5">
            <span
              class="h-1.5 w-3.5 rounded-xs bg-[repeating-linear-gradient(90deg,var(--faint)_0_3px,transparent_3px_6px)]"
              aria-hidden="true"
            />
            before the range, or not known
          </li>
        </ul>
      }
    >
      <div ref={box} class="w-full">
        <Show when={list().length > 0} fallback={<Empty>Nothing happened in this range.</Empty>}>
          <svg
            width={width()}
            height={height()}
            viewBox={`0 0 ${width()} ${height()}`}
            class="block overflow-visible"
            role="img"
            aria-label={`${list().length} torrents' lifecycles`}
          >
            <For each={ticks()}>
              {(t) => (
                <g>
                  <line x1={x(t)} x2={x(t)} y1={16} y2={height()} stroke="var(--divider)" />
                  <text
                    x={x(t)}
                    y={11}
                    font-size="10"
                    fill="var(--subtle)"
                    text-anchor="middle"
                    class="mono"
                  >
                    {tickLabel(t)}
                  </text>
                </g>
              )}
            </For>
            <line
              x1={x(props.to)}
              x2={x(props.to)}
              y1={16}
              y2={height()}
              stroke="var(--foreground)"
              stroke-opacity="0.5"
              stroke-dasharray="2 3"
            />
            <For each={list()}>
              {(l, i) => {
                const cy = () => TOP + i() * ROW + ROW / 2;
                const start = () => l.segments[0]?.from ?? props.to;
                return (
                  <g>
                    <text x={0} y={cy() + 4} font-size="11" fill="var(--foreground-2)">
                      <title>{l.name}</title>
                      {l.name.length > 32 ? `${l.name.slice(0, 31)}…` : l.name}
                    </text>
                    <Show when={l.before && start() > props.from}>
                      <line
                        x1={x(props.from)}
                        x2={x(start())}
                        y1={cy()}
                        y2={cy()}
                        stroke="var(--faint)"
                        stroke-width="2"
                        stroke-dasharray="3 4"
                      />
                    </Show>
                    <For each={l.segments}>
                      {(s) => (
                        <Show
                          when={s.state !== "unknown"}
                          fallback={
                            <line
                              x1={x(s.from)}
                              x2={x(s.to)}
                              y1={cy()}
                              y2={cy()}
                              stroke="var(--faint)"
                              stroke-width="2"
                              stroke-dasharray="3 4"
                            />
                          }
                        >
                          <rect
                            x={x(s.from)}
                            y={cy() - 3}
                            width={Math.max(2, x(s.to) - x(s.from))}
                            height="6"
                            rx="3"
                            fill={LANE_FILL[s.state]}
                          />
                        </Show>
                      )}
                    </For>
                    <For each={l.marks.filter((m) => !props.hidden.has(m.kind))}>
                      {(m) => (
                        <g>
                          <title>
                            {KIND_OF[m.kind].label} · {formatShortDate(m.t)} {formatClock(m.t)}
                          </title>
                          <circle
                            cx={x(m.t)}
                            cy={cy()}
                            r="7"
                            class={KIND_OF[m.kind].fill}
                            stroke="var(--card)"
                            stroke-width="2"
                          />
                          <text
                            x={x(m.t)}
                            y={cy() + 3}
                            font-size="9"
                            font-weight="700"
                            fill="var(--background)"
                            text-anchor="middle"
                            class="mono"
                          >
                            {KIND_OF[m.kind].glyph}
                          </text>
                        </g>
                      )}
                    </For>
                  </g>
                );
              }}
            </For>
          </svg>
        </Show>
      </div>
    </Card>
  );
}

function Feed(props: { events: readonly Ev[]; all: readonly Ev[]; now: number }) {
  const live = useLive();
  const rows = createMemo(() => feedRows(props.events, props.now));
  const context = createMemo(() => contexts(props.all));
  let scroller: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer({
    get count() {
      return rows().length;
    },
    getScrollElement: () => scroller ?? null,
    estimateSize: (i) => (rows()[i]?.kind === "day" ? 34 : 50),
    getItemKey: (i) => rows()[i]?.key ?? i,
    overscan: 12,
  });
  const inError = (hash: string) => live.state.torrents[hash]?.state === "error";
  return (
    <section
      aria-label="Events"
      class="flex min-h-[420px] min-w-0 flex-col overflow-hidden rounded-xl border border-divider bg-card"
    >
      <div ref={scroller} class="relative min-h-0 flex-1 overflow-auto">
        <Show when={rows().length > 0} fallback={<Empty>No event in this range.</Empty>}>
          <div
            role="list"
            aria-label="Events"
            class="relative w-full"
            style={{ height: `${virtualizer.getTotalSize()}px` }}
          >
            <For each={virtualizer.getVirtualItems().map((v) => v.key)}>
              {(key) => {
                const v = () => virtualizer.getVirtualItems().find((x) => x.key === key);
                const row = () => rows()[v()?.index ?? -1];
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
                        const r = row();
                        return r?.kind === "event" ? r.event : null;
                      })()}
                      fallback={
                        <div class="flex h-[34px] items-center gap-2.5 border-y border-divider bg-card px-4 text-sm font-medium text-foreground-2">
                          {(() => {
                            const r = row();
                            return r?.kind === "day" ? r.label : "";
                          })()}
                          <span class="mono text-xs font-normal text-subtle">
                            {(() => {
                              const r = row();
                              return r?.kind === "day" ? r.count : "";
                            })()}
                          </span>
                        </div>
                      }
                    >
                      {(e) => {
                        const c = () => context().get(e()) ?? { previous: null, added: null };
                        const d = () => describe(e(), c().previous, c().added);
                        const cat = () => live.state.torrents[e().hash]?.category ?? null;
                        return (
                          <div class="grid min-h-11 grid-cols-[52px_22px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-row-divider px-4 py-1.5 text-sm hover:bg-muted">
                            <span class="mono text-xs text-subtle" title={formatDate(e().t)}>
                              {formatClock(e().t)}
                            </span>
                            <Glyph kind={e().kind} />
                            <span class="flex min-w-0 flex-col gap-0.5">
                              <span class="truncate">
                                <Show
                                  when={live.state.torrents[e().hash]}
                                  fallback={
                                    <span class="font-medium">
                                      {e().name ?? e().hash.slice(0, 12)}
                                    </span>
                                  }
                                >
                                  <A
                                    href={`/torrents/${e().hash}`}
                                    class="font-medium hover:underline"
                                  >
                                    {e().name ?? e().hash.slice(0, 12)}
                                  </A>
                                </Show>{" "}
                                <span class="text-muted-foreground">{d().verb}</span>{" "}
                                <span>{d().object}</span>
                              </span>
                              <Show when={d().detail}>
                                <span class="truncate text-xs text-subtle" title={d().detail}>
                                  {d().detail}
                                </span>
                              </Show>
                            </span>
                            <span class="flex items-center gap-1.5">
                              <Show when={cat()}>
                                <span class="rounded-sm border border-border px-1.5 mono text-[11px] text-muted-foreground">
                                  {cat()}
                                </span>
                              </Show>
                              <Show when={e().kind === "error" && inError(e().hash)}>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  class="h-6 px-2 text-xs"
                                  onClick={() => void actions.start([e().hash])}
                                >
                                  Start
                                </Button>
                              </Show>
                            </span>
                          </div>
                        );
                      }}
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </section>
  );
}

function Attention(props: { now: number }) {
  const live = useLive();
  const hosts = useTrackerHosts();
  const now = createMemo(() => attention(live.torrents(), props.now));
  const failing = () => (hosts.data ?? []).filter((h) => h.failing.length > 0);
  const count = () => now().errors.length + now().waiting.length + failing().length;
  const [removing, setRemoving] = createSignal<Schemas["TorrentSummary"] | null>(null);
  return (
    <Card title="Needs attention" actions={<span class="mono text-xs text-subtle">{count()}</span>}>
      <Show
        when={count() > 0}
        fallback={<p class="m-0 text-sm text-subtle">Nothing needs attention now.</p>}
      >
        <ul class="m-0 flex list-none flex-col gap-2.5 p-0">
          <For each={now().errors}>
            {(t) => (
              <li class="flex flex-col gap-1.5 rounded-lg border border-danger/30 bg-danger/6 p-2.5">
                <span class="flex items-center gap-2">
                  <Glyph kind="error" />
                  <A href={`/torrents/${t.hash}`} class="truncate font-medium hover:underline">
                    {t.name}
                  </A>
                </span>
                <span class="text-xs text-muted-foreground">
                  {errorKindLabel(t.error_kind)}
                  {t.error ? `: ${t.error}` : ""}
                </span>
                <span class="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    class="h-6 px-2 text-xs"
                    onClick={() => void actions.start([t.hash])}
                  >
                    Start
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    class="h-6 px-2 text-xs"
                    onClick={() => void actions.recheck([t.hash])}
                  >
                    Recheck
                  </Button>
                </span>
              </li>
            )}
          </For>
          <For each={now().waiting}>
            {(t) => (
              <li class="flex flex-col gap-1.5 rounded-lg border border-warn/30 bg-warn/6 p-2.5">
                <span class="flex items-center gap-2">
                  <Glyph kind="metadata" />
                  <A href={`/torrents/${t.hash}`} class="truncate font-medium hover:underline">
                    {t.name}
                  </A>
                </span>
                <span class="text-xs text-muted-foreground">
                  Waiting for its metadata for {formatDuration(props.now - t.added_on)} ·{" "}
                  {formatCount(t.peers)} {t.peers === 1 ? "peer" : "peers"} connected
                </span>
                <span class="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    class="h-6 px-2 text-xs"
                    onClick={() => setRemoving(t)}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            )}
          </For>
          <For each={failing()}>
            {(h) => (
              <li class="flex flex-col gap-1.5 rounded-lg border border-divider p-2.5">
                <span class="flex items-center gap-2">
                  <Glyph kind="error" />
                  <span class="truncate mono font-medium">{h.host}</span>
                </span>
                <span class="text-xs text-muted-foreground">
                  Tracker failing since {formatAgo(h.failing_since, props.now)} · {h.failing.length}{" "}
                  {h.failing.length === 1 ? "torrent" : "torrents"}
                </span>
                <span>
                  <A
                    href="/stats/trackers"
                    class="text-xs text-foreground underline decoration-border-strong underline-offset-2"
                  >
                    Trackers report
                  </A>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <DeleteDialog
        hashes={removing() ? [removing()?.hash ?? ""] : []}
        onClose={() => setRemoving(null)}
      />
    </Card>
  );
}

function Summary(props: {
  events: readonly Ev[];
  counts: Record<Schemas["TimelineKind"], number>;
  from: number;
  to: number;
  words: string;
}) {
  const most = () => Math.max(1, ...Object.values(props.counts));
  const median = createMemo(() => medianDownload(props.events, props.from, props.to));
  return (
    <Card
      title={props.words.charAt(0).toUpperCase() + props.words.slice(1)}
      actions={
        <span class="mono text-xs text-subtle">{formatCount(props.events.length)} events</span>
      }
    >
      <ul class="m-0 flex list-none flex-col gap-0.5 p-0">
        <For each={KINDS}>
          {(k) => (
            <li class="grid h-6 grid-cols-[18px_76px_minmax(0,1fr)_32px] items-center gap-2 text-sm">
              <Glyph kind={k.kind} size="sm" />
              <span class="text-muted-foreground">{k.label}</span>
              <span class="h-1.5 overflow-hidden rounded-xs bg-accent">
                <span
                  class={cn("block h-full", k.tone)}
                  style={{ width: `${(props.counts[k.kind] / most()) * 100}%` }}
                />
              </span>
              <span class="text-right mono text-muted-foreground">{props.counts[k.kind]}</span>
            </li>
          )}
        </For>
      </ul>
      <div class="flex flex-col border-t border-divider pt-2.5 text-xs">
        <span class="text-subtle">Added → finished</span>
        <span class="mono text-base">
          {median() === null ? "no download finished" : `median ${formatDuration(median() ?? 0)}`}
        </span>
      </div>
    </Card>
  );
}
