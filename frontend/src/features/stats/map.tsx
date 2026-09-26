// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The world of the Peers & geo report: land as dots, the daemon, and a
// curve to each place its peers are, blue for data coming to us and orange
// for data going out, as wide as the flow against the largest. Without a
// place for the daemon there are no curves, only the peers' places.

import { createMemo, createUniqueId, For, Show } from "solid-js";

import { arc, countryPoint, type Flow, flowWidth } from "./peers-view";
import { LAND, STEP } from "./world";

export const MAP_W = 1140;
export const MAP_H = 450;

const COLS = 360 / STEP;
const CELL = MAP_W / COLS;

/** Every land cell as a zero-length stroke: one path, drawn as dots. */
const landPath = (() => {
  let d = "";
  LAND.forEach((row, r) => {
    for (let c = 0; c < COLS; c += 1) {
      const digit = parseInt(row[c >> 2] ?? "0", 16);
      if (digit & (8 >> (c & 3))) {
        d += `M${((c + 0.5) * CELL).toFixed(1)} ${((r + 0.5) * CELL).toFixed(1)}h0`;
      }
    }
  });
  return d;
})();

interface Curve {
  key: string;
  d: string;
  width: number;
  inbound: boolean;
}

interface Node {
  key: string;
  x: number;
  y: number;
  r: number;
  tone: "in" | "out" | "idle";
  label: string | null;
}

export function WorldMap(props: {
  /** What the map shows, for screen readers. */
  label: string;
  home: { country: string; label: string } | null;
  /** Largest first; at most `most` get curves. */
  flows: readonly Flow[];
  most: number;
  /** A curve per flow even when several share a country (peers), bent apart. */
  spread: boolean;
}) {
  const id = createUniqueId();
  const home = createMemo(() => {
    const h = props.home;
    const p = h ? countryPoint(h.country, MAP_W, MAP_H) : null;
    return h && p ? { x: p[0], y: p[1], label: h.label } : null;
  });
  const curves = createMemo(() => {
    const h = home();
    if (!h) return [];
    const shown = props.flows.slice(0, props.most);
    const most = Math.max(0, ...shown.flatMap((f) => [f.down, f.up]));
    const seen = new Map<string, number>();
    const out: Curve[] = [];
    for (const f of shown) {
      const p = countryPoint(f.country, MAP_W, MAP_H);
      if (!p) continue;
      const k = seen.get(f.country) ?? 0;
      seen.set(f.country, k + 1);
      const bend = 0.18 + (props.spread ? Math.min(k, 6) * 0.06 : 0);
      if (f.down > 0) {
        out.push({
          key: `${f.key}-in`,
          d: arc(p, [h.x, h.y], bend),
          width: flowWidth(f.down, most),
          inbound: true,
        });
      }
      if (f.up > 0) {
        out.push({
          key: `${f.key}-out`,
          d: arc([h.x, h.y], p, bend),
          width: flowWidth(f.up, most),
          inbound: false,
        });
      }
    }
    return out;
  });
  const nodes = createMemo(() => {
    const by = new Map<string, { down: number; up: number; peers: number }>();
    for (const f of props.flows) {
      const n = by.get(f.country) ?? { down: 0, up: 0, peers: 0 };
      n.down += f.down;
      n.up += f.up;
      n.peers += f.peers;
      by.set(f.country, n);
    }
    const out: Node[] = [];
    [...by].forEach(([country, n], i) => {
      const p = countryPoint(country, MAP_W, MAP_H);
      if (!p) return;
      out.push({
        key: country,
        x: p[0],
        y: p[1],
        r: 3 + Math.min(4, Math.sqrt(n.peers)),
        tone: n.down === 0 && n.up === 0 ? "idle" : n.down >= n.up ? "in" : "out",
        label: i < 8 ? country : null,
      });
    });
    return out;
  });
  const tone = { in: "var(--brand)", out: "var(--upload)", idle: "var(--subtle)" } as const;
  return (
    <svg
      viewBox={`0 0 ${MAP_W} ${MAP_H}`}
      class="block h-auto w-full"
      role="img"
      aria-label={props.label}
    >
      <defs>
        <marker
          id={`${id}-in`}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="8"
          markerHeight="8"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M0 0.5 8 4 0 7.5Z" fill="var(--brand)" />
        </marker>
        <marker
          id={`${id}-out`}
          viewBox="0 0 8 8"
          refX="7"
          refY="4"
          markerWidth="8"
          markerHeight="8"
          markerUnits="userSpaceOnUse"
          orient="auto"
        >
          <path d="M0 0.5 8 4 0 7.5Z" fill="var(--upload)" />
        </marker>
      </defs>
      <path
        d={landPath}
        fill="none"
        stroke="var(--border-strong)"
        stroke-opacity="0.55"
        stroke-width={CELL * 0.42}
        stroke-linecap="round"
      />
      <For each={curves()}>
        {(c) => (
          <g>
            <path
              d={c.d}
              fill="none"
              stroke={c.inbound ? "var(--brand)" : "var(--upload)"}
              stroke-opacity="0.22"
              stroke-width={c.width}
              stroke-linecap="round"
            />
            <path
              d={c.d}
              fill="none"
              class="map-flow"
              stroke={c.inbound ? "var(--brand)" : "var(--upload)"}
              stroke-width={c.width}
              stroke-linecap="round"
              marker-end={`url(#${id}-${c.inbound ? "in" : "out"})`}
            />
          </g>
        )}
      </For>
      <For each={nodes()}>
        {(n) => (
          <g>
            <circle
              cx={n.x}
              cy={n.y}
              r={n.r}
              fill="var(--card)"
              stroke={tone[n.tone]}
              stroke-width="2"
            />
            <Show when={n.label}>
              <text
                x={n.x}
                y={n.y + n.r + 11}
                font-size="10"
                fill="var(--muted-foreground)"
                text-anchor="middle"
              >
                {n.label}
              </text>
            </Show>
          </g>
        )}
      </For>
      <Show when={home()}>
        {(h) => (
          <g>
            <circle
              cx={h().x}
              cy={h().y}
              r="10"
              fill="none"
              stroke="var(--foreground)"
              stroke-width="1.5"
              class="map-pulse"
            />
            <circle
              cx={h().x}
              cy={h().y}
              r="6"
              fill="var(--foreground)"
              stroke="var(--background)"
              stroke-width="2"
            />
            <text
              x={h().x}
              y={h().y - 14}
              font-size="10"
              font-weight="600"
              fill="var(--foreground)"
              text-anchor="middle"
            >
              {h().label}
            </text>
          </g>
        )}
      </Show>
    </svg>
  );
}
