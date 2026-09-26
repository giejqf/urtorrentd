// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The History tab: what the daemon recorded of this torrent (ADR 0005): the
// last 30 days in figures, the last 12 weeks as seeding days shaded by how
// many copies went out, the last day's traffic by hour, and the record's
// extremes. Its history can be deleted here; the Timeline has its events.

import { A } from "@solidjs/router";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
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
import { useStatsInfo } from "~/features/settings/app-info";
import { dash, formatBytes, formatClock, formatCount, formatShortDate } from "~/lib/format";
import { cn } from "~/lib/utils";

import { DAY, figures, lastDay, type Level, linePath, seedingCells, weekStarts } from "./history";
import { SectionHead, TabHeading } from "./parts";

type TorrentSummary = Schemas["TorrentSummary"];

const W = 388;
const UTC = { timeZone: "UTC" };
const LEVEL_FILL: Record<Level, string> = {
  0: "var(--accent)",
  1: "var(--heat-1)",
  2: "var(--heat-2)",
  3: "var(--heat-3)",
  4: "var(--heat-4)",
};
const LEVEL_WORDS = [
  "nothing",
  "under 0.1 copy",
  "under half a copy",
  "under a copy",
  "a copy or more",
];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
/** How far back the days are read: about 24 years, under the API's 10 000. */
const DAYS_BACK = 9_000;

function Figure(props: { label: string; children: JSX.Element; title?: string }) {
  return (
    <div
      class="flex min-w-0 flex-col gap-0.5 rounded-lg border border-divider px-2.5 py-2"
      title={props.title}
    >
      <span class="truncate text-xs text-subtle">{props.label}</span>
      <span class="truncate mono text-base">{props.children}</span>
    </div>
  );
}

function Prop(props: { label: string; children: JSX.Element }) {
  return (
    <div class="grid min-h-7 grid-cols-[104px_minmax(0,1fr)] items-center gap-x-3 text-sm">
      <dt class="text-subtle">{props.label}</dt>
      <dd class="m-0 truncate mono">{props.children}</dd>
    </div>
  );
}

function Heatmap(props: { cells: ReturnType<typeof seedingCells>; now: number }) {
  const weeks = () => weekStarts(props.now);
  const x = (col: number) => 30 + col * 15;
  const y = (row: number) => 4 + row * 13;
  return (
    <svg
      viewBox={`0 0 ${W} 112`}
      class="block h-auto w-full"
      role="img"
      aria-label="Seeding days, last 12 weeks"
    >
      <g class="fill-subtle mono" font-size="9">
        <For each={[0, 2, 4]}>
          {(r) => (
            <text x="0" y={y(r) + 10}>
              {DAYS[r]}
            </text>
          )}
        </For>
        <For each={[0, 4, 8]}>
          {(c) => (
            <text x={x(c)} y="110">
              {formatShortDate(weeks()[c] ?? 0, UTC)}
            </text>
          )}
        </For>
        <text x={x(11) + 12} y="110" text-anchor="end">
          now
        </text>
      </g>
      <For each={props.cells}>
        {(c) => (
          <rect
            x={x(c.col)}
            y={y(c.row)}
            width="12"
            height="12"
            rx="2"
            fill={c.level === null ? "none" : LEVEL_FILL[c.level]}
            stroke={c.level === null ? "var(--faint)" : "none"}
            stroke-dasharray={c.level === null ? "2 2" : undefined}
          >
            <title>
              {formatShortDate(c.t, UTC)}:{" "}
              {c.level === null
                ? "not seeding"
                : `${formatBytes(c.uploaded)} up (${LEVEL_WORDS[c.level] ?? ""})`}
            </title>
          </rect>
        )}
      </For>
    </svg>
  );
}

