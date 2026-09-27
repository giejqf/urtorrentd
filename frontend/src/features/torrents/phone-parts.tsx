// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The torrents screen's phone parts (Torrents — phone): the status chips
// under the header and the transfer line over the tab bar.

import { For, Show } from "solid-js";

import { StatusDot } from "~/components/status-dot";
import { useLive } from "~/features/shell/live";
import { STATUS_DOTS } from "~/features/shell/sidebar";
import { formatBytes, formatCount, formatRate } from "~/lib/format";
import { cn } from "~/lib/utils";

import { type StatusFilter, STATUS_FILTERS } from "./view";

/** The statuses as chips: All, then those with torrents (and the one chosen). */
export function StatusChips(props: {
  status: StatusFilter;
  counts: Record<StatusFilter, number>;
  labels: Record<StatusFilter, string>;
  onPick: (s: StatusFilter) => void;
}) {
  const shown = () =>
    STATUS_FILTERS.filter((s) => s === "all" || props.counts[s] > 0 || s === props.status);
  return (
    <div
      role="radiogroup"
      aria-label="Status"
      class="flex flex-none [scrollbar-width:none] gap-2 overflow-x-auto px-4 pt-1 pb-3"
    >
      <For each={shown()}>
        {(s) => (
          <button
            type="button"
            role="radio"
            aria-checked={props.status === s}
            class={cn(
              "inline-flex h-8 flex-none items-center gap-1.5 rounded-full border px-3 text-[13px] font-medium whitespace-nowrap",
              props.status === s
                ? "border-primary bg-primary text-primary-foreground"
                : "border-border text-muted-foreground",
            )}
            onClick={() => props.onPick(s)}
          >
            <Show when={s !== "all"}>
              <StatusDot class={STATUS_DOTS[s]} />
            </Show>
            {props.labels[s]}
            <span class={cn("mono text-xs", props.status === s && "opacity-70")}>
              {formatCount(props.counts[s])}
            </span>
          </button>
        )}
      </For>
    </div>
  );
}

/** The session's rates, peers and free space, over the tab bar. */
export function TransferStrip() {
  const live = useLive();
  const t = () => live.state.transfer;
  return (
    <div class="flex h-7 flex-none items-center justify-between gap-2 border-t border-divider bg-card px-4 mono text-xs text-subtle">
      <span class="truncate">
        <span class="text-brand" aria-hidden="true">
          ↓
        </span>
        <span class="sr-only">Download</span> {formatRate(t()?.download_rate ?? 0)} ·{" "}
        <span class="text-upload" aria-hidden="true">
          ↑
        </span>
        <span class="sr-only">Upload</span> {formatRate(t()?.upload_rate ?? 0)}
      </span>
      <span class="truncate">
        {formatCount(t()?.peers ?? 0)} peers ·{" "}
        {t()?.free_space == null ? "—" : formatBytes(t()?.free_space ?? 0)} free
      </span>
    </div>
  );
}
