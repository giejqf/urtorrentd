// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { cn } from "~/lib/utils";

const R = 6.5;
const C = 2 * Math.PI * R;

/**
 * The list's 18px progress ring: `progress` (0 to 1) of the circle in the
 * state's colour (`class` sets the stroke, e.g. `stroke-brand`).
 */
export function ProgressRing(props: { progress: number; class?: string }) {
  const p = () => Math.min(Math.max(props.progress, 0), 1);
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" class="block" aria-hidden="true">
      <circle cx="9" cy="9" r={R} fill="none" class="stroke-border" stroke-width="2" />
      <circle
        cx="9"
        cy="9"
        r={R}
        fill="none"
        class={cn(props.class)}
        stroke-width="2"
        stroke-dasharray={`${(C * p()).toFixed(2)} ${(C * (1 - p()) + 1).toFixed(2)}`}
        stroke-linecap="round"
        transform="rotate(-90 9 9)"
        visibility={p() > 0 ? "visible" : "hidden"}
      />
    </svg>
  );
}