function Traffic(props: { buckets: ReturnType<typeof lastDay> }) {
  const H = 76;
  const max = () => Math.max(1, ...props.buckets.flatMap((b) => [b.downloaded, b.uploaded]));
  const up = () =>
    linePath(
      props.buckets.map((b) => b.uploaded),
      max(),
      W,
      H,
    );
  const down = () =>
    linePath(
      props.buckets.map((b) => b.downloaded),
      max(),
      W,
      H,
    );
  const step = () => W / Math.max(props.buckets.length - 1, 1);
  const total = (k: "downloaded" | "uploaded") => props.buckets.reduce((n, b) => n + b[k], 0);
  return (
    <svg
      viewBox={`0 0 ${W} 90`}
      class="block h-auto w-full"
      role="img"
      aria-label={`Last 24 hours: ${formatBytes(total("downloaded"))} down, ${formatBytes(total("uploaded"))} up`}
    >
      <line x1="0" x2={W} y1={H} y2={H} class="stroke-border" />
      <text x="0" y="8" font-size="9" class="fill-subtle mono">
        {formatBytes(max())} / h
      </text>
      <path d={`${up()} L${W} ${H} L0 ${H} Z`} class="fill-upload" fill-opacity="0.18" />
      <path d={up()} fill="none" class="stroke-upload" stroke-width="1.5" />
      <path d={down()} fill="none" class="stroke-brand" stroke-width="1.5" />
      <For each={props.buckets}>
        {(b, i) => (
          <rect x={i() * step() - step() / 2} y="0" width={step()} height={H} fill="transparent">
            <title>
              {formatClock(b.t)}: {formatBytes(b.downloaded)} down, {formatBytes(b.uploaded)} up
            </title>
          </rect>
        )}
      </For>
      <g font-size="9" class="fill-subtle mono">
        <text x="0" y="88">
          −24 h
        </text>
        <text x={W / 2} y="88" text-anchor="middle">
          −12 h
        </text>
        <text x={W} y="88" text-anchor="end">
          now
        </text>
      </g>
    </svg>
  );
}

