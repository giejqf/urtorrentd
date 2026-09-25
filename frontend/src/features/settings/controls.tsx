// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The settings design's pieces: titled groups of rows, a row with its
// label, description and control, number fields with a unit, the unsaved
// mark, and the floating save bar.

import { For, type JSX, Show } from "solid-js";

import { Kbd } from "~/components/kbd";
import { StatusDot } from "~/components/status-dot";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

export function SettingsGroup(props: {
  title: string;
  aside?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <section aria-label={props.title} class="flex flex-col gap-2.5">
      <div class="flex items-baseline justify-between gap-4">
        <h2 class="m-0 text-md font-semibold">{props.title}</h2>
        <Show when={props.aside}>
          <span class="text-sm text-subtle">{props.aside}</span>
        </Show>
      </div>
      <div class="flex flex-col rounded-tile border border-divider bg-card">{props.children}</div>
    </section>
  );
}

/** The mark of a setting changed but not saved. */
export function ChangeDot() {
  return (
    <>
      <span aria-hidden="true" class="ml-2 inline-block size-1.5 flex-none rounded-full bg-warn" />
      <span class="sr-only"> (not saved)</span>
    </>
  );
}

export function SettingRow(props: {
  label: JSX.Element;
  /** The control's id, so the label names it. */
  for?: string;
  description?: JSX.Element;
  changed?: boolean;
  error?: string;
  children: JSX.Element;
  class?: string;
}) {
  return (
    <div
      class={cn(
        "flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-accent px-4 py-3 last:border-b-0",
        props.class,
      )}
    >
      <div class="flex min-w-[240px] flex-1 basis-0 flex-col gap-0.5">
        <Show
          when={props.for}
          fallback={
            <span class="flex items-center text-base font-medium">
              {props.label}
              <Show when={props.changed}>
                <ChangeDot />
              </Show>
            </span>
          }
        >
          <label for={props.for} class="flex items-center text-base font-medium">
            {props.label}
            <Show when={props.changed}>
              <ChangeDot />
            </Show>
          </label>
        </Show>
        <Show when={props.description}>
          <span class="text-sm text-subtle">{props.description}</span>
        </Show>
        <Show when={props.error}>
          <span class="text-sm text-danger" role="alert">
            {props.error}
          </span>
        </Show>
      </div>
      {props.children}
    </div>
  );
}

/** A number with its unit, right-aligned (the design's `.in`). */
export function UnitInput(props: {
  id: string;
  value: string;
  onInput: (v: string) => void;
  unit?: string;
  placeholder?: string;
  changed?: boolean;
  invalid?: boolean;
  class?: string;
  align?: "right" | "center";
  inputMode?: "decimal" | "numeric" | "text";
  /** A name of its own, when the row's label names another control. */
  label?: string;
}) {
  return (
    <div
      class={cn(
        "flex h-8 w-[150px] flex-none items-center overflow-hidden rounded-md border bg-background focus-within:shadow-focus",
        props.invalid
          ? "border-danger"
          : props.changed
            ? "border-warn"
            : "border-border focus-within:border-ring",
        props.class,
      )}
    >
      <input
        id={props.id}
        aria-label={props.label}
        class={cn(
          "h-full w-full min-w-0 bg-transparent px-2.5 mono text-sm text-foreground outline-none placeholder:text-subtle",
          props.align === "center" ? "text-center" : "text-right",
        )}
        inputMode={props.inputMode ?? "decimal"}
        placeholder={props.placeholder}
        value={props.value}
        aria-invalid={props.invalid ? "true" : undefined}
        spellcheck={false}
        onInput={(e) => props.onInput(e.currentTarget.value)}
      />
      <Show when={props.unit}>
        <span class="flex h-full flex-none items-center border-l border-border bg-card px-2.5 text-xs whitespace-nowrap text-subtle">
          {props.unit}
        </span>
      </Show>
    </div>
  );
}

/** Toggle chips (the design's days). */
export function Chips<T extends string>(props: {
  label: string;
  options: readonly { value: T; label: string }[];
  selected: readonly T[];
  onChange: (next: T[]) => void;
}) {
  return (
    <div role="group" aria-label={props.label} class="flex flex-wrap gap-1">
      <For each={props.options}>
        {(o) => {
          const on = () => props.selected.includes(o.value);
          return (
            <button
              type="button"
              aria-pressed={on()}
              class={cn(
                "inline-flex h-[26px] min-w-[38px] items-center justify-center rounded-md border px-2 text-sm font-medium transition-colors",
                on()
                  ? "border-primary bg-primary text-primary-foreground"
                  : "border-border text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
              onClick={() =>
                props.onChange(
                  on()
                    ? props.selected.filter((v) => v !== o.value)
                    : props.options
                        .map((x) => x.value)
                        .filter((v) => v === o.value || props.selected.includes(v)),
                )
              }
            >
              {o.label}
            </button>
          );
        }}
      </For>
    </div>
  );
}

/** The floating bar that says what is not saved yet. */
export function SaveBar(props: {
  names: readonly string[];
  error: string | null;
  busy: boolean;
  onDiscard: () => void;
  onSave: () => void;
}) {
  const mac = () => /Mac|iPhone|iPad/.test(navigator.platform);
  return (
    <Show when={props.names.length > 0 || props.error}>
      <div
        role="region"
        aria-label="Unsaved changes"
        class="absolute bottom-5 left-1/2 flex max-w-[calc(100%-2rem)] -translate-x-1/2 items-center gap-3 rounded-xl border border-border bg-accent/90 py-2 pr-2 pl-4 shadow-card backdrop-blur-sm"
      >
        <StatusDot class={props.error ? "bg-danger" : "bg-warn"} />
        <span class="font-medium whitespace-nowrap">
          {props.names.length === 1 ? "1 unsaved change" : `${props.names.length} unsaved changes`}
        </span>
        <span
          class={cn("min-w-0 truncate mono text-sm", props.error ? "text-danger" : "text-subtle")}
          title={props.error ?? props.names.join(" · ")}
        >
          {props.error ?? props.names.join(" · ")}
        </span>
        <span class="h-5 w-px flex-none bg-border" aria-hidden="true" />
        <Button variant="ghost" size="sm" onClick={() => props.onDiscard()}>
          Discard
        </Button>
        <Button
          size="sm"
          disabled={props.busy || props.error !== null}
          onClick={() => props.onSave()}
        >
          {props.busy ? "Saving…" : "Save changes"}
          <Kbd class="border-primary-foreground/20 bg-transparent text-faint">
            {mac() ? "⌘S" : "Ctrl S"}
          </Kbd>
        </Button>
      </div>
    </Show>
  );
}
