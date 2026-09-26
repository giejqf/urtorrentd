// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Stats › Idle seeds as designed: every complete torrent by what it
// uploaded in the window against its size (`/stats/idle-seeds`), what the
// idle ones occupy, a log-log picture of size against value, and a
// selection to stop, keep (the `keep` tag) or remove, with or without the
// files. Exported as CSV.

import { A, useSearchParams } from "@solidjs/router";
import Download from "lucide-solid/icons/download";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";

import { ApiError, type Schemas } from "~/api/client";
import { Button } from "~/components/ui/button";
import { Checkbox, CheckboxLabel } from "~/components/ui/checkbox";
import { useStatsInfo } from "~/features/settings/app-info";
import { Segmented } from "~/features/settings/controls";
import { useLive } from "~/features/shell/live";
import { PageHeader } from "~/features/shell/page-header";
import { actions } from "~/features/torrents/actions";
import { DeleteDialog } from "~/features/torrents/delete-dialog";
import {
  dash,
  formatAgo,
  formatBytes,
  formatCount,
  formatDays,
  formatPercent,
  formatRatio,
  formatShortDate,
} from "~/lib/format";
import { stateLook } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { useIdleSeeds, useMinuteClock } from "./data";
import {
  BIG,
  coverage,
  idleCsv,
  idleSummary,
  idleUnkept,
  KEEP,
  logScale,
  logTicks,
  sizeRange,
  valueClass,
  valueRange,
  windowOf,
  WINDOWS,
} from "./idle-view";
import { Amount, Card, download, Empty, fileStamp, Kpi } from "./parts";

type Seed = Schemas["IdleSeed"];

const CLASS_TEXT = { idle: "text-danger", low: "text-warn", earning: "text-ok" } as const;
const CLASS_FILL = { idle: "var(--danger)", low: "var(--warn)", earning: "var(--ok)" } as const;
const CLASS_DOT = { idle: "bg-danger", low: "bg-warn", earning: "bg-ok" } as const;

