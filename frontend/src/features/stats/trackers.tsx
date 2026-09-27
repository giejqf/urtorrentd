// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Stats › Trackers as designed: per host, its torrents' traffic and its
// announces over the range (`/stats/trackers`), beside what stands now
// (`/torrents/trackers`): which torrents use it, which fail on it. A row
// isolates its host in the chart. Problems come with what can be done:
// announce again, drop a dead tracker, give public torrents the trackers
// meant for new ones. Hosts only, never URLs (AGENTS.md rule 6).

import { A, useSearchParams } from "@solidjs/router";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { createMemo, createSignal, For, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { useAppInfo, useStatsInfo } from "~/features/settings/app-info";
import { Segmented } from "~/features/settings/controls";
import { useLive } from "~/features/shell/live";
import { PageHeader } from "~/features/shell/page-header";
import { actions } from "~/features/torrents/actions";
import {
  byteUnit,
  dash,
  formatAgo,
  formatAxis,
  formatBytes,
  formatClock,
  formatCount,
  formatDuration,
  formatPercent,
  formatShortDate,
} from "~/lib/format";
import { cn } from "~/lib/utils";

import { tickLabel, TimeChart } from "./chart";
import { useMinuteClock, useTrackerHosts, useTrackerStats } from "./data";
import { Card, Empty, Kpi, Legend, RangeBar, TipRow } from "./parts";
import { type RangeParams, rangeOf, reportBars, TRACKER_PRESETS } from "./range";
import {
  type AnnounceBar,
  announceBars,
  defaultTrackers,
  failingHosts,
  hideUrls,
  hostKind,
  medianInterval,
  METRICS,
  SLOW_ANSWER,
  stackSeries,
  success,
  type TrackerLine,
  type TrackerMetric,
  trackerKpis,
  trackerLines,
  withoutTracker,
} from "./trackers-view";

interface TrackerParams extends RangeParams {
  by?: string;
}

export default function Trackers() {
  const [params, setParams] = useSearchParams<TrackerParams>();
  const now = useMinuteClock();
  const info = useStatsInfo();
  const live = useLive();
  const metric = (): TrackerMetric =>
    METRICS.some((m) => m.value === params.by) ? (params.by as TrackerMetric) : "uploaded";
  const range = createMemo(() => rangeOf(params, TRACKER_PRESETS, "7d", now(), null));
  const span = createMemo(
    () => ({ from: range().from, to: range().to }),
    { from: 0, to: 0 },
    { equals: (a, b) => a.from === b.from && a.to === b.to },
  );
  const stats = useTrackerStats(span, () =>
    metric() === "downloaded" ? "downloaded" : "uploaded",
  );
  const hosts = useTrackerHosts();
  const without = createMemo(() => withoutTracker(live.torrents()));
  const lines = createMemo(() =>
    trackerLines(stats.data?.rows ?? [], hosts.data ?? [], metric(), {
      torrents: without().public.length + without().private.length,
      private: without().private.length,
    }),
  );
  const bars = createMemo(() => {
    const d = stats.data;
    return d ? reportBars(d.step, d.from, d.to) : { starts: [], unit: "day" as const };
  });
  const [isolated, setIsolated] = createSignal<string | null | undefined>(undefined);
  const unavailable = () => info.error instanceof ApiError && info.error.status === 503;
  const hostCount = () => lines().filter((l) => l.host !== null).length;
  return (
    <div class="flex min-w-0 flex-1 flex-col">
      <PageHeader
        title="Trackers"
        count={
          <span class="mono text-xs text-subtle">
            {formatCount(hostCount())} {hostCount() === 1 ? "host" : "hosts"} · by host
          </span>
        }
      >
        <Segmented
          label="Rank by"
          options={METRICS}
          value={metric()}
          onChange={(v) => setParams({ by: v === "uploaded" ? undefined : v })}
        />
        <RangeBar presets={TRACKER_PRESETS} range={range()} now={now()} />
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
        <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
          <Figures lines={lines()} metric={metric()} hosts={hosts.data ?? []} />
          <Health
            lines={lines()}
            points={stats.data?.points ?? []}
            starts={bars().starts}
            unit={bars().unit}
            words={range().words}
            isolated={isolated()}
            onIsolate={(h) => setIsolated(isolated() === h ? undefined : h)}
          />
          <div class="grid gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <TrafficCard
              lines={lines()}
              points={stats.data?.points ?? []}
              starts={bars().starts}
              unit={bars().unit}
              metric={metric()}
              isolated={isolated()}
            />
            <Problems
              hosts={hosts.data ?? []}
              lines={lines()}
              without={without()}
              words={range().words}
              now={now()}
            />
          </div>
        </div>
      </Show>
    </div>
  );
}

function Figures(props: {
  lines: TrackerLine[];
  metric: TrackerMetric;
  hosts: Parameters<typeof medianInterval>[0];
}) {
  const k = () => trackerKpis(props.lines, props.metric);
  const interval = () => medianInterval(props.hosts);
  const failingNow = () => props.hosts.filter((h) => h.failing.length > 0);
  const failingTorrents = () => new Set(failingNow().flatMap((h) => h.failing)).size;
  return (
    <div class="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-5">
      <Kpi
        value={
          <>
            {formatCount(k().working)}
            <Show when={k().noneMoved}>
              <span class="ml-1 text-sm font-medium text-muted-foreground">+ no tracker</span>
            </Show>
          </>
        }
        sub="trackers moving data"
      />
      <Kpi
        value={formatCount(k().answered)}
        sub={
          <span class="truncate">
            announces answered
            {interval() === null ? "" : ` · ${formatDuration(interval() ?? 0)} median interval`}
          </span>
        }
      />
      <Kpi
        value={formatCount(k().failed)}
        tone={k().failed > 0 ? "danger" : undefined}
        sub={
          <span class="truncate">
            failed
            {k().failedShare === null ? "" : ` · ${formatPercent(k().failedShare ?? 0, 1)}`}
            {k().failingHosts === 1
              ? " · all from one host"
              : k().failingHosts > 1
                ? ` · from ${k().failingHosts} hosts`
                : ""}
          </span>
        }
      />
      <Kpi
        value={k().top ? formatPercent(k().top?.share ?? 0) : dash}
        sub={
          <span class="truncate">
            of {k().top?.metric === "downloaded" ? "download" : "upload"}{" "}
            {k().top
              ? k().top?.host === null
                ? "with no working tracker"
                : `through ${k().top?.host}`
              : ""}
          </span>
        }
      />
      <Kpi
        value={formatCount(failingNow().length)}
        tone={failingNow().length > 0 ? "danger" : undefined}
        sub={
          failingNow().length > 0
            ? `${failingNow().length === 1 ? "host" : "hosts"} failing now · ${failingTorrents()} ${failingTorrents() === 1 ? "torrent" : "torrents"}`
            : "no tracker failing now"
        }
      />
    </div>
  );
}

function Health(props: {
  lines: TrackerLine[];
  points: Parameters<typeof announceBars>[0];
  starts: number[];
  unit: "hour" | "day" | "utc-day";
  words: string;
  isolated: string | null | undefined;
  onIsolate: (host: string | null) => void;
}) {
  const traffic = () => props.lines.reduce((n, l) => n + l.downloaded + l.uploaded, 0);
  const bars = createMemo(
    () =>
      new Map(props.lines.map((l) => [l.host, announceBars(props.points, l.host, props.starts)])),
  );
  const most = () =>
    Math.max(1, ...[...bars().values()].flatMap((b) => b.map((x) => x.ok + x.failed)));
  const cols = "grid-cols-[8px_minmax(0,1fr)_56px_150px_64px_120px_110px]";
  return (
    <Card
      title="Tracker health"
      sub={`Per host: its torrents' traffic and its announces, ${props.words}`}
      actions={
        <Legend
          items={[
            { label: "download", color: "--brand" },
            { label: "upload", color: "--upload" },
            { label: "answered", color: "--ok" },
            { label: "failed", color: "--danger" },
          ]}
        />
      }
      flush
    >
      <Show
        when={props.lines.length > 0}
        fallback={<Empty>No torrent has a tracker, and nothing was recorded in this range.</Empty>}
      >
        <div class="overflow-x-auto">
          <div class="min-w-[760px]">
            <div
              class={cn(
                "grid h-7 items-center gap-3 border-b border-divider px-4 text-[11px] font-medium text-subtle",
                cols,
              )}
            >
              <span />
              <span>Host</span>
              <span class="text-right">Torrents</span>
              <span>Traffic share · ↓ / ↑</span>
              <span class="text-right">Ratio</span>
              <span>Announces · {props.unit === "hour" ? "per hour" : "per day"}</span>
              <span class="text-right">Success</span>
            </div>
            <ul class="m-0 list-none p-0" aria-label="Trackers">
              <For each={props.lines}>
                {(l) => {
                  const ok = () => success(l);
                  const on = () => props.isolated === l.host;
                  return (
                    <li>
                      <button
                        type="button"
                        class={cn(
                          "grid h-[46px] w-full items-center gap-3 border-b border-row-divider px-4 text-left text-sm transition-colors",
                          cols,
                          on() ? "bg-accent" : "hover:bg-muted",
                        )}
                        aria-pressed={on()}
                        aria-label={`${l.host ?? "No working tracker"}: show it alone in the chart`}
                        onClick={() => props.onIsolate(l.host)}
                      >
                        <span
                          class="size-[7px] rounded-full"
                          style={{ background: `var(${l.color})` }}
                          aria-hidden="true"
                        />
                        <span class="flex min-w-0 flex-col gap-0.5">
                          <span
                            class={cn(
                              "truncate mono",
                              l.host === null ? "text-muted-foreground" : "font-medium",
                            )}
                          >
                            {l.host ?? "No working tracker"}
                          </span>
                          <span class="truncate text-xs text-subtle">
                            <Show
                              when={l.host !== null}
                              fallback={`${formatCount(l.torrents)} running without one now · DHT, PEX, LSD`}
                            >
                              {hostKind(l)}
                              <Show when={l.failing.length > 0}>
                                <span class="text-danger"> · failing now</span>
                              </Show>
                              <Show when={(l.responseTime ?? 0) >= SLOW_ANSWER}>
                                <span class="text-warn">
                                  {" "}
                                  · slow · {(l.responseTime ?? 0).toFixed(1)} s
                                </span>
                              </Show>
                            </Show>
                          </span>
                        </span>
                        <span class="text-right mono text-muted-foreground">
                          {formatCount(l.torrents)}
                        </span>
                        <span class="flex flex-col gap-1">
                          <span class="flex h-1.5 gap-0.5 overflow-hidden rounded-xs bg-accent">
                            <span
                              class="h-full bg-brand"
                              style={{ width: `${(l.downloaded / Math.max(1, traffic())) * 100}%` }}
                            />
                            <span
                              class="h-full bg-upload"
                              style={{ width: `${(l.uploaded / Math.max(1, traffic())) * 100}%` }}
                            />
                          </span>
                          <span class="truncate mono text-[10px] text-subtle">
                            ↓ {formatBytes(l.downloaded)} · ↑ {formatBytes(l.uploaded)}
                          </span>
                        </span>
                        <span class="text-right mono">
                          {l.downloaded > 0 ? (l.uploaded / l.downloaded).toFixed(1) : dash}
                        </span>
                        <MiniBars bars={bars().get(l.host) ?? []} most={most()} />
                        <span class="flex flex-col items-end gap-0.5">
                          <span
                            class={cn(
                              "mono",
                              ok() === null ? "text-faint" : l.errors > 0 ? "text-warn" : "text-ok",
                            )}
                          >
                            {ok() === null ? dash : formatPercent(ok() ?? 0, 1)}
                          </span>
                          <span class="mono text-[10px] text-subtle">
                            {ok() === null
                              ? "no announces"
                              : `${formatCount(l.announces)} · ${formatCount(l.errors)} failed`}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                }}
              </For>
            </ul>
          </div>
        </div>
      </Show>
    </Card>
  );
}

/** Announces per bar: answered in green, failed on top in red (at least 2px when any). */
function MiniBars(props: { bars: AnnounceBar[]; most: number }) {
  const W = 120;
  const H = 22;
  const gap = () => (props.bars.length > 40 ? 0 : props.bars.length > 14 ? 1 : 3);
  const width = () =>
    Math.max(1, (W - gap() * (props.bars.length - 1)) / Math.max(1, props.bars.length));
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} class="block" aria-hidden="true">
      <For each={props.bars}>
        {(b, i) => {
          const ok = () => (b.ok / props.most) * H;
          const bad = () => (b.failed > 0 ? Math.max(2, (b.failed / props.most) * H) : 0);
          const x = () => i() * (width() + gap());
          return (
            <>
              <Show when={b.ok > 0}>
                <rect
                  x={x()}
                  y={H - ok()}
                  width={width()}
                  height={ok()}
                  rx="1.5"
                  fill="var(--ok)"
                />
              </Show>
              <Show when={b.failed > 0}>
                <rect
                  x={x()}
                  y={Math.max(0, H - ok() - bad())}
                  width={width()}
                  height={Math.min(bad(), H)}
                  rx="1.5"
                  fill="var(--danger)"
                />
              </Show>
              <Show when={b.ok === 0 && b.failed === 0}>
                <rect x={x()} y={H - 1} width={width()} height="1" fill="var(--border)" />
              </Show>
            </>
          );
        }}
      </For>
    </svg>
  );
}

