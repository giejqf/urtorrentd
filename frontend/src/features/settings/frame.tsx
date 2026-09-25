// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// A settings page: the 48px bar (breadcrumb, restart banner), then the
// page in a 760px column, and room for the unsaved-changes bar.

import Menu from "lucide-solid/icons/menu";
import { type JSX, Show } from "solid-js";

import { Button } from "~/components/ui/button";
import { useShell } from "~/features/shell/protected";

import { RestartBanner } from "./restart";

export function SettingsFrame(props: {
  title: string;
  description?: string;
  children?: JSX.Element;
  /** Floats over the bottom of the page (the unsaved-changes bar). */
  overlay?: JSX.Element;
}) {
  const shell = useShell();
  return (
    <main class="relative flex min-w-0 flex-1 flex-col">
      <div class="flex h-12 flex-none items-center gap-2.5 border-b border-divider px-4">
        <Button
          variant="ghost"
          size="icon"
          class="-ml-1.5 lg:hidden"
          aria-label="Open navigation"
          onClick={() => shell.openNav()}
        >
          <Menu />
        </Button>
        <span class="font-semibold">Settings</span>
        <span class="text-sm text-subtle" aria-hidden="true">
          ›
        </span>
        <span class="font-medium text-muted-foreground">{props.title}</span>
        <div class="flex-1" />
        <RestartBanner />
      </div>
      <div class="flex min-h-0 flex-1 flex-col items-center overflow-auto px-4 pt-7 pb-[120px]">
        <div class="flex w-full max-w-[760px] flex-col gap-7">
          <div class="flex flex-col gap-1">
            <h1 class="m-0 text-xl font-semibold tracking-[-0.01em]">{props.title}</h1>
            <Show when={props.description}>
              <p class="m-0 text-sm text-subtle">{props.description}</p>
            </Show>
          </div>
          {props.children}
        </div>
      </div>
      {props.overlay}
    </main>
  );
}
