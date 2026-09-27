// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// A phone's tab bar (Torrents — phone): Torrents, Stats, Add, Search (the
// palette) and Settings. RSS and Log are in the sidebar, behind the menu.

import { A, useLocation } from "@solidjs/router";
import ChartLine from "lucide-solid/icons/chart-line";
import PanelsTopLeft from "lucide-solid/icons/panels-top-left";
import Plus from "lucide-solid/icons/plus";
import Search from "lucide-solid/icons/search";
import Settings from "lucide-solid/icons/settings";
import type { Component } from "solid-js";

import { cn } from "~/lib/utils";

import { useShell } from "./protected";

const tab =
  "flex h-14 flex-1 flex-col items-center justify-center gap-[3px] text-2xs font-medium text-subtle";

function Tab(props: { href: string; icon: Component<{ size?: number }>; label: string }) {
  const location = useLocation();
  const active = () => location.pathname.startsWith(props.href);
  return (
    <A
      href={props.href}
      class={cn(tab, active() && "text-foreground")}
      aria-current={active() ? "page" : undefined}
    >
      <props.icon size={20} />
      {props.label}
    </A>
  );
}

export function TabBar() {
  const shell = useShell();
  return (
    <nav
      aria-label="Sections"
      class="flex flex-none items-center border-t border-divider bg-card px-2 pb-[env(safe-area-inset-bottom)]"
    >
      <Tab href="/torrents" icon={PanelsTopLeft} label="Torrents" />
      <Tab href="/stats" icon={ChartLine} label="Stats" />
      <button type="button" class={tab} aria-label="Add torrents" onClick={() => shell.openAdd()}>
        <span class="flex size-11 items-center justify-center rounded-xl bg-primary text-primary-foreground">
          <Plus size={20} stroke-width={2.5} />
        </span>
      </button>
      <button type="button" class={tab} onClick={() => shell.openPalette()}>
        <Search size={20} />
        Search
      </button>
      <Tab href="/settings" icon={Settings} label="Settings" />
    </nav>
  );
}
