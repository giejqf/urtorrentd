// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The detail panel's "Pieces · availability" chart, drawn from the
// daemon's per-piece data (AGENTS.md 6.4).

import { createQuery } from "@tanstack/solid-query";
import { createMemo, For, Match, Show, Switch } from "solid-js";

import { api, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { formatCount, formatPieceSize } from "~/lib/format";

import { binPieces, type PieceChart } from "./pieces";

const W = 388;
const H = 100;
const TOP = 8;

function axis(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function Chart(props: { chart: PieceChart }) {
  const y = (v: number) => H - (Math.min(v, props.chart.max) / props.chart.max) * (H - TOP);
  const step = () => W / props.chart.bins.length;
  const swarm = () => {
    const pts = props.chart.bins.map(
      (b, i) => `${i === 0 ? "M" : "L"}${(i * step()).toFixed(1)} ${y(b.copies).toFixed(1)}`,
    );
    if (pts.length === 1) pts.push(`L${W} ${y(props.chart.bins[0]?.copies ?? 0).toFixed(1)}`);
    return `${pts.join(" ")} L${W} ${H} L0 ${H} Z`;
  };
  const label = () =>
    `${formatCount(props.chart.have)} of ${formatCount(props.chart.total)} pieces had; ` +
    `${props.chart.meanCopies.toFixed(1)} copies on average; ` +
    `${formatCount(props.chart.rareMissing)} rare pieces missing`;
  return (
    <svg
      viewBox={`0 0 ${W} 118`}
      class="block h-auto w-full overflow-visible"
      role="img"
      aria-label={label()}
    >
      <g class="fill-subtle mono" font-size="9">
        <line x1="0" x2={W} y1={TOP} y2={TOP} class="stroke-divider" />
        <text x="0" y={TOP - 2}>
          {axis(props.chart.max)} copies
        </text>
        <line
          x1="0"
          x2={W}
          y1={y(props.chart.max / 2)}
          y2={y(props.chart.max / 2)}
          class="stroke-divider"
        />
        <text x="0" y={y(props.chart.max / 2) - 2}>
          {axis(props.chart.max / 2)}
        </text>
        <line x1="0" x2={W} y1={H} y2={H} class="stroke-border" />
      </g>
      <path d={swarm()} class="fill-border stroke-faint" stroke-width="1" />
      <For each={props.chart.bins}>
        {(b, i) => (
          <Show when={b.have > 0}>
            <rect
              x={i() * step()}
              y={y(b.copies * b.have)}
              width={step() + 0.4}
              height={H - y(b.copies * b.have)}
              class="fill-brand"
            />
          </Show>
        )}
      </For>
      <For each={props.chart.bins}>
        {(b, i) => (
          <Show when={b.rare}>
            <rect
              x={i() * step()}
              y={Math.min(y(b.copies), H - 6)}
              width={step() + 0.4}
              height={Math.max(H - y(b.copies), 6)}
              class="fill-upload"
            />
          </Show>
        )}
      </For>
      <g class="fill-subtle mono" font-size="9">
        <text x="0" y="114">
          0
        </text>
        <text x={W} y="114" text-anchor="end">
          {formatCount(props.chart.total)}
        </text>
      </g>
    </svg>
  );
}

function Swatch(props: { class: string; label: string }) {
  return (
    <span class="flex items-center gap-[5px] text-xs text-muted-foreground">
      <span class={`size-2 flex-none rounded-[2px] ${props.class}`} aria-hidden="true" />
      {props.label}
    </span>
  );
}

export function PiecesChart(props: { torrent: Schemas["TorrentSummary"] }) {
  const hash = () => props.torrent.hash;
  const query = createQuery(() => ({
    queryKey: keys.torrentPart(hash(), "pieces"),
    queryFn: () =>
      unwrap(api.GET("/api/v1/torrents/{hash}/pieces", { params: { path: { hash: hash() } } })),
    enabled: props.torrent.has_metadata,
    refetchInterval: 2_000,
  }));
  const chart = createMemo(() => (query.data ? binPieces(query.data) : null));
  return (
    <section aria-label="Pieces and availability" class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <h3 class="m-0 section-label">Pieces · availability</h3>
        <div class="flex gap-2.5">
          <Swatch class="bg-brand" label="Have" />
          <Swatch class="border border-faint bg-border" label="Swarm" />
          <Swatch class="bg-upload" label="Rare" />
        </div>
      </div>
      <Switch>
        <Match when={!props.torrent.has_metadata}>
          <div class="flex h-[118px] items-center justify-center rounded-md border border-dashed border-border text-sm text-subtle">
            No metadata yet
          </div>
        </Match>
        <Match when={chart()}>{(c) => <Chart chart={c()} />}</Match>
        <Match when={query.isError}>
          <div class="flex h-[118px] items-center justify-center text-sm text-danger">
            The pieces could not be read.
          </div>
        </Match>
        <Match when={true}>
          <div class="h-[118px] animate-pulse rounded-md bg-muted" />
        </Match>
      </Switch>
      <div class="flex justify-between gap-2 mono text-xs text-subtle">
        <span>
          {formatCount(props.torrent.pieces_have)} / {formatCount(props.torrent.pieces_total)} ×{" "}
          {formatPieceSize(props.torrent.piece_size)}
        </span>
        <Show when={chart()}>
          {(c) => (
            <span>
              avg {c().meanCopies.toFixed(1)} copies
              <Show when={c().rareMissing > 0}>
                {" "}
                · {formatCount(c().rareMissing)} rare & missing
              </Show>
            </span>
          )}
        </Show>
      </div>
    </section>
  );
}
