// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The settings design's left panel: back to the torrents, the sections,
// and the daemon's versions and uptime.

import { A, useLocation } from "@solidjs/router";
import ChevronLeft from "lucide-solid/icons/chevron-left";
import { createSignal, For, onCleanup, Show } from "solid-js";

import { LogoMark } from "~/components/logo";
import { StatusDot } from "~/components/status-dot";
import { ConnectionDot, InstanceMenu } from "~/features/shell/sidebar";
import { formatDuration } from "~/lib/format";
import { cn } from "~/lib/utils";

import { useAppInfo } from "./app-info";
import { SECTIONS } from "./nav-sections";

export { type Section, SECTIONS } from "./nav-sections";

/** Seconds since the Unix epoch, ticking every half minute. */
function useNow() {
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));
  const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
  onCleanup(() => clearInterval(t));
  return now;
}

export function SettingsNav(props: { class?: string; onNavigate?: () => void }) {
  const location = useLocation();
  const app = useAppInfo();
  const now = useNow();
  const restart = () => (app.data?.restart_required.length ?? 0) > 0;
  return (
    <aside class={cn("min-h-0 flex-col bg-sidebar", props.class)} aria-label="Settings">
      <div class="flex h-12 flex-none items-center gap-2 px-3">
        <LogoMark />
        <InstanceMenu />
        <div class="flex-1" />
        <ConnectionDot />
      </div>
      <div class="flex-none px-2 pb-2">
        <A
          href="/torrents"
          class="flex h-[30px] items-center gap-2 rounded-md px-2 text-base font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => props.onNavigate?.()}
        >
          <ChevronLeft size={14} />
          Back to torrents
        </A>
      </div>
      <nav
        aria-label="Settings sections"
        class="flex min-h-0 flex-1 flex-col gap-px overflow-auto px-2"
      >
        <For each={SECTIONS}>
          {(section) => (
            <>
              <h2 class="m-0 px-2 pt-2.5 pb-1 text-xs font-medium text-subtle">{section.title}</h2>
              <For each={section.items}>
                {(item) => {
                  const href = `/settings/${item.id}`;
                  const active = () => location.pathname === href;
                  return (
                    <A
                      href={href}
                      class={cn(
                        "flex h-7 flex-none items-center gap-2 rounded-md px-2 text-base font-medium",
                        active()
                          ? "bg-selected text-foreground"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                      aria-current={active() ? "page" : undefined}
                      onClick={() => props.onNavigate?.()}
                    >
                      {item.label}
                      <Show when={item.id === "engine" && restart()}>
                        <span class="flex-1" />
                        <StatusDot class="bg-warn" />
                        <span class="sr-only"> (restart required)</span>
                      </Show>
                    </A>
                  );
                }}
              </For>
            </>
          )}
        </For>
      </nav>
      <div class="flex flex-none flex-col gap-1 border-t border-divider px-3 py-2.5 mono text-xs text-subtle">
        <Show when={app.data}>
          {(a) => (
            <>
              <span>
                urtorrentd {a().version} · API {a().api_version}
              </span>
              <span>
                {a().library} · up {formatDuration(Math.max(now() - a().started_at, 0))}
              </span>
            </>
          )}
        </Show>
      </div>
    </aside>
  );
}