function TrafficCard(props: {
  lines: TrackerLine[];
  points: Parameters<typeof stackSeries>[0];
  starts: number[];
  unit: "hour" | "day" | "utc-day";
  metric: TrackerMetric;
  isolated: string | null | undefined;
}) {
  const series = createMemo(() =>
    stackSeries(props.points, props.lines, props.metric, props.starts),
  );
  const top = () => {
    let most = 0;
    for (let i = 0; i < props.starts.length; i += 1) {
      most = Math.max(
        most,
        series().reduce((n, s) => n + (s.values[i] ?? 0), 0),
      );
    }
    return most;
  };
  const bytes = () => props.metric !== "announces";
  const unit = () => (bytes() ? byteUnit(top()) : { unit: "", size: 1 });
  const title = () =>
    props.metric === "uploaded"
      ? "Upload by tracker"
      : props.metric === "downloaded"
        ? "Download by tracker"
        : "Announces by tracker";
  const label = (i: number) => series()[i]?.label ?? "";
  const hostOf = (i: number) => {
    const l = label(i);
    return l === "No working tracker" ? null : l;
  };
  const value = (v: number) => (bytes() ? formatBytes(v) : formatCount(v));
  return (
    <Card
      title={title()}
      sub={`${bytes() ? unit().unit : "Announces"} ${props.unit === "hour" ? "per hour" : "per day"}${props.unit === "utc-day" ? " (UTC)" : ""} · click a row above to isolate`}
      actions={
        <Legend
          items={series().map((s, i) => ({
            label: s.label,
            color: s.color,
            faint: props.isolated !== undefined && hostOf(i) !== props.isolated,
          }))}
        />
      }
    >
      <Show
        when={top() > 0}
        fallback={<Empty>Nothing was recorded for the trackers in this range.</Empty>}
      >
        <TimeChart
          label={`${title()}, stacked`}
          x={props.starts}
          series={series()}
          stack
          height={200}
          yLabel={(v) => formatAxis(v / unit().size)}
          xLabel={(t) =>
            props.unit === "utc-day" ? formatShortDate(t, { timeZone: "UTC" }) : tickLabel(t)
          }
          faint={(i) => props.isolated !== undefined && hostOf(i) !== props.isolated}
          tooltip={(i) => {
            const t = props.starts[i];
            if (t === undefined) return null;
            return (
              <div class="flex flex-col gap-1">
                <span class="mono text-xs text-muted-foreground">
                  {props.unit === "hour"
                    ? `${formatShortDate(t)} ${formatClock(t)}`
                    : formatShortDate(t, props.unit === "utc-day" ? { timeZone: "UTC" } : {})}
                </span>
                <For each={series()}>
                  {(s) => (
                    <TipRow color={s.color} label={s.label} value={value(s.values[i] ?? 0)} />
                  )}
                </For>
              </div>
            );
          }}
        />
      </Show>
    </Card>
  );
}