export default function IdleSeeds() {
  const [params, setParams] = useSearchParams<{ days?: string }>();
  const now = useMinuteClock();
  const days = () => Number(windowOf(params.days));
  const info = useStatsInfo();
  const q = useIdleSeeds(days, 1000);
  const live = useLive();
  const tagsOf = (h: string) => live.state.torrents[h]?.tags ?? [];
  const seeds = () => q.data?.torrents ?? [];
  const summary = createMemo(() => idleSummary(seeds()));
  const [chosen, setChosen] = createSignal<ReadonlySet<string>>(new Set());
  // Only torrents still listed stay chosen.
  const selected = createMemo(() => seeds().filter((s) => chosen().has(s.hash)));
  const toggle = (h: string) => {
    const next = new Set(chosen());
    if (next.has(h)) next.delete(h);
    else next.add(h);
    setChosen(next);
  };
  const [deleting, setDeleting] = createSignal<{ hashes: string[]; files: boolean } | null>(null);
  const unavailable = () => info.error instanceof ApiError && info.error.status === 503;
  const exportCsv = () =>
    download(
      `urtorrentd-idle-seeds-${days()}d-${fileStamp()}.csv`,
      idleCsv(seeds(), days()),
      "text/csv",
    );
  const cover = (): { value: string; sub: string } => {
    const d = q.data;
    const c = d ? coverage(d.from, d.recorded_from, now()) : { kind: "none" as const };
    const since = d?.recorded_from ? ` · recording since ${formatShortDate(d.recorded_from)}` : "";
    if (c.kind === "full") return { value: "full", sub: `window covered${since}` };
    if (c.kind === "partial")
      return { value: formatDays(c.seconds), sub: `of ${days()} days recorded${since}` };
    return { value: dash, sub: "nothing recorded yet" };
  };
  return (
    <div class="relative flex min-w-0 flex-1 flex-col">
      <PageHeader
        title="Idle seeds"
        count={
          <span class="mono text-xs text-subtle">
            {formatCount(seeds().length)} complete {seeds().length === 1 ? "torrent" : "torrents"} ·
            least valuable first
          </span>
        }
      >
        <span class="text-sm text-subtle">Window</span>
        <Segmented
          label="Window"
          options={WINDOWS}
          value={windowOf(params.days)}
          onChange={(v) => setParams({ days: v === "30" ? undefined : v })}
        />
        <Button variant="outline" size="sm" disabled={seeds().length === 0} onClick={exportCsv}>
          <Download />
          Export CSV
        </Button>
      </PageHeader>
      <Show
        when={!unavailable()}
        fallback={
          <Empty>
            Statistics are unavailable: the daemon could not open its statistics database. The log
            says why.
          </Empty>
        }
      >
        <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 pb-24">
          <div class="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
            <Kpi
              value={<Amount text={formatBytes(summary().size)} />}
              sub="on disk in complete torrents"
            />
            <Kpi
              value={formatCount(summary().idle.count)}
              tone={summary().idle.count > 0 ? "danger" : undefined}
              sub={`shared under 0.1× in ${days()} days`}
            />
            <Kpi
              value={<Amount text={formatBytes(summary().idle.size)} />}
              sub={
                summary().size > 0
                  ? `they occupy · ${formatPercent(summary().idle.size / summary().size)} of the total`
                  : "they occupy"
              }
            />
            <Kpi
              value={<Amount text={formatBytes(summary().others.uploaded)} />}
              sub={`uploaded by the other ${formatCount(summary().others.count)}`}
            />
            <Kpi value={cover().value} sub={<span class="truncate">{cover().sub}</span>} />
          </div>
          <Card
            title="Worth its space?"
            sub={`Size on disk against how many times over it was uploaded in the last ${days()} days · dot size = seeding time`}
            actions={
              <ul class="m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0 text-xs text-muted-foreground">
                <li class="flex items-center gap-1.5">
                  <span class="size-[7px] rounded-full bg-danger" aria-hidden="true" />
                  idle · under 0.1×
                </li>
                <li class="flex items-center gap-1.5">
                  <span class="size-[7px] rounded-full bg-warn" aria-hidden="true" />
                  low · under 1×
                </li>
                <li class="flex items-center gap-1.5">
                  <span class="size-[7px] rounded-full bg-ok" aria-hidden="true" />
                  earning its keep
                </li>
                <li class="flex items-center gap-1.5">
                  <span
                    class="h-2 w-3.5 border border-dashed border-danger/40 bg-danger/8"
                    aria-hidden="true"
                  />
                  big and idle
                </li>
              </ul>
            }
          >
            <Show when={seeds().length > 0} fallback={<Empty>No complete torrent yet.</Empty>}>
              <Scatter seeds={seeds()} chosen={chosen()} days={days()} onToggle={toggle} />
            </Show>
          </Card>
          <Card
            title="Least valuable first"
            sub={`Every complete torrent, what it uploaded in the last ${days()} days against its size`}
            flush
            actions={
              <>
                <Button
                  variant="outline"
                  size="sm"
                  title="Those under 0.1× that are not tagged keep"
                  onClick={() => setChosen(new Set(idleUnkept(seeds(), tagsOf).map((s) => s.hash)))}
                >
                  Select all under 0.1×
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={selected().length === 0}
                  onClick={() => setChosen(new Set<string>())}
                >
                  Clear
                </Button>
              </>
            }
          >
            <Show when={seeds().length > 0} fallback={<Empty>No complete torrent yet.</Empty>}>
              <Table
                seeds={seeds()}
                chosen={chosen()}
                days={days()}
                now={now()}
                onToggle={toggle}
              />
            </Show>
          </Card>
        </div>
      </Show>
      <Show when={selected().length > 0}>
        <div
          role="toolbar"
          aria-label="Selected torrents"
          class="absolute bottom-5 left-1/2 flex h-12 -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-accent/95 pr-2 pl-4 shadow-lg backdrop-blur"
        >
          <span class="font-medium whitespace-nowrap">{selected().length} selected</span>
          <span class="mono text-sm whitespace-nowrap text-muted-foreground">
            {formatBytes(selected().reduce((n, s) => n + s.size, 0))} on disk ·{" "}
            {formatBytes(selected().reduce((n, s) => n + s.uploaded, 0))} uploaded in {days()} d
          </span>
          <span class="h-5 w-px bg-border" aria-hidden="true" />
          <Button
            variant="ghost"
            size="sm"
            onClick={() => void actions.stop(selected().map((s) => s.hash))}
          >
            Stop
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void actions.tags(
                selected().map((s) => s.hash),
                "add",
                [KEEP],
              )
            }
          >
            Tag keep
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDeleting({ hashes: selected().map((s) => s.hash), files: false })}
          >
            Remove, keep files
          </Button>
          <Button
            variant="outline"
            size="sm"
            class="border-danger/35 text-danger hover:text-danger"
            onClick={() => setDeleting({ hashes: selected().map((s) => s.hash), files: true })}
          >
            Remove with files · free {formatBytes(selected().reduce((n, s) => n + s.size, 0))}
          </Button>
        </div>
      </Show>
      <DeleteDialog
        hashes={deleting()?.hashes ?? []}
        files={deleting()?.files}
        label={
          deleting()?.hashes.length === 1
            ? (seeds().find((s) => s.hash === deleting()?.hashes[0])?.name ?? "1 torrent")
            : `${deleting()?.hashes.length ?? 0} torrents`
        }
        onClose={(deleted) => {
          setDeleting(null);
          if (deleted) {
            setChosen(new Set<string>());
            void q.refetch();
          }
        }}
      />
    </div>
  );
}

