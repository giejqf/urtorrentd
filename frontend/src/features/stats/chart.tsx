// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Time series on uPlot (AGENTS.md 2): lines over a light fill, or stacked
// bands, the design's axes and a tooltip for the bucket under the pointer.
// Colours come from the theme's variables; a bucket with no value is a gap.

import "uplot/dist/uPlot.min.css";

import { createEffect, createSignal, type JSX, onCleanup, onMount, Show } from "solid-js";
import uPlot from "uplot";

import { formatClock, formatShortDate, type TimeOptions } from "~/lib/format";
import { appliedTheme } from "~/lib/theme";

export interface ChartSeries {
  label: string;
  /** A CSS variable of the theme (`--brand`). */
  color: string;
  /** One per bucket; `null`: nothing recorded (a gap). */
  values: (number | null)[];
}

function cssVar(name: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === "" ? "#808089" : v;
}

/** A `#rrggbb` colour with an opacity. */
function alpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) return hex;
  return `rgb(${parseInt(m[1] ?? "0", 16)} ${parseInt(m[2] ?? "0", 16)} ${parseInt(m[3] ?? "0", 16)} / ${a})`;
}

/** The smallest round number (1, 2, 2.5, 5 × 10ⁿ) at or above `max`. */
export function roundUp(max: number): number {
  if (!(max > 0)) return 1;
  const mag = 10 ** Math.floor(Math.log10(max));
  for (const f of [1, 2, 2.5, 5, 10]) if (f * mag >= max) return f * mag;
  return 10 * mag;
}

/** Values with no neighbour on either side: a line cannot show them, so they get a dot. */
export function isolated(values: readonly (number | null | undefined)[]): number[] {
  const out: number[] = [];
  values.forEach((v, i) => {
    if (v === null || v === undefined) return;
    const before = i > 0 ? values[i - 1] : null;
    const after = i < values.length - 1 ? values[i + 1] : null;
    if ((before ?? null) === null && (after ?? null) === null) out.push(i);
  });
  return out;
}

/** An axis tick: the date at midnight, else the time (`Sep 21`, `18:00`). */
export function tickLabel(t: number, opts: TimeOptions = {}): string {
  const clock = formatClock(t, opts);
  return clock === "00:00" ? formatShortDate(t, opts) : clock;
}

/** Running totals, bottom series first: what stacked bands are drawn from. */
export function stacked(series: readonly (number | null)[][]): number[][] {
  const out: number[][] = [];
  let below: number[] = [];
  for (const s of series) {
    const next = s.map((v, i) => (below[i] ?? 0) + (v ?? 0));
    out.push(next);
    below = next;
  }
  return out;
}

export function TimeChart(props: {
  /** What the chart shows, for screen readers. */
  label: string;
  /** Bucket starts, unix seconds. */
  x: number[];
  series: ChartSeries[];
  stack?: boolean;
  height: number;
  /** The y axis's labels. */
  yLabel: (v: number) => string;
  /** The x axis's labels. */
  xLabel: (t: number) => string;
  /** The hovered bucket. */
  tooltip: (i: number) => JSX.Element;
  /** Series drawn faint (another one isolated). */
  faint?: (i: number) => boolean;
}) {
  let box!: HTMLDivElement;
  let plot: uPlot | undefined;
  const [hover, setHover] = createSignal<{ i: number; x: number; y: number } | null>(null);

  const build = () => {
    // Colours are copied from the tokens: built again for another theme.
    appliedTheme();
    plot?.destroy();
    setHover(null);
    const grid = cssVar("--grid-line");
    const axis = cssVar("--subtle");
    const card = cssVar("--card");
    const colors = props.series.map((s) => cssVar(s.color));
    const values = props.series.map((s) => s.values);
    const data: uPlot.AlignedData = [props.x, ...(props.stack ? stacked(values) : values)];
    const font = "11px 'Geist Mono Variable', ui-monospace, monospace";
    const top = Math.max(
      0,
      ...data.slice(1).flatMap((s) => (s as (number | null)[]).map((v) => v ?? 0)),
    );
    plot = new uPlot(
      {
        width: Math.max(box.clientWidth, 200),
        height: props.height,
        legend: { show: false },
        padding: [8, 8, 0, 0],
        cursor: {
          y: false,
          drag: { x: false, y: false, setScale: false },
          points: {
            size: 8,
            width: 2,
            stroke: () => card,
            fill: (_u, i) => colors[i - 1] ?? axis,
          },
        },
        scales: { x: { time: true }, y: { range: () => [0, roundUp(top)] } },
        axes: [
          {
            stroke: axis,
            font,
            grid: { show: false },
            ticks: { show: false },
            space: 64,
            values: (_u, splits) => splits.map((t) => props.xLabel(t)),
          },
          {
            stroke: axis,
            font,
            grid: { stroke: grid, width: 1 },
            ticks: { show: false },
            size: 52,
            space: 32,
            values: (_u, splits) => splits.map((v) => props.yLabel(v)),
          },
        ],
        series: [
          {},
          ...props.series.map((s, i) => {
            const c = colors[i] ?? axis;
            const dim = props.faint?.(i) ?? false;
            return {
              label: s.label,
              stroke: alpha(c, dim ? 0.15 : 0.9),
              width: props.stack ? 1.5 : 2,
              fill: alpha(c, dim ? 0.05 : props.stack ? 0.45 : 0.12),
              points: {
                show: true,
                size: 5,
                fill: alpha(c, dim ? 0.15 : 0.9),
                stroke: alpha(c, dim ? 0.15 : 0.9),
                filter: (u: uPlot, si: number) => isolated((u.data[si] ?? []) as (number | null)[]),
              },
              spanGaps: false,
            };
          }),
        ],
        bands: props.stack
          ? props.series.slice(1).map((_, i) => ({ series: [i + 2, i + 1] as [number, number] }))
          : [],
        hooks: {
          setCursor: [
            (u) => {
              const i = u.cursor.idx;
              const left = u.cursor.left ?? -1;
              if (i === null || i === undefined || left < 0) {
                setHover(null);
                return;
              }
              const o = u.over.getBoundingClientRect();
              const b = box.getBoundingClientRect();
              setHover({ i, x: o.left - b.left + left, y: o.top - b.top });
            },
          ],
        },
      },
      data,
      box,
    );
  };

  onMount(() => {
    const ro = new ResizeObserver(() => {
      if (plot && box.clientWidth > 0) {
        plot.setSize({ width: box.clientWidth, height: props.height });
      }
    });
    ro.observe(box);
    onCleanup(() => {
      ro.disconnect();
      plot?.destroy();
    });
  });
  createEffect(build);

  const flip = () => (hover()?.x ?? 0) > box.clientWidth - 200;
  return (
    <div class="relative" role="img" aria-label={props.label}>
      <div ref={box} class="w-full" onMouseLeave={() => setHover(null)} />
      <Show when={hover()}>
        {(h) => (
          <div
            class="pointer-events-none absolute z-10 min-w-[150px] rounded-lg border border-border bg-accent px-3 py-2 text-sm shadow-lg"
            style={{
              left: `${flip() ? h().x - 12 : h().x + 12}px`,
              top: `${h().y + 6}px`,
              transform: flip() ? "translateX(-100%)" : undefined,
            }}
          >
            {props.tooltip(h().i)}
          </div>
        )}
      </Show>
    </div>
  );
}
