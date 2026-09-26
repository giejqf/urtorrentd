// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Stats › Overview as designed: the range's traffic against the range
// before, the transfer rate, the top torrents, traffic by category, peers
// by client (or another breakdown), idle seeds and the newest events. All
// of it is the daemon's recorded history (`/stats/...`); the free space and
// the peers now come from the live store.

import { A, useSearchParams } from "@solidjs/router";
import ChevronDown from "lucide-solid/icons/chevron-down";
import { createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js";

import { ApiError, type Schemas } from "~/api/client";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useStatsInfo, useSystemInfo } from "~/features/settings/app-info";
import { useLive } from "~/features/shell/live";
import { PageHeader } from "~/features/shell/page-header";
import { DeleteDialog } from "~/features/torrents/delete-dialog";
import {
  byteUnit,
  dash,
  formatAgo,
  formatAxis,
  formatBytes,
  formatClock,
  formatCount,
  formatDateTime,
  formatPercent,
  formatRate,
  formatRatio,
  formatShortDate,
  localDay,
} from "~/lib/format";
import { cn } from "~/lib/utils";

import { tickLabel, TimeChart } from "./chart";
import {
  useCategories,
  useIdleSeeds,
  useMinuteClock,
  usePeers,
  useTimeline,
  useTop,
  useTransfer,
} from "./data";
import { Amount, Card, Change, Empty, HBar, Kpi, Legend, RangeBar, TipRow } from "./parts";
import {
  bucketWords,
  chartBucket,
  OVERVIEW_PRESETS,
  previousRange,
  type RangeParams,
  rangeOf,
  STEP_SECONDS,
} from "./range";
import {
  change,
  DIMENSIONS,
  groupLabel,
  KIND_DOTS,
  peakPeers,
  rateSeries,
  reclaimable,
  shares,
  totals,
  valueTone,
} from "./view";

type Span = { from: number; to: number };

export default function Overview() {
  const [params] = useSearchParams<RangeParams>();
  const now = useMinuteClock();
  const info = useStatsInfo();
  const oldest = () => {
    const i = info.data;
    return i ? (i.oldest_day ?? i.oldest_hour ?? i.oldest_minute) : null;
  };
  const range = createMemo(() => rangeOf(params, OVERVIEW_PRESETS, "7d", now(), oldest()));
  const span = createMemo<Span>(
    () => ({ from: range().from, to: range().to }),
    { from: 0, to: 0 },
    { equals: (a, b) => a.from === b.from && a.to === b.to },
  );
  const unavailable = () => info.error instanceof ApiError && info.error.status === 503;
  return (
    <div class="flex min-w-0 flex-1 flex-col">
      <PageHeader title="Statistics">
        <RangeBar presets={OVERVIEW_PRESETS} range={range()} now={now()} />
      </PageHeader>
      <Switch>
        <Match when={unavailable()}>
          <Empty>
            Statistics are unavailable: the daemon could not open its statistics database. The log
            says why.
          </Empty>
        </Match>
        <Match when={true}>
          <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
            <Show when={info.data?.enabled === false}>
              <p class="m-0 rounded-lg border border-divider bg-muted px-3 py-2 text-sm text-muted-foreground">
                Recording is off: these reports show what was recorded before.{" "}
                <A href="/settings/statistics" class="text-foreground underline">
                  Settings › Statistics
                </A>
              </p>
            </Show>
            <Figures span={span()} range={range()} now={now()} />
            <RateCard span={span()} words={range().words} now={now()} />
            <div class="grid gap-4 xl:grid-cols-3">
              <TopCard span={span()} words={range().words} />
              <CategoryCard span={span()} words={range().words} />
              <PeersCard span={span()} words={range().words} />
            </div>
            <div class="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
              <IdleCard now={now()} />
              <TimelineCard now={now()} />
            </div>
          </div>
        </Match>
      </Switch>
    </div>
  );
}

