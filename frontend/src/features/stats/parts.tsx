// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The reports' pieces, at the design's density: the range (presets and
// days picked), cards, KPIs, horizontal bars and legends.

import { useSearchParams } from "@solidjs/router";
import CalendarDays from "lucide-solid/icons/calendar-days";
import ChevronDown from "lucide-solid/icons/chevron-down";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";

import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { Segmented } from "~/features/settings/controls";
import { formatChange, localDay } from "~/lib/format";
import { cn } from "~/lib/utils";

import { datesLabel, type Preset, type Range, type RangeParams } from "./range";

/** The range's presets and a button to pick days (`?from=&to=`). */
export function RangeBar(props: {
  presets: readonly { value: Preset; label: string }[];
  range: Range;
  now: number;
}) {
  const [, setParams] = useSearchParams<RangeParams>();
  return (
    <>
      <Segmented
        label="Range"
        options={props.presets}
        value={(props.range.preset ?? "") as Preset}
        onChange={(v) => setParams({ range: v, from: undefined, to: undefined })}
      />
      <DaysPicker range={props.range} now={props.now} />
    </>
  );
}

function DaysPicker(props: { range: Range; now: number }) {
  const [, setParams] = useSearchParams<RangeParams>();
  const [open, setOpen] = createSignal(false);
  const [from, setFrom] = createSignal("");
  const [to, setTo] = createSignal("");
  const today = () => localDay(props.now);
  const bad = () => from() === "" || to() === "" || from() > to();
  return (
    <Popover
      open={open()}
      onOpenChange={(o) => {
        if (o) {
          setFrom(localDay(props.range.from));
          setTo(localDay(props.range.to));
        }
        setOpen(o);
      }}
      placement="bottom-end"
    >
      <PopoverTrigger as={Button} variant="outline" size="sm" aria-label="Pick days">
        <CalendarDays />
        <span class="mono">{datesLabel(props.range.from, props.range.to)}</span>
      </PopoverTrigger>
      <PopoverContent class="flex w-64 flex-col gap-3">
        <PopoverTitle class="text-base font-semibold">Pick days</PopoverTitle>
        <div class="grid grid-cols-2 gap-2">
          <label class="flex flex-col gap-1 text-xs text-muted-foreground">
            From
            <input
              type="date"
              class="h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground [color-scheme:dark]"
              value={from()}
              max={today()}
              onInput={(e) => setFrom(e.currentTarget.value)}
            />
          </label>
          <label class="flex flex-col gap-1 text-xs text-muted-foreground">
            To
            <input
              type="date"
              class="h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground [color-scheme:dark]"
              value={to()}
              max={today()}
              onInput={(e) => setTo(e.currentTarget.value)}
            />
          </label>
        </div>
        <p class="m-0 text-xs text-subtle">Whole days in your time zone, both included.</p>
        <Button
          size="sm"
          disabled={bad()}
          onClick={() => {
            setParams({ range: undefined, from: from(), to: to() });
            setOpen(false);
          }}
        >
          Show these days
        </Button>
      </PopoverContent>
    </Popover>
  );
}

/** A report's card: a title, what it shows, and its controls. */
export function Card(props: {
  title: string;
  sub?: JSX.Element;
  actions?: JSX.Element;
  /** The content runs to the card's edges (a table). */
  flush?: boolean;
  class?: string;
  children: JSX.Element;
}) {
  return (
    <section
      aria-label={props.title}
      class={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border border-divider bg-card py-3.5",
        props.flush ? "pb-1" : "px-4",
        props.class,
      )}
    >
      <div class={cn("flex min-h-7 items-start justify-between gap-3", props.flush && "px-4")}>
        <div class="flex min-w-0 flex-col">
          <h2 class="m-0 text-base font-semibold">{props.title}</h2>
          <Show when={props.sub}>
            <span class="truncate text-xs text-subtle">{props.sub}</span>
          </Show>
        </div>
        <Show when={props.actions}>
          <div class="flex flex-none items-center gap-2">{props.actions}</div>
        </Show>
      </div>
      {props.children}
    </section>
  );
}

/** `184.2 GB` as a big number with a small unit. */
export function Amount(props: { text: string }) {
  const parts = () => {
    const i = props.text.lastIndexOf(" ");
    return i < 0 ? [props.text, ""] : [props.text.slice(0, i), props.text.slice(i + 1)];
  };
  return (
    <>
      {parts()[0]}
      <Show when={parts()[1]}>
        <span class="ml-1 text-base font-medium text-muted-foreground">{parts()[1]}</span>
      </Show>
    </>
  );
}

/** A key figure: an optional label above, the value, and a line below. */
export function Kpi(props: {
  label?: JSX.Element;
  dot?: string;
  value: JSX.Element;
  sub?: JSX.Element;
  tone?: "danger";
}) {
  return (
    <div class="flex min-w-0 flex-col gap-1 rounded-xl border border-divider bg-card px-4 py-3.5">
      <Show when={props.label}>
        <span class="flex items-center gap-2 text-xs text-muted-foreground">
          <Show when={props.dot}>
            <span class={cn("size-1.5 flex-none rounded-full", props.dot)} aria-hidden="true" />
          </Show>
          {props.label}
        </span>
      </Show>
      <span
        class={cn(
          "text-[22px] leading-tight font-semibold tracking-tight",
          props.tone === "danger" && "text-danger",
        )}
      >
        {props.value}
      </span>
      <Show when={props.sub}>
        <span class="flex min-w-0 items-center gap-1.5 text-xs text-subtle">{props.sub}</span>
      </Show>
    </div>
  );
}

