// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import Menu from "lucide-solid/icons/menu";
import { type JSX, Show } from "solid-js";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { useShell } from "./protected";

/**
 * A page's 48px top bar: the title, a count, and the page's actions. On a
 * phone (Torrents — phone) it is 52px with 44px buttons and a 16px title,
 * `sub` under the title instead of the count, and actions that do not fit
 * go to a second line.
 */
export function PageHeader(props: {
  title: string;
  count?: JSX.Element;
  /** A phone's line under the title ("seedbox-01 · 12 torrents"). */
  sub?: JSX.Element;
  /** On a phone, no line under it (what follows has its own). */
  flush?: boolean;
  children?: JSX.Element;
}) {
  const shell = useShell();
  return (
    <div
      class={cn(
        "flex h-12 flex-none items-center gap-2 border-b border-divider px-4 max-sm:h-auto max-sm:min-h-[52px] max-sm:flex-wrap max-sm:gap-1 max-sm:px-2 max-sm:py-1",
        props.flush && "max-sm:border-b-0",
      )}
    >
      <Button
        variant="ghost"
        size="icon"
        class="-ml-1.5 max-sm:ml-0 max-sm:size-11 lg:hidden"
        aria-label="Open navigation"
        onClick={() => shell.openNav()}
      >
        <Menu class="max-sm:size-5" />
      </Button>
      <div class="flex min-w-0 flex-col max-sm:max-w-[60vw] max-sm:pl-1">
        <h1 class="m-0 truncate text-base font-semibold max-sm:text-[16px] max-sm:leading-[1.2]">
          {props.title}
        </h1>
        <Show when={props.sub}>
          <span class="truncate mono text-xs text-subtle sm:hidden">{props.sub}</span>
        </Show>
      </div>
      <span class={props.sub ? "contents max-sm:hidden" : "contents"}>{props.count}</span>
      <div class="flex-1" />
      {props.children}
    </div>
  );
}
