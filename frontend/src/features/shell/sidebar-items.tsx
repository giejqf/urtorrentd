// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The sidebar's rows and sections, shared by every screen's part of it: a
// filter with its count, a titled section with an action beside its title,
// and a row with its menu beside it (feeds, categories, tags).

import Ellipsis from "lucide-solid/icons/ellipsis";
import Plus from "lucide-solid/icons/plus";
import { type JSX, Show } from "solid-js";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { formatCount } from "~/lib/format";
import { cn } from "~/lib/utils";

export function FilterItem(props: {
  label: JSX.Element;
  /** A number, or a word ("off"); nothing when absent. */
  count?: number | string;
  active: boolean;
  onClick: () => void;
  title?: string;
  /** The count as a pill: something unread. */
  strong?: boolean;
  /** Levels of nesting (folders). */
  indent?: number;
  class?: string;
}) {
  return (
    <button
      type="button"
      class={cn(
        "flex h-7 w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 text-left text-base transition-colors",
        props.active
          ? "bg-selected text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
        props.class,
      )}
      aria-pressed={props.active}
      title={props.title}
      style={props.indent ? { "padding-left": `${8 + props.indent * 14}px` } : undefined}
      onClick={() => props.onClick()}
    >
      <span class="flex min-w-0 items-center gap-2">{props.label}</span>
      <Show when={props.count !== undefined}>
        <span
          class={cn(
            "flex-none mono text-xs",
            props.strong
              ? "min-w-[18px] rounded-full bg-border px-1.5 text-center text-foreground"
              : props.active
                ? "text-muted-foreground"
                : "text-subtle",
          )}
        >
          {typeof props.count === "number" ? formatCount(props.count) : props.count}
        </span>
      </Show>
    </button>
  );
}

export function Section(props: { title: string; action?: JSX.Element; children: JSX.Element }) {
  return (
    <section aria-label={props.title}>
      <div class="flex items-center justify-between px-2 pt-2.5 pb-1">
        <h2 class="m-0 text-xs font-medium text-subtle">{props.title}</h2>
        {props.action}
      </div>
      {props.children}
    </section>
  );
}
/** A section's "+" beside its title. */
export function SectionAdd(props: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      class="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={() => props.onClick()}
    >
      <Plus size={12} stroke-width={2.5} />
    </button>
  );
}

/** A filter row with its menu beside it, shown on hover or focus. */
export function MenuRow(props: {
  indent?: number;
  active: boolean;
  label: JSX.Element;
  count?: number | string;
  /** The count as a pill: something unread. */
  strong?: boolean;
  title?: string;
  menuLabel: string;
  onSelect: () => void;
  menu: JSX.Element;
}) {
  return (
    <div class="group relative">
      <FilterItem
        label={props.label}
        count={props.count}
        strong={props.strong}
        title={props.title}
        indent={props.indent}
        active={props.active}
        onClick={() => props.onSelect()}
        class="pr-8"
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          as="button"
          aria-label={props.menuLabel}
          class="absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md bg-sidebar text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 data-[expanded]:opacity-100"
        >
          <Ellipsis size={14} />
        </DropdownMenuTrigger>
        <DropdownMenuContent class="w-48">{props.menu}</DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