function Figures(props: { span: Span; range: ReturnType<typeof rangeOf>; now: number }) {
  const live = useLive();
  const sys = useSystemInfo();
  const cur = useTransfer(() => props.span);
  const prev = useTransfer(() => previousRange(props.range));
  const t = () => totals(cur.data?.points ?? []);
  const p = () => (prev.data ? totals(prev.data.points) : null);
  const peak = () => peakPeers(cur.data?.points ?? []);
  const words = () => props.range.previous;
  const ratio = () => (t().downloaded > 0 ? t().uploaded / t().downloaded : null);
  const free = () => live.state.transfer?.free_space ?? null;
  const fs = () => sys.data?.save_path_fs ?? null;
  return (
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
      <Kpi
        label="Downloaded"
        dot="bg-brand"
        value={<Amount text={formatBytes(t().downloaded)} />}
        sub={
          <Show when={p()} fallback={props.range.words}>
            {(before) => (
              <Change fraction={change(t().downloaded, before().downloaded)} words={words()} />
            )}
          </Show>
        }
      />
      <Kpi
        label="Uploaded"
        dot="bg-upload"
        value={<Amount text={formatBytes(t().uploaded)} />}
        sub={
          <Show when={p()} fallback={props.range.words}>
            {(before) => (
              <Change fraction={change(t().uploaded, before().uploaded)} words={words()} />
            )}
          </Show>
        }
      />
      <Kpi
        label="Share ratio (range)"
        value={formatRatio(ratio())}
        sub={`all-time ${formatRatio(live.state.transfer?.ratio ?? null)}`}
      />
      <Kpi
        label="Peak peers"
        value={peak() ? formatCount(peak()?.peers ?? 0) : dash}
        sub={
          <span class="truncate">
            {peak() ? `${formatDateTime(peak()?.t ?? null)} · ` : ""}
            {formatCount(live.state.transfer?.peers ?? 0)} now
          </span>
        }
      />
      <Kpi
        label="Free space"
        value={free() === null ? dash : <Amount text={formatBytes(free() ?? 0)} />}
        sub={
          <Show when={fs()} fallback="on the default save path's disk">
            {(f) => (
              <span class="truncate" title={f().mount_point ?? f().path}>
                of {formatBytes(f().total)} on {f().mount_point ?? f().path}
              </span>
            )}
          </Show>
        }
      />
    </div>
  );
}

function RateCard(props: { span: Span; words: string; now: number }) {
  const q = useTransfer(() => props.span);
  const bucket = () => {
    const d = q.data;
    return d ? chartBucket(props.span.to - props.span.from, STEP_SECONDS[d.step]) : 3600;
  };
  const rates = createMemo(() => {
    const d = q.data;
    if (!d) return [];
    return rateSeries(
      d.points,
      STEP_SECONDS[d.step],
      bucket(),
      props.span.from,
      props.span.to,
      props.now,
    );
  });
  const top = () => Math.max(0, ...rates().flatMap((r) => [r.down ?? 0, r.up ?? 0]));
  const unit = () => byteUnit(top());
  const recorded = () => rates().some((r) => r.down !== null);
  return (
    <Card
      title="Transfer rate"
      sub={`Session-wide, average per ${bucketWords(bucket())}, ${props.words}`}
      actions={
        <Legend
          items={[
            { label: "Download", color: "--brand" },
            { label: "Upload", color: "--upload" },
          ]}
        />
      }
    >
      <Show when={recorded()} fallback={<Empty>Nothing was recorded in this range.</Empty>}>
        <div class="relative">
          <span class="absolute -top-1 left-0 mono text-[10px] text-subtle">{unit().unit}/s</span>
          <TimeChart
            label={`Download and upload rate, ${props.words}`}
            x={rates().map((r) => r.t)}
            series={[
              { label: "Download", color: "--brand", values: rates().map((r) => r.down) },
              { label: "Upload", color: "--upload", values: rates().map((r) => r.up) },
            ]}
            height={200}
            yLabel={(v) => formatAxis(v / unit().size)}
            xLabel={(t) => tickLabel(t)}
            tooltip={(i) => {
              const r = rates()[i];
              if (!r) return null;
              const end = Math.min(r.t + bucket(), props.span.to);
              return (
                <div class="flex flex-col gap-1">
                  <span class="mono text-xs whitespace-nowrap text-muted-foreground">
                    {localDay(r.t) === localDay(props.now) ? "Today" : formatShortDate(r.t)}{" "}
                    {formatClock(r.t)} – {formatClock(end)}
                  </span>
                  <Show when={r.down !== null} fallback={<span>not recorded</span>}>
                    <TipRow color="--brand" label="Download" value={formatRate(r.down ?? 0)} />
                    <TipRow color="--upload" label="Upload" value={formatRate(r.up ?? 0)} />
                  </Show>
                </div>
              );
            }}
          />
        </div>
      </Show>
    </Card>
  );
}