export function HistoryTab(props: { torrent: TorrentSummary }) {
  const client = useQueryClient();
  const info = useStatsInfo();
  const hash = () => props.torrent.hash;
  // Read when the data arrives: the memos below re-run with it.
  const now = () => Math.floor(Date.now() / 1000);
  const days = createQuery(() => ({
    queryKey: keys.statsReport("torrent-days", { hash: hash() }),
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/stats/torrents/{hash}/days", {
          // All of it, as far as one call goes (at most 10 000 days).
          params: { path: { hash: hash() }, query: { from: now() - DAYS_BACK * DAY } },
        }),
      ),
    refetchInterval: 60_000,
    retry: false,
  }));
  const traffic = createQuery(() => ({
    queryKey: keys.statsReport("torrent-traffic", { hash: hash() }),
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/stats/torrents/{hash}/traffic", {
          params: {
            path: { hash: hash() },
            query: { from: now() - DAY, step: "hour" },
          },
        }),
      ),
    refetchInterval: 60_000,
    retry: false,
  }));
  const [deleting, setDeleting] = createSignal(false);
  const list = () => days.data?.days ?? [];
  const f = createMemo(() => figures(list(), now()));
  const cells = createMemo(() => seedingCells(list(), props.torrent.size, now(), f().since));
  const buckets = createMemo(() => lastDay(traffic.data?.points ?? [], now()));
  const unavailable = () =>
    (info.error instanceof ApiError && info.error.status === 503) ||
    (days.error instanceof ApiError && days.error.status === 503);
  const trend = () => {
    const was = f().ratioWeekAgo;
    const is = props.torrent.ratio;
    if (was === null || is === null) return dash;
    const d = is - was;
    return `${d >= 0 ? "+" : "−"}${Math.abs(d).toFixed(2)} in the last 7 days`;
  };
  const remove = async () => {
    setDeleting(false);
    try {
      await unwrap(
        api.DELETE("/api/v1/stats/torrents/{hash}", { params: { path: { hash: hash() } } }),
      );
      toast.success("History deleted");
      void client.invalidateQueries({ queryKey: keys.stats() });
    } catch (e) {
      toast.error(`Delete history: ${e instanceof ApiError ? e.message : "failed"}`);
    }
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2.5 px-4 pt-3 pb-4">
      <TabHeading torrent={props.torrent} />
      <Show
        when={!unavailable()}
        fallback={
          <p class="m-0 py-6 text-center text-sm text-subtle">
            Statistics are unavailable: the statistics database could not be opened.
          </p>
        }
      >
        <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-auto pt-1">
          <Show when={info.data?.enabled === false}>
            <p class="m-0 rounded-md border border-divider px-3 py-2 text-sm text-muted-foreground">
              Recording is off: nothing new is kept.{" "}
              <A href="/settings/statistics" class="underline">
                Statistics settings
              </A>
            </p>
          </Show>
          <div class="grid grid-cols-3 gap-2">
            <Figure label="Uploaded · 30 d">{formatBytes(f().uploaded30)}</Figure>
            <Figure label="Seeding · 30 d">{f().seeded30} of 30 d</Figure>
            <Figure
              label="Swarm completed"
              title={
                f().completed === null
                  ? "Scrapes report it; they run with the scrape interval set in the statistics settings."
                  : undefined
              }
            >
              {f().completed === null ? dash : formatCount(f().completed ?? 0)}
            </Figure>
          </div>

          <section aria-label="Seeding days" class="flex flex-col gap-1.5">
            <SectionHead title="Seeding days · last 12 weeks">
              <span class="truncate mono text-2xs text-subtle">upload per day · UTC</span>
            </SectionHead>
            <Show
              when={cells().length > 0}
              fallback={
                <p class="m-0 flex h-[112px] items-center justify-center rounded-md border border-dashed border-border text-sm text-subtle">
                  <Switch>
                    <Match when={days.isPending}>Reading the days…</Match>
                    <Match
                      when={
                        days.error instanceof ApiError && days.error.status !== 404
                          ? days.error
                          : null
                      }
                    >
                      {(e) => <span class="text-danger">{e().message}</span>}
                    </Match>
                    <Match when={true}>
                      No day recorded yet: the first comes within a minute of running.
                    </Match>
                  </Switch>
                </p>
              }
            >
              <Heatmap cells={cells()} now={now()} />
            </Show>
            <div class="flex items-center gap-2.5 text-2xs text-subtle">
              <span>none</span>
              <span class="flex gap-0.5" aria-hidden="true">
                <For each={[0, 1, 2, 3, 4] as Level[]}>
                  {(l) => (
                    <span class="size-2.5 rounded-[2px]" style={{ background: LEVEL_FILL[l] }} />
                  )}
                </For>
              </span>
              <span>a copy or more</span>
              <span class="flex-1" />
              <span class="flex items-center gap-1">
                <span class="size-2.5 rounded-[2px] border border-dashed border-faint" />
                not seeding
              </span>
            </div>
          </section>

          <section aria-label="Traffic, last 24 hours" class="flex flex-col gap-1.5">
            <SectionHead title="Traffic · last 24 h">
              <span class="flex gap-2.5 text-2xs text-muted-foreground">
                <span class="flex items-center gap-1">
                  <span class="size-1.5 rounded-full bg-brand" />
                  down
                </span>
                <span class="flex items-center gap-1">
                  <span class="size-1.5 rounded-full bg-upload" />
                  up
                </span>
              </span>
            </SectionHead>
            <Traffic buckets={buckets()} />
          </section>

          <dl class="m-0 flex flex-col border-t border-divider pt-2">
            <Prop label="Recorded since">
              {f().since === null ? dash : formatShortDate(f().since, UTC)}
            </Prop>
            <Prop label="Best day">
              <Show when={f().best} fallback={dash}>
                {(b) => (
                  <>
                    {formatBytes(b().uploaded)} up{" "}
                    <span class="text-subtle">· {formatShortDate(b().t, UTC)}</span>
                  </>
                )}
              </Show>
            </Prop>
            <Prop label="Ratio trend">{trend()}</Prop>
          </dl>
          <div class="flex justify-end gap-1.5">
            <Button as={A} href={`/stats/timeline?hash=${hash()}`} variant="outline" size="xs">
              Open in Timeline
            </Button>
            <Button
              variant="outline"
              size="xs"
              class={cn("text-danger")}
              disabled={list().length === 0 && (traffic.data?.points.length ?? 0) === 0}
              onClick={() => setDeleting(true)}
            >
              Delete history
            </Button>
          </div>
        </div>
      </Show>
      <AlertDialog open={deleting()} onOpenChange={(o) => !o && setDeleting(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this torrent's history?</AlertDialogTitle>
            <AlertDialogDescription>
              Its traffic, days, places and events go from the statistics. The torrent stays, and
              recording goes on from now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose as={Button} variant="outline">
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" onClick={() => void remove()}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