function Problems(props: {
  hosts: Parameters<typeof failingHosts>[0];
  lines: TrackerLine[];
  without: { public: string[]; private: string[] };
  words: string;
  now: number;
}) {
  const live = useLive();
  const app = useAppInfo();
  const client = useQueryClient();
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
  }));
  const failing = () => failingHosts(props.hosts);
  const errorsOf = (host: string) => props.lines.find((l) => l.host === host)?.errors ?? 0;
  const name = (hash: string) => live.state.torrents[hash]?.name ?? hash.slice(0, 12);
  const [removing, setRemoving] = createSignal<{ host: string; hashes: string[] } | null>(null);
  const [busy, setBusy] = createSignal(false);
  const defaults = () =>
    defaultTrackers(settings.data?.add_trackers ?? [], app.data?.fetched_trackers?.trackers);
  const sources = () => {
    const s = settings.data;
    if (!s) return "";
    const on = [s.dht && "DHT", s.pex && "PEX", s.lsd && "LSD"].filter(Boolean);
    return on.length > 0 ? on.join(" · ") : "incoming connections only";
  };
  const noneShare = () => {
    const total = props.lines.reduce((n, l) => n + l.uploaded, 0);
    const none = props.lines.find((l) => l.host === null)?.uploaded ?? 0;
    return total > 0 ? none / total : null;
  };
  const refresh = () => client.invalidateQueries({ queryKey: keys.trackerHosts() });
  const remove = async () => {
    const r = removing();
    if (!r) return;
    setBusy(true);
    try {
      const out = await unwrap(
        api.POST("/api/v1/torrents/trackers/remove", {
          body: { hashes: r.hashes, hosts: [r.host] },
        }),
      );
      toast.success(`Removed ${r.host} from ${out.applied.length} torrents`);
      setRemoving(null);
      void refresh();
    } catch (e) {
      toast.error(`Remove: ${e instanceof ApiError ? e.message : "failed"}`);
    } finally {
      setBusy(false);
    }
  };
  const addDefaults = async () => {
    const hashes = props.without.public;
    try {
      const out = await unwrap(
        api.POST("/api/v1/torrents/trackers", { body: { hashes, urls: defaults() } }),
      );
      toast.success(`Added ${defaults().length} trackers to ${out.applied.length} torrents`);
      void refresh();
    } catch (e) {
      toast.error(`Add trackers: ${e instanceof ApiError ? e.message : "failed"}`);
    }
  };
  const nothing = () =>
    failing().length === 0 && props.without.public.length + props.without.private.length === 0;
  return (
    <Card title="Announce problems" sub="From each running torrent's trackers, now">
      <Show when={!nothing()} fallback={<Empty>Every running torrent works with a tracker.</Empty>}>
        <ul class="m-0 flex list-none flex-col gap-2 p-0">
          <For each={failing()}>
            {(h) => (
              <li class="flex flex-col gap-1.5 rounded-lg border border-danger/30 bg-danger/6 px-3 py-2.5">
                <div class="flex items-center justify-between gap-2">
                  <span class="truncate mono font-medium">{h.host}</span>
                  <span class="flex-none rounded-sm border border-danger/35 px-1.5 mono text-[10px] text-danger">
                    {formatCount(errorsOf(h.host))} failed · {formatCount(h.fails)} in a row
                  </span>
                </div>
                <p class="m-0 text-sm text-muted-foreground">
                  {hideUrls(h.error ?? "failed")} · last try{" "}
                  {h.last_failure ? formatClock(h.last_failure) : dash} · failing since{" "}
                  {formatAgo(h.failing_since, props.now)} ·{" "}
                  {h.failing.length === 1
                    ? "1 torrent"
                    : `${formatCount(h.failing.length)} torrents`}
                  {" ("}
                  <For each={h.failing.slice(0, 2)}>
                    {(hash, i) => (
                      <>
                        {i() > 0 ? ", " : ""}
                        <A
                          href={`/torrents/${hash}`}
                          class="text-foreground underline decoration-border-strong underline-offset-2 hover:decoration-foreground"
                        >
                          {name(hash)}
                        </A>
                      </>
                    )}
                  </For>
                  {h.failing.length > 2 ? `, ${h.failing.length - 2} more` : ""})
                </p>
                <div class="flex gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void actions.reannounceHosts(h.failing, [h.host])}
                  >
                    Reannounce
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setRemoving({ host: h.host, hashes: h.failing })}
                  >
                    Remove from{" "}
                    {h.failing.length === 1 ? "torrent" : `${h.failing.length} torrents`}
                  </Button>
                </div>
              </li>
            )}
          </For>
          <Show when={props.without.public.length + props.without.private.length > 0}>
            <li class="flex flex-col gap-1.5 rounded-lg border border-divider px-3 py-2.5">
              <p class="m-0 text-sm text-muted-foreground">
                <span class="mono text-foreground">
                  {formatCount(props.without.public.length + props.without.private.length)}{" "}
                  {props.without.public.length + props.without.private.length === 1
                    ? "torrent"
                    : "torrents"}
                </span>{" "}
                {props.without.public.length + props.without.private.length === 1 ? "runs" : "run"}{" "}
                with no working tracker
                <Show when={props.without.public.length > 0}>
                  ; public ones rely on {sources()}
                </Show>
                <Show when={(noneShare() ?? 0) > 0}>
                  {" "}
                  — {formatPercent(noneShare() ?? 0)} of upload, {props.words}
                </Show>
                .
                <Show when={props.without.private.length > 0}>
                  {" "}
                  {formatCount(props.without.private.length)} private: they find peers through their
                  trackers only.
                </Show>
              </p>
              <Show when={props.without.public.length > 0}>
                <Show
                  when={defaults().length > 0}
                  fallback={
                    <p class="m-0 text-xs text-subtle">
                      Trackers for new public torrents are set in{" "}
                      <A href="/settings/downloads" class="underline">
                        Settings › Downloads
                      </A>
                      ; they can then be added here.
                    </p>
                  }
                >
                  <div>
                    <Button
                      variant="outline"
                      size="sm"
                      title={`The ${defaults().length} trackers for new public torrents`}
                      onClick={() => void addDefaults()}
                    >
                      Add trackers to {formatCount(props.without.public.length)} public{" "}
                      {props.without.public.length === 1 ? "torrent" : "torrents"}
                    </Button>
                  </div>
                </Show>
              </Show>
            </li>
          </Show>
        </ul>
      </Show>
      <AlertDialog open={removing() !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {removing()?.host}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every tracker on this host leaves{" "}
              {removing()?.hashes.length === 1
                ? "the torrent"
                : `${removing()?.hashes.length} torrents`}
              ; their other trackers stay. A private torrent's tracker carries your passkey: once
              removed, only the torrent's .torrent file brings it back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose as={Button} variant="outline">
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={busy()} onClick={() => void remove()}>
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
