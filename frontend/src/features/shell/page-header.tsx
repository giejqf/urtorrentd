// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import Menu from "lucide-solid/icons/menu";
import type { JSX } from "solid-js";

import { Button } from "~/components/ui/button";

import { useShell } from "./protected";

/** A page's 48px top bar: the title, a count, and the page's actions. */
export function PageHeader(props: { title: string; count?: JSX.Element; children?: JSX.Element }) {
  const shell = useShell();
  return (
    <div class="flex h-12 flex-none items-center gap-2 border-b border-divider px-4">
      <Button
        variant="ghost"
        size="icon"
        class="-ml-1.5 lg:hidden"
        aria-label="Open navigation"
        onClick={() => shell.openNav()}
      >
        <Menu />
      </Button>
      <h1 class="m-0 truncate text-base font-semibold">{props.title}</h1>
      {props.count}
      <div class="flex-1" />
      {props.children}
    </div>
  );
}
