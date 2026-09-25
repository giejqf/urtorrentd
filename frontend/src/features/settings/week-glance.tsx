// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// "Week at a glance": the hours the alternative limits are on, per day, as
// the daemon's schedule decides them (`schedule.ts`), and now.

import { createMemo, For, Index, Show } from "solid-js";

import { DAY_LABELS, weekGrid, WEEKDAYS, type Window } from "./schedule";

const X0 = 44;
const CW = 28;
const Y0 = 16;
const RH = 19;
const W = 26;
const H = 16;

/** Per cell: the covered minutes and where they start within the hour. */
function spans(w: Window): { start: number; minutes: number }[][] {
  const grid = weekGrid(w);
  return grid.map((row, day) =>
    row.map((n, hour) => {
      if (n === 0 || n === 60) return { start: 0, minutes: n };
      // Partial: the window starts or ends within this hour.
      const startsHere = w.from >= hour * 60 && w.from < hour * 60 + 60;
      const dayOn = w.days.length === 0 || w.days.includes(WEEKDAYS[day] ?? "mon");
      return { start: startsHere && dayOn ? w.from % 60 : 0, minutes: n };
    }),
  );
}

export function WeekGlance(props: {
  window: Window;
  hours: number;
  now: { day: number; minute: number } | null;
}) {
  const lit = createMemo(() => spans(props.window));
  const shadow = createMemo(() => weekGrid({ ...props.window, days: [] }));
  const active = (day: number) =>
    props.window.days.length === 0 || props.window.days.includes(WEEKDAYS[day] ?? "mon");
  const label = () =>
    `${props.hours} hours a week at the alternative limits, from ${props.window.days.length === 0 ? "every day" : props.window.days.map((d) => DAY_LABELS[d]).join(", ")}`;
  return (
    <svg viewBox="0 0 728 150" class="block h-auto w-full" role="img" aria-label={label()}>
      <g class="fill-subtle mono" font-size="10">
        <For each={[0, 4, 8, 12, 16, 20, 24]}>
          {(h) => (
            <text x={X0 + h * CW + (h === 24 ? 0 : 13)} y="10" text-anchor="middle">
              {String(h).padStart(2, "0")}
            </text>
          )}
        </For>
      </g>
      <Index each={WEEKDAYS}>
        {(d, day) => (
          <>
            <text
              x="0"
              y={Y0 + day * RH + 12}
              font-size="11"
              class={active(day) ? "fill-foreground-2" : "fill-faint"}
            >
              {DAY_LABELS[d()]}
            </text>
            <For each={Array.from({ length: 24 }, (_, h) => h)}>
              {(hour) => {
                const x = X0 + hour * CW;
                const y = Y0 + day * RH;
                const span = () => lit()[day]?.[hour] ?? { start: 0, minutes: 0 };
                const dim = () => (shadow()[day]?.[hour] ?? 0) > 0 && span().minutes === 0;
                return (
                  <>
                    <rect
                      x={x}
                      y={y}
                      width={W}
                      height={H}
                      rx="3"
                      class={
                        dim() ? "fill-brand/20 stroke-divider" : "fill-row-divider stroke-divider"
                      }
                    />
                    <Show when={span().minutes > 0}>
                      <rect
                        x={x + (W * span().start) / 60}
                        y={y}
                        width={(W * span().minutes) / 60}
                        height={H}
                        rx="3"
                        class="fill-brand stroke-brand"
                      />
                    </Show>
                  </>
                );
              }}
            </For>
          </>
        )}
      </Index>
      <Show when={props.now}>
        {(n) => (
          <line
            x1={X0 + (n().minute / 60) * CW}
            x2={X0 + (n().minute / 60) * CW}
            y1={Y0 + n().day * RH - 2}
            y2={Y0 + n().day * RH + RH - 1}
            class="stroke-foreground"
            stroke-opacity="0.8"
            stroke-dasharray="2 3"
          />
        )}
      </Show>
    </svg>
  );
}