function Table(props: {
  seeds: readonly Seed[];
  chosen: ReadonlySet<string>;
  days: number;
  now: number;
  onToggle: (hash: string) => void;
}) {
  const live = useLive();
  // Rows by hash: a refresh brings new objects, and a row stays the same element.
  const byHash = createMemo(() => new Map(props.seeds.map((x) => [x.hash, x])));
  return (
    <div class="overflow-x-auto">
      <table class="w-full min-w-[860px] table-fixed border-collapse text-sm">
        <thead>
          <tr class="h-7 border-y border-divider text-left text-[11px] font-medium text-subtle">
            <th class="w-10 pl-4 font-medium">
              <span class="sr-only">Selected</span>
            </th>
            <th class="font-medium">Torrent</th>
            <th class="w-[72px] text-right font-medium">Size</th>
            <th class="w-[92px] text-right font-medium">Uploaded · {props.days} d</th>
            <th class="w-[64px] text-right font-medium">Value</th>
            <th class="w-[64px] text-right font-medium">Seeding</th>
            <th class="w-[104px] pl-4 font-medium">Last upload</th>
            <th class="w-[56px] text-right font-medium">Ratio</th>
            <th class="w-[124px] pr-4 pl-4 font-medium">Tracker</th>
          </tr>
        </thead>
        <tbody>
          <For each={props.seeds.map((x) => x.hash)}>
            {(hash) => (
              <Show when={byHash().get(hash)}>
                {(seed) => {
                  const s = seed;
                  const row = () => live.state.torrents[s().hash];
                  const on = () => props.chosen.has(s().hash);
                  const cls = () => valueClass(s().value);
                  const state = () => {
                    const r = row();
                    return r && r.state !== "seeding" ? stateLook(r) : null;
                  };
                  return (
                    <tr
                      class={cn(
                        "h-11 border-b border-row-divider transition-colors",
                        on() ? "bg-accent" : "hover:bg-muted",
                      )}
                    >
                      <td class="pl-4">
                        <Checkbox checked={on()} onChange={() => props.onToggle(s().hash)}>
                          <CheckboxLabel class="sr-only">Select {s().name}</CheckboxLabel>
                        </Checkbox>
                      </td>
                      <td>
                        <span class="flex min-w-0 items-center gap-2">
                          <span
                            class={cn("size-[7px] flex-none rounded-full", CLASS_DOT[cls()])}
                            aria-hidden="true"
                          />
                          <A
                            href={`/torrents/${s().hash}`}
                            class="truncate font-medium hover:underline"
                            title={s().name}
                          >
                            {s().name}
                          </A>
                          <Show when={row()?.tags.includes(KEEP)}>
                            <span class="flex-none rounded-sm border border-border px-1.5 mono text-[10px] text-muted-foreground">
                              keep
                            </span>
                          </Show>
                          <Show when={state()}>
                            {(l) => (
                              <span
                                class={cn(
                                  "flex-none rounded-[5px] border border-border bg-muted px-1.5 text-[11px] font-medium",
                                  l().tone === "danger" ? "text-danger" : "text-muted-foreground",
                                )}
                              >
                                {l().label.toLowerCase()}
                              </span>
                            )}
                          </Show>
                        </span>
                      </td>
                      <td class="text-right mono text-muted-foreground">{formatBytes(s().size)}</td>
                      <td class="text-right mono">{formatBytes(s().uploaded)}</td>
                      <td class={cn("text-right mono", CLASS_TEXT[cls()])}>
                        {s().value.toFixed(2)}×
                      </td>
                      <td class="text-right mono text-muted-foreground">
                        {formatDays(s().seeding_time)}
                      </td>
                      <td class="truncate pl-4 text-muted-foreground">
                        {s().last_upload === null ? "never" : formatAgo(s().last_upload, props.now)}
                      </td>
                      <td class="text-right mono text-muted-foreground">
                        {formatRatio(s().ratio)}
                      </td>
                      <td
                        class="truncate pr-4 pl-4 mono text-xs text-subtle"
                        title={s().tracker ?? undefined}
                      >
                        {s().tracker ?? "no tracker"}
                      </td>
                    </tr>
                  );
                }}
              </Show>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}

/** A dot's radius: 5px, plus up to 8 for seeding the whole window. */
function dotRadius(seeding: number, window: number): number {
  return 5 + 8 * Math.min(1, seeding / window);
}

function Scatter(props: {
  seeds: readonly Seed[];
  chosen: ReadonlySet<string>;
  days: number;
  onToggle: (hash: string) => void;
}) {
  let box!: HTMLDivElement;
  const [width, setWidth] = createSignal(1100);
  onMount(() => {
    const ro = new ResizeObserver(() => setWidth(Math.max(320, box.clientWidth)));
    ro.observe(box);
    onCleanup(() => ro.disconnect());
  });
  const H = 300;
  const L = 52;
  const T = 14;
  const B = 264;
  const R = () => width() - 8;
  const sizes = createMemo(() => sizeRange(props.seeds));
  const values = createMemo(() => valueRange(props.seeds));
  const x = createMemo(() => logScale(sizes()[0], sizes()[1], L, R()));
  const y = createMemo(() => logScale(values()[0], values()[1], B, T));
  const span = () => props.days * 86_400;
  // Names beside their dots, the chosen ones first and then the largest,
  // each where it overlaps no name already placed (or nowhere).
  const labels = createMemo(() => {
    const boxes: { x0: number; x1: number; y0: number; y1: number }[] = [];
    const out = new Map<string, { x: number; anchor: "start" | "end"; text: string }>();
    const chosen = props.chosen;
    const order = [...props.seeds].sort(
      (a, b) => Number(chosen.has(b.hash)) - Number(chosen.has(a.hash)) || b.size - a.size,
    );
    for (const s of order.slice(0, 30)) {
      const cx = x()(s.size);
      const cy = y()(s.value);
      const r = dotRadius(s.seeding_time, span());
      const text = s.name.length > 34 ? `${s.name.slice(0, 33)}…` : s.name;
      const w = text.length * 6.2;
      for (const right of cx < R() - 260 ? [true, false] : [false, true]) {
        const x0 = right ? cx + r + 6 : cx - r - 6 - w;
        const box = { x0, x1: x0 + w, y0: cy - 7, y1: cy + 7 };
        if (box.x0 < L || box.x1 > R()) continue;
        if (boxes.some((b) => b.x0 < box.x1 && box.x0 < b.x1 && b.y0 < box.y1 && box.y0 < b.y1)) {
          continue;
        }
        boxes.push(box);
        out.set(s.hash, {
          x: right ? cx + r + 6 : cx - r - 6,
          anchor: right ? "start" : "end",
          text,
        });
        break;
      }
    }
    return out;
  });
  const zone = () => {
    const x0 = Math.max(L, x()(BIG));
    return { x: x0, y: y()(0.1), w: R() - x0, h: B - y()(0.1) };
  };
  return (
    <div ref={box} class="w-full">
      <svg
        width={width()}
        height={H}
        viewBox={`0 0 ${width()} ${H}`}
        class="block overflow-visible"
        role="img"
        aria-label={`${props.seeds.length} torrents by size and by upload against size`}
      >
        <Show when={zone().w > 0}>
          <rect
            x={zone().x}
            y={zone().y}
            width={zone().w}
            height={zone().h}
            fill="var(--danger)"
            fill-opacity="0.06"
            stroke="var(--danger)"
            stroke-opacity="0.35"
            stroke-dasharray="4 4"
          />
          <text
            x={R() - 4}
            y={B - 8}
            font-size="10"
            fill="var(--danger)"
            text-anchor="end"
            class="mono"
          >
            big and idle → remove first
          </text>
        </Show>
        <g font-size="10" fill="var(--subtle)" class="mono">
          <For each={logTicks(values()[0], values()[1])}>
            {(v) => (
              <g>
                <line x1={L} x2={R()} y1={y()(v)} y2={y()(v)} stroke="var(--grid-line)" />
                <text x={L - 8} y={y()(v) + 3} text-anchor="end">
                  {v === values()[0] ? `≤${v}×` : `${v}×`}
                </text>
              </g>
            )}
          </For>
          <For each={logTicks(sizes()[0], sizes()[1])}>
            {(s) => (
              <g>
                <line x1={x()(s)} x2={x()(s)} y1={T} y2={B} stroke="var(--grid-line)" />
                <text x={x()(s)} y={B + 18} text-anchor="middle">
                  {formatBytes(s)}
                </text>
              </g>
            )}
          </For>
          <text x={R()} y={H - 4} text-anchor="end">
            size on disk →
          </text>
          <text x={L} y={T - 4}>
            uploaded ÷ size, {props.days} days ↑
          </text>
        </g>
        <line
          x1={L}
          x2={R()}
          y1={y()(1)}
          y2={y()(1)}
          stroke="var(--faint)"
          stroke-dasharray="2 4"
        />
        <text
          x={R() - 4}
          y={y()(1) - 4}
          text-anchor="end"
          font-size="10"
          fill="var(--subtle)"
          class="mono"
        >
          1× — uploaded its own size
        </text>
        <For each={[...props.seeds].sort((a, b) => b.seeding_time - a.seeding_time)}>
          {(s) => {
            const on = () => props.chosen.has(s.hash);
            const cx = () => x()(s.size);
            const cy = () => y()(s.value);
            const r = () => dotRadius(s.seeding_time, span());
            return (
              <g class="cursor-pointer" onClick={() => props.onToggle(s.hash)}>
                <title>
                  {s.name}: {formatBytes(s.size)}, {s.value.toFixed(2)}× in {props.days} days
                </title>
                <circle
                  cx={cx()}
                  cy={cy()}
                  r={r()}
                  fill={CLASS_FILL[valueClass(s.value)]}
                  fill-opacity={on() ? 0.95 : 0.55}
                  stroke={on() ? "var(--foreground)" : "var(--card)"}
                  stroke-width="2"
                />
                <Show when={labels().get(s.hash)}>
                  {(l) => (
                    <text
                      x={l().x}
                      y={cy() + 4}
                      font-size="11"
                      fill={on() ? "var(--foreground)" : "var(--muted-foreground)"}
                      text-anchor={l().anchor}
                    >
                      {l().text}
                    </text>
                  )}
                </Show>
              </g>
            );
          }}
        </For>
      </svg>
    </div>
  );
}
