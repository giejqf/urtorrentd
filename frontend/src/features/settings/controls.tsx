// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The settings design's pieces: titled groups of rows, a row with its
// label, description and control, number fields with a unit, the unsaved
// mark, and the floating save bar.

import { createSignal, For, type JSX, Show } from "solid-js";

import { Kbd } from "~/components/kbd";
import { StatusDot } from "~/components/status-dot";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch, SwitchControl } from "~/components/ui/switch";
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

/** A value with its unit, right-aligned (the design's `.in`); paths and URLs left-aligned. */
export function UnitInput(props: {
  id: string;
  value: string;
  onInput: (v: string) => void;
  unit?: string;
  placeholder?: string;
  changed?: boolean;
  invalid?: boolean;
  class?: string;
  align?: "right" | "center" | "left";
  inputMode?: "decimal" | "numeric" | "text" | "url";
  /** A name of its own, when the row's label names another control. */
  label?: string;
  /** Not in force (its switch is off): shown dimmed, still editable. */
  muted?: boolean;
  /** After the input, inside the box (a Browse button). */
  trailing?: JSX.Element;
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
          "h-full w-full min-w-0 bg-transparent px-2.5 mono text-sm outline-none placeholder:text-subtle",
          props.muted ? "text-subtle" : "text-foreground",
          props.align === "center"
            ? "text-center"
            : props.align === "left"
              ? "text-left"
              : "text-right",
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
      {props.trailing}
    </div>
  );
}

/** A unit chosen in a field's unit box (days, hours, minutes). */
export function UnitSelect<T extends string>(props: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  const labelOf = (v: T | undefined) => props.options.find((o) => o.value === v)?.label ?? "";
  return (
    <Select<T>
      options={props.options.map((o) => o.value)}
      value={props.value}
      onChange={(v) => v !== null && props.onChange(v)}
      itemComponent={(p) => <SelectItem item={p.item}>{labelOf(p.item.rawValue)}</SelectItem>}
    >
      <SelectTrigger
        aria-label={props.label}
        class="h-full w-auto flex-none gap-1.5 rounded-none border-0 border-l border-border bg-card px-2.5 text-xs whitespace-nowrap text-subtle focus-visible:shadow-focus"
      >
        <SelectValue<T>>{(s) => labelOf(s.selectedOption())}</SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
}

/** A switch named by its row's label (`SettingRow for="<id>-input"`: Kobalte's input id). */
export function RowSwitch(props: {
  id: string;
  checked: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <Switch
      id={props.id}
      class="flex flex-none items-center"
      checked={props.checked}
      onChange={props.onChange}
    >
      <SwitchControl />
    </Switch>
  );
}

/** One of a few choices (the design's `.seg`): a radio group of buttons. */
export function Segmented<T extends string>(props: {
  label: string;
  /** `danger`: a choice that destroys something, red when chosen. */
  options: readonly { value: T; label: string; danger?: boolean }[];
  value: T;
  onChange: (v: T) => void;
  changed?: boolean;
}) {
  const refs: HTMLButtonElement[] = [];
  const move = (from: number, by: number) => {
    const n = props.options.length;
    const i = (from + by + n) % n;
    const o = props.options[i];
    if (!o) return;
    props.onChange(o.value);
    refs[i]?.focus();
  };
  return (
    <div
      role="radiogroup"
      aria-label={props.label}
      class={cn(
        "flex flex-none gap-0.5 rounded-lg border p-[3px]",
        props.changed ? "border-warn" : "border-border",
      )}
    >
      <For each={props.options}>
        {(o, i) => {
          const on = () => props.value === o.value;
          return (
            <button
              ref={(el) => (refs[i()] = el)}
              type="button"
              role="radio"
              aria-checked={on()}
              tabIndex={on() ? 0 : -1}
              class={cn(
                "h-6 rounded-[5px] px-2.5 text-sm font-medium whitespace-nowrap transition-colors focus-visible:shadow-focus focus-visible:outline-none",
                on()
                  ? o.danger
                    ? "bg-danger/18 text-danger"
                    : "bg-border text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => props.onChange(o.value)}
              onKeyDown={(e) => {
                if (e.key === "ArrowRight" || e.key === "ArrowDown") {
                  e.preventDefault();
                  move(i(), 1);
                } else if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
                  e.preventDefault();
                  move(i(), -1);
                }
              }}
            >
              {o.label}
            </button>
          );
        }}
      </For>
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

/**
 * Values as removable chips, then a field that adds one (Enter, or leaving
 * it): file name patterns wrapped to the right, trackers one per line.
 * What `problem` refuses stays in the field with the reason under it.
 */
export function ChipList(props: {
  /** The field's id, for the row's label. */
  id: string;
  /** What a value is, for the remove buttons: "Remove pattern *.nfo". */
  what: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  problem: (value: string) => string | null;
  placeholder: string;
  layout: "wrap" | "stack";
  changed?: boolean;
}) {
  const [text, setText] = createSignal("");
  const [problem, setProblem] = createSignal<string | null>(null);
  const add = () => {
    const v = text().trim();
    if (v === "") return;
    const p = props.problem(v);
    if (p) {
      setProblem(p);
      return;
    }
    if (!props.values.includes(v)) props.onChange([...props.values, v]);
    setText("");
  };
  const stack = () => props.layout === "stack";
  return (
    <div
      class={cn(
        "flex flex-col gap-1.5",
        stack() ? "w-full max-w-[380px]" : "max-w-[340px] items-end",
      )}
    >
      <div class={cn("flex gap-1.5", stack() ? "flex-col" : "flex-wrap justify-end")}>
        <For each={props.values}>
          {(v) => (
            <span
              class={cn(
                "inline-flex min-w-0 items-center gap-1.5 rounded-md border border-border bg-muted pr-1 pl-2 mono text-sm",
                stack() ? "h-7 justify-between" : "h-6",
              )}
            >
              <span class="truncate" title={v}>
                {v}
              </span>
              <button
                type="button"
                class="inline-flex size-4 flex-none items-center justify-center rounded-sm text-subtle hover:bg-border hover:text-foreground"
                aria-label={`Remove ${props.what} ${v}`}
                onClick={() => props.onChange(props.values.filter((x) => x !== v))}
              >
                ×
              </button>
            </span>
          )}
        </For>
        <div
          class={cn(
            "flex items-center overflow-hidden rounded-md border bg-background focus-within:shadow-focus",
            problem() ? "border-danger" : "border-border focus-within:border-ring",
            stack() ? "h-7 w-full" : "h-6 w-[140px]",
          )}
        >
          <input
            id={props.id}
            class="h-full w-full min-w-0 bg-transparent px-2.5 mono text-xs text-foreground outline-none placeholder:text-subtle"
            placeholder={props.placeholder}
            value={text()}
            spellcheck={false}
            aria-invalid={problem() ? "true" : undefined}
            onInput={(e) => {
              setText(e.currentTarget.value);
              setProblem(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            onBlur={add}
          />
        </div>
      </div>
      <Show when={problem()}>
        <span class="text-sm text-danger" role="alert">
          {problem()}
        </span>
      </Show>
    </div>
  );
}