/** A change against the range before: green up, red down. */
export function Change(props: { fraction: number | null; words: string | null }) {
  return (
    <Show
      when={props.fraction !== null && props.words !== null}
      fallback={props.words === null ? "" : `— vs ${props.words}`}
    >
      <span
        class={cn(
          "mono",
          (props.fraction ?? 0) > 0.005
            ? "text-online"
            : (props.fraction ?? 0) < -0.005 && "text-danger",
        )}
      >
        {formatChange(props.fraction ?? 0)}
      </span>
      <span class="truncate">vs {props.words}</span>
    </Show>
  );
}

/** A name over a bar, and its value. */
export function HBar(props: {
  label: JSX.Element;
  value: string;
  /** 0 to 1 of the track. */
  fill: number;
  color: string;
  title?: string;
}) {
  return (
    <li class="grid grid-cols-[minmax(0,1fr)_72px] items-center gap-3 text-sm" title={props.title}>
      <div class="flex min-w-0 flex-col gap-1.5">
        <span class="truncate">{props.label}</span>
        <div class="h-2 overflow-hidden rounded-xs bg-accent">
          <div
            class={cn("h-full rounded-xs", props.color)}
            style={{ width: `${Math.max(0, Math.min(1, props.fill)) * 100}%` }}
          />
        </div>
      </div>
      <span class="text-right mono">{props.value}</span>
    </li>
  );
}

/** Colour swatches with names. */
export function Legend(props: {
  items: readonly { label: string; color: string; faint?: boolean }[];
}) {
  return (
    <ul class="m-0 flex list-none flex-wrap items-center gap-x-3 gap-y-1 p-0 text-xs text-muted-foreground">
      <For each={props.items}>
        {(i) => (
          <li class={cn("flex items-center gap-1.5", i.faint && "text-subtle")}>
            <span
              class={cn("size-2.5 flex-none rounded-[3px]", i.faint && "opacity-35")}
              style={{ background: `var(${i.color})` }}
              aria-hidden="true"
            />
            {i.label}
          </li>
        )}
      </For>
    </ul>
  );
}

/** A line of a chart's tooltip: swatch, name, value. */
export function TipRow(props: { color: string; label: string; value: string }) {
  return (
    <span class="flex items-center justify-between gap-4">
      <span class="flex items-center gap-2">
        <span
          class="size-2 rounded-[2px]"
          style={{ background: `var(${props.color})` }}
          aria-hidden="true"
        />
        {props.label}
      </span>
      <span class="mono">{props.value}</span>
    </span>
  );
}

/** Nothing to show yet, said plainly. */
export function Empty(props: { children: JSX.Element }) {
  return (
    <p class="m-0 flex flex-1 items-center justify-center py-6 text-center text-sm text-subtle">
      {props.children}
    </p>
  );
}

const segButton = (on: boolean) =>
  cn(
    "h-6 rounded-[5px] px-2.5 text-sm font-medium whitespace-nowrap transition-colors focus-visible:shadow-focus focus-visible:outline-none",
    on ? "bg-border text-foreground" : "text-muted-foreground hover:text-foreground",
  );

/** All torrents, or one picked from a list with a filter. */
export function TorrentPicker(props: {
  options: readonly { hash: string; name: string; meta?: string }[];
  value: string | null;
  onChange: (hash: string | null) => void;
}) {
  const [open, setOpen] = createSignal(false);
  const [filter, setFilter] = createSignal("");
  const chosen = () => props.options.find((o) => o.hash === props.value);
  const shown = createMemo(() => {
    const f = filter().trim().toLowerCase();
    return props.options.filter((o) => o.name.toLowerCase().includes(f)).slice(0, 100);
  });
  return (
    <div
      role="group"
      aria-label="Torrents"
      class="flex flex-none gap-0.5 rounded-lg border border-border p-[3px]"
    >
      <button
        type="button"
        aria-pressed={props.value === null}
        class={segButton(props.value === null)}
        onClick={() => props.onChange(null)}
      >
        All torrents
      </button>
      <Popover open={open()} onOpenChange={setOpen} placement="bottom-end">
        <PopoverTrigger
          as="button"
          type="button"
          aria-pressed={props.value !== null}
          class={cn(segButton(props.value !== null), "flex max-w-[260px] items-center gap-1.5")}
        >
          <span class="truncate">
            {chosen()?.name ?? (props.value ? props.value.slice(0, 12) : "Torrent…")}
          </span>
          <ChevronDown size={12} />
        </PopoverTrigger>
        <PopoverContent class="flex w-80 flex-col gap-2 p-2">
          <PopoverTitle class="sr-only">Pick a torrent</PopoverTitle>
          <input
            type="search"
            aria-label="Filter torrents"
            placeholder="Filter torrents"
            class="h-8 rounded-md border border-input bg-transparent px-2 text-sm text-foreground placeholder:text-subtle"
            value={filter()}
            onInput={(e) => setFilter(e.currentTarget.value)}
          />
          <ul
            class="m-0 flex max-h-72 list-none flex-col overflow-auto p-0"
            aria-label="Torrents to pick"
          >
            <For
              each={shown()}
              fallback={<li class="px-2 py-1.5 text-sm text-subtle">No torrent matches.</li>}
            >
              {(o) => (
                <li>
                  <button
                    type="button"
                    class={cn(
                      "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent",
                      o.hash === props.value && "bg-selected",
                    )}
                    onClick={() => {
                      props.onChange(o.hash);
                      setOpen(false);
                    }}
                  >
                    <span class="truncate">{o.name}</span>
                    <Show when={o.meta}>
                      <span class="flex-none mono text-xs text-subtle">{o.meta}</span>
                    </Show>
                  </button>
                </li>
              )}
            </For>
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  );
}

/** Save text as a file the browser downloads. */
export function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** A file name's time part: `202609261041` (the viewer's zone). */
export function fileStamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}`;
}