function MenuButton(props: { children: JSX.Element; label: string }) {
  return (
    <DropdownMenuTrigger as={Button} variant="outline" size="sm" aria-label={props.label}>
      {props.children}
      <ChevronDown />
    </DropdownMenuTrigger>
  );
}

function TopCard(props: { span: Span; words: string }) {
  const [by, setBy] = createSignal<Schemas["TopMetric"]>("uploaded");
  const q = useTop(
    () => props.span,
    () => by(),
  );
  const rows = () => (q.data?.torrents ?? []).filter((t) => t[by()] > 0);
  const most = () => Math.max(1, ...rows().map((t) => t[by()]));
  return (
    <Card
      title="Top torrents"
      sub={`By ${by() === "uploaded" ? "upload" : "download"}, ${props.words}`}
      actions={
        <DropdownMenu>
          <MenuButton label="Rank by">{by() === "uploaded" ? "Upload" : "Download"}</MenuButton>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value={by()} onChange={(v) => setBy(v as Schemas["TopMetric"])}>
              <DropdownMenuRadioItem closeOnSelect value="uploaded">
                Upload
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem closeOnSelect value="downloaded">
                Download
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <Show when={rows().length > 0} fallback={<Empty>No torrent moved data in this range.</Empty>}>
        <ul class="m-0 flex list-none flex-col gap-2.5 p-0">
          <For each={rows()}>
            {(t) => (
              <HBar
                label={
                  <Show
                    when={t.removed === null}
                    fallback={
                      <>
                        {t.name ?? t.hash} <span class="text-subtle">· removed</span>
                      </>
                    }
                  >
                    <A href={`/torrents/${t.hash}`} class="hover:underline">
                      {t.name ?? t.hash}
                    </A>
                  </Show>
                }
                value={formatBytes(t[by()])}
                fill={t[by()] / most()}
                color={by() === "uploaded" ? "bg-upload" : "bg-brand"}
              />
            )}
          </For>
        </ul>
      </Show>
    </Card>
  );
}

function CategoryCard(props: { span: Span; words: string }) {
  const q = useCategories(() => props.span);
  const rows = () => q.data?.rows ?? [];
  const top = () => Math.max(0, ...rows().flatMap((r) => [r.downloaded, r.uploaded]));
  const unit = () => byteUnit(top());
  const scale = () => {
    const u = unit();
    const t = top() / u.size;
    const mag = 10 ** Math.floor(Math.log10(Math.max(t, 1e-9)));
    const step = [1, 2, 2.5, 5, 10].map((f) => f * mag).find((s) => s * 4 >= t) ?? mag * 10;
    return { step, max: step * 4 };
  };
  const pct = (bytes: number) => (bytes / unit().size / scale().max) * 100;
  return (
    <Card
      title="Traffic by category"
      sub={props.words}
      actions={
        <Legend
          items={[
            { label: "Down", color: "--brand" },
            { label: "Up", color: "--upload" },
          ]}
        />
      }
    >
      <Show when={top() > 0} fallback={<Empty>No torrent moved data in this range.</Empty>}>
        <div class="flex flex-col">
          <span class="mono text-[10px] text-subtle">{unit().unit}</span>
          <div class="relative ml-9 h-[176px]">
            <For each={[4, 3, 2, 1, 0]}>
              {(k) => (
                <div
                  class={cn(
                    "absolute right-0 left-0 border-t",
                    k === 0 ? "border-border-strong" : "border-grid-line",
                  )}
                  style={{ bottom: `${k * 25}%` }}
                >
                  <span class="absolute -top-2 -left-9 w-8 text-right mono text-[11px] text-subtle">
                    {k === 0 ? "" : formatAxis(scale().step * k)}
                  </span>
                </div>
              )}
            </For>
            <ul
              class="absolute inset-0 m-0 flex list-none items-end justify-around p-0"
              aria-label="Categories"
            >
              <For each={rows()}>
                {(r) => (
                  <li
                    class="flex h-full items-end gap-1"
                    aria-label={`${groupLabel(r.key)}: ${formatBytes(r.downloaded)} down, ${formatBytes(r.uploaded)} up, ${r.torrents} torrents`}
                    title={`${groupLabel(r.key)} · ↓ ${formatBytes(r.downloaded)} · ↑ ${formatBytes(r.uploaded)}`}
                  >
                    <div
                      class="w-[22px] rounded-t-[3px] bg-brand"
                      style={{ height: `${pct(r.downloaded)}%` }}
                    />
                    <div
                      class="w-[22px] rounded-t-[3px] bg-upload"
                      style={{ height: `${pct(r.uploaded)}%` }}
                    />
                  </li>
                )}
              </For>
            </ul>
          </div>
          <div class="ml-9 flex justify-around pt-1.5" aria-hidden="true">
            <For each={rows()}>
              {(r) => (
                <span
                  class={cn(
                    "w-[48px] truncate text-center text-xs",
                    r.key === null ? "text-subtle" : "text-muted-foreground",
                  )}
                >
                  {groupLabel(r.key)}
                </span>
              )}
            </For>
          </div>
        </div>
      </Show>
    </Card>
  );
}

function PeersCard(props: { span: Span; words: string }) {
  const [dim, setDim] = createSignal<Schemas["PeerDimension"]>("client");
  const [metric, setMetric] = createSignal<"uploaded" | "downloaded">("uploaded");
  const q = usePeers(
    () => props.span,
    () => dim(),
  );
  const list = () => (q.data ? shares(q.data, metric()) : []);
  const most = () => Math.max(0.0001, ...list().map((s) => s.share));
  const dimLabel = () => DIMENSIONS.find((d) => d.value === dim())?.label ?? "Client";
  return (
    <Card
      title={dim() === "client" ? "Peer clients" : `Peers by ${dimLabel().toLowerCase()}`}
      sub={`Share of ${metric() === "uploaded" ? "upload" : "download"}, ${props.words}`}
      actions={
        <DropdownMenu>
          <MenuButton label="Break peers down by">{dimLabel()}</MenuButton>
          <DropdownMenuContent class="min-w-44">
            <DropdownMenuGroup>
              <DropdownMenuGroupLabel>By</DropdownMenuGroupLabel>
              <DropdownMenuRadioGroup
                value={dim()}
                onChange={(v) => setDim(v as Schemas["PeerDimension"])}
              >
                <For each={DIMENSIONS}>
                  {(d) => (
                    <DropdownMenuRadioItem closeOnSelect value={d.value}>
                      {d.label}
                    </DropdownMenuRadioItem>
                  )}
                </For>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuGroupLabel>Share of</DropdownMenuGroupLabel>
              <DropdownMenuRadioGroup
                value={metric()}
                onChange={(v) => setMetric(v as "uploaded" | "downloaded")}
              >
                <DropdownMenuRadioItem closeOnSelect value="uploaded">
                  Upload
                </DropdownMenuRadioItem>
                <DropdownMenuRadioItem closeOnSelect value="downloaded">
                  Download
                </DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <Show
        when={list().length > 0}
        fallback={<Empty>No peer traffic was recorded in this range.</Empty>}
      >
        <ul class="m-0 flex list-none flex-col gap-2.5 p-0">
          <For each={list()}>
            {(s) => (
              <HBar
                label={s.label}
                value={formatPercent(s.share)}
                fill={s.share / most()}
                color="bg-brand"
                title={formatBytes(s.bytes)}
              />
            )}
          </For>
        </ul>
      </Show>
    </Card>
  );
}

function IdleCard(props: { now: number }) {
  const q = useIdleSeeds();
  const seeds = () => q.data?.torrents ?? [];
  const reclaim = () => reclaimable(seeds());
  const [deleting, setDeleting] = createSignal<string[]>([]);
  return (
    <Card
      title="Idle seeds"
      sub="Complete torrents by upload relative to size, last 30 days: candidates to remove"
      actions={
        <Show when={reclaim().hashes.length > 0}>
          <Button variant="outline" size="sm" onClick={() => setDeleting(reclaim().hashes)}>
            Reclaim {formatBytes(reclaim().bytes)}
          </Button>
        </Show>
      }
    >
      <Show when={seeds().length > 0} fallback={<Empty>No complete torrent yet.</Empty>}>
        <table class="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr class="h-7 border-b border-border text-left text-[11px] font-medium tracking-wide text-subtle uppercase">
              <th class="font-medium">Name</th>
              <th class="w-[72px] text-right font-medium">Size</th>
              <th class="w-[84px] text-right font-medium">Uploaded</th>
              <th class="w-[64px] text-right font-medium">Value</th>
              <th class="w-[96px] pl-4 font-medium">Last upload</th>
              <th class="w-[56px] text-right font-medium">Ratio</th>
            </tr>
          </thead>
          <tbody>
            <For each={seeds().slice(0, 5)}>
              {(s) => (
                <tr class="h-9 border-b border-row-divider">
                  <td class="truncate">
                    <A href={`/torrents/${s.hash}`} class="hover:underline" title={s.name}>
                      {s.name}
                    </A>
                  </td>
                  <td class="text-right mono text-muted-foreground">{formatBytes(s.size)}</td>
                  <td class="text-right mono">{formatBytes(s.uploaded)}</td>
                  <td
                    class={cn(
                      "text-right mono",
                      valueTone(s.value) === "danger" && "text-danger",
                      valueTone(s.value) === "warn" && "text-warn",
                    )}
                  >
                    {s.value.toFixed(2)}×
                  </td>
                  <td class="truncate pl-4 text-muted-foreground">
                    {s.last_upload === null ? "never" : formatAgo(s.last_upload, props.now)}
                  </td>
                  <td class="text-right mono text-muted-foreground">{formatRatio(s.ratio)}</td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
      <DeleteDialog
        hashes={deleting()}
        label={deleting().length === 1 ? "1 idle torrent" : `${deleting().length} idle torrents`}
        onClose={() => {
          setDeleting([]);
          void q.refetch();
        }}
      />
    </Card>
  );
}

function TimelineCard(props: { now: number }) {
  const q = useTimeline(5);
  const live = useLive();
  const known = (hash: string) => live.state.torrents[hash] !== undefined;
  return (
    <Card title="Timeline" sub="Newest first">
      <Show when={(q.data ?? []).length > 0} fallback={<Empty>Nothing has happened yet.</Empty>}>
        <ul class="m-0 flex list-none flex-col p-0">
          <For each={q.data ?? []}>
            {(e) => (
              <li class="grid h-9 grid-cols-[52px_12px_minmax(0,1fr)] items-center gap-2.5 border-b border-row-divider text-sm">
                <span class="mono text-xs text-muted-foreground" title={formatDateTime(e.t)}>
                  {localDay(e.t) === localDay(props.now) ? formatClock(e.t) : formatShortDate(e.t)}
                </span>
                <span class={cn("size-1.5 rounded-full", KIND_DOTS[e.kind])} aria-hidden="true" />
                <span class="truncate">
                  <span class="mr-2 inline-flex h-5 items-center rounded-full border border-border px-2 text-[11px] font-medium text-muted-foreground">
                    {e.kind === "state" && e.state ? e.state : e.kind}
                  </span>
                  <Show when={known(e.hash)} fallback={e.name ?? e.hash}>
                    <A href={`/torrents/${e.hash}`} class="hover:underline">
                      {e.name ?? e.hash}
                    </A>
                  </Show>
                  <Show when={e.detail}>
                    <span class="text-muted-foreground"> — {e.detail}</span>
                  </Show>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Card>
  );
}
