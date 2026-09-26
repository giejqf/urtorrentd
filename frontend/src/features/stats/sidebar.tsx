// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Stats screen's part of the sidebar, as the design has it: the
// reports (the range carries over), and what the statistics database holds.

import { A, useLocation } from "@solidjs/router";
import { For, Show } from "solid-js";

import { useStatsInfo } from "~/features/settings/app-info";
import { Section } from "~/features/shell/sidebar";
import { formatBytes, formatCount, formatShortDate } from "~/lib/format";
import { cn } from "~/lib/utils";

export const REPORTS = [
  { href: "/stats", label: "Overview" },
  { href: "/stats/trackers", label: "Trackers" },
  { href: "/stats/peers", label: "Peers & geo" },
  { href: "/stats/idle-seeds", label: "Idle seeds" },
  { href: "/stats/timeline", label: "Timeline" },
] as const;

export default function StatsSidebar(props: { onNavigate?: () => void }) {
  const location = useLocation();
  const info = useStatsInfo();
  const since = () => {
    const i = info.data;
    return i ? (i.oldest_day ?? i.oldest_hour ?? i.oldest_minute) : null;
  };
  return (
    <>
      <div class="flex min-h-0 flex-1 flex-col overflow-auto px-2 py-2">
        <Section title="Reports">
          <For each={REPORTS}>
            {(r) => {
              const on = () => location.pathname.replace(/\/$/, "") === r.href;
              return (
                <A
                  href={`${r.href}${location.search}`}
                  class={cn(
                    "flex h-7 w-full items-center rounded-md px-2 text-base transition-colors",
                    on()
                      ? "bg-selected text-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                  aria-current={on() ? "page" : undefined}
                  onClick={() => props.onNavigate?.()}
                >
                  {r.label}
                </A>
              );
            }}
          </For>
        </Section>
      </div>
      <A
        href="/settings/statistics"
        class="flex flex-none flex-col gap-1.5 border-t border-divider px-3 py-2.5 mono text-xs text-subtle hover:text-muted-foreground"
        onClick={() => props.onNavigate?.()}
      >
        <Show
          when={info.data}
          fallback={<span>{info.isError ? "statistics unavailable" : "statistics …"}</span>}
        >
          {(i) => (
            <>
              <div class="flex justify-between gap-2">
                <span>{i().enabled ? "recording" : "recording off"}</span>
                <span>{formatBytes(i().size)}</span>
              </div>
              <div class="flex justify-between gap-2">
                <span>{formatCount(i().torrents)} torrents</span>
                <Show when={since()} fallback={<span>nothing yet</span>}>
                  {(t) => <span>since {formatShortDate(t())}</span>}
                </Show>
              </div>
            </>
          )}
        </Show>
      </A>
    </>
  );
}
