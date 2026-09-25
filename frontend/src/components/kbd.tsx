// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import type { JSX } from "solid-js";

import { cn } from "~/lib/utils";

/** A key hint: `⌘K`. */
export function Kbd(props: { children: JSX.Element; class?: string }) {
  return (
    <kbd
      class={cn(
        "inline-flex h-[18px] items-center rounded-sm border border-border bg-muted px-[5px] mono text-2xs text-subtle",
        props.class,
      )}
    >
      {props.children}
    </kbd>
  );
}
