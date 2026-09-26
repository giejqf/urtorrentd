// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Several torrents chosen: the panel that acts on all of them (what they
// add up to, actions, the queue, and what to set for all: category, tags,
// upload limit, share limits, location, automatic management), and the
// selection bar over the list. Everything applies at once; a value they do
// not share shows as mixed, never as one of theirs.

import ChevronDown from "lucide-solid/icons/chevron-down";
import X from "lucide-solid/icons/x";
import { createEffect, createMemo, createSignal, For, type JSX, on, Show } from "solid-js";

import type { Schemas } from "~/api/client";
import { PromptDialog } from "~/components/prompt-dialog";
import { StatusDot } from "~/components/status-dot";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Switch, SwitchControl, SwitchLabel } from "~/components/ui/switch";
import { UnitInput } from "~/features/settings/controls";
import { kbText, parseKb } from "~/features/settings/speed-form";
import { useLive } from "~/features/shell/live";
import { formatBytes, formatCount, formatRate, formatRatio } from "~/lib/format";
import { categoryTone, stateLook, toneBg } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { actions } from "./actions";
import { bulk, statesLine } from "./bulk";
import { useTorrentDialogs } from "./torrent-dialogs";

type Row = Schemas["TorrentSummary"];

/** Torrents named in the panel at most; the rest are counted. */
const LISTED = 8;
const MIXED = "\u0000mixed";

function useRows(hashes: () => readonly string[]) {
  const live = useLive();
  return createMemo(() =>
    hashes().flatMap((h) => {
      const t = live.state.torrents[h];
      return t ? [t] : [];
    }),
  );
}

/** Category for all: the radio shows theirs when they share one. */
export function CategoryItems(props: {
  hashes: readonly string[];
  current: string | null | undefined;
  onNew: () => void;
}) {
  const live = useLive();
  const names = createMemo(() => Object.keys(live.state.categories).sort());
  return (
    <>
      <DropdownMenuRadioGroup
        value={props.current === undefined ? MIXED : (props.current ?? "")}
        onChange={(v) => void actions.category(props.hashes, v === "" ? null : v)}
      >
        <DropdownMenuRadioItem value="" closeOnSelect>
          No category
        </DropdownMenuRadioItem>
        <For each={names()}>
          {(name) => (
            <DropdownMenuRadioItem value={name} closeOnSelect>
              {name}
            </DropdownMenuRadioItem>
          )}
        </For>
      </DropdownMenuRadioGroup>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => props.onNew()}>New category…</DropdownMenuItem>
    </>
  );
}

/** Tags for all: checked when every one has it, half when some do. */
export function TagItems(props: {
  hashes: readonly string[];
  counts: readonly [string, number][];
  count: number;
  onNew: () => void;
}) {
  const live = useLive();
  const all = createMemo(() =>
    [...new Set([...live.state.tags, ...props.counts.map(([t]) => t)])].sort((a, b) =>
      a.localeCompare(b),
    ),
  );
  const has = (tag: string) => props.counts.find(([t]) => t === tag)?.[1] ?? 0;
  return (
    <>
      <For each={all()}>
        {(tag) => (
          <DropdownMenuCheckboxItem
            checked={has(tag) === props.count}
            indeterminate={has(tag) > 0 && has(tag) < props.count}
            closeOnSelect={false}
            onChange={(on) => void actions.tags(props.hashes, on ? "add" : "remove", [tag])}
          >
            {tag}
          </DropdownMenuCheckboxItem>
        )}
      </For>
      <Show when={all().length > 0}>
        <DropdownMenuSeparator />
      </Show>
      <DropdownMenuItem onSelect={() => props.onNew()}>New tag…</DropdownMenuItem>
    </>
  );
}

export const QUEUE_MOVES = [
  { to: "top", label: "Top" },
  { to: "up", label: "Up" },
  { to: "down", label: "Down" },
  { to: "bottom", label: "Bottom" },
] as const;

/** New category and new tag, asked for and applied to all. */
function usePrompts(hashes: () => readonly string[]) {
  const [creating, setCreating] = createSignal<"category" | "tag" | null>(null);
  const dialogs = () => (
    <>
      <PromptDialog
        open={creating() === "category"}
        title="New category"
        label="Name"
        action="Create and set"
        onClose={() => setCreating(null)}
        onSubmit={(name) => void actions.category(hashes(), name)}
      />
      <PromptDialog
        open={creating() === "tag"}
        title="New tag"
        label="Tag"
        action="Create and add"
        onClose={() => setCreating(null)}
        onSubmit={(tag) => void actions.tags(hashes(), "add", [tag])}
      />
    </>
  );
  return { ask: setCreating, dialogs };
}

export function SelectionBar(props: { hashes: readonly string[]; onClear: () => void }) {
  const rows = useRows(() => props.hashes);
  const b = createMemo(() => bulk(rows()));
  const dialogs = useTorrentDialogs();
  const prompts = usePrompts(() => props.hashes);
  const item = "h-7 border-0 px-2.5";
  return (
    <div class="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
      <div
        role="toolbar"
        aria-label="Selected torrents"
        class="pointer-events-auto flex h-11 max-w-full items-center gap-1.5 overflow-x-auto rounded-xl border border-border bg-accent/95 pr-2 pl-3.5 shadow-card backdrop-blur-sm"
      >
        <span class="flex items-center gap-2 pr-1 whitespace-nowrap">
          <span class="text-sm font-medium">{formatCount(b().count)} selected</span>
          <span class="mono text-xs text-muted-foreground">{formatBytes(b().size)}</span>
        </span>
        <span class="h-[18px] w-px flex-none bg-border" aria-hidden="true" />
        <Button
          variant="ghost"
          size="sm"
          class={item}
          onClick={() => void actions.start(props.hashes)}
        >
          Start
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class={item}
          onClick={() => void actions.stop(props.hashes)}
        >
          Stop
        </Button>
        <Button
          variant="ghost"
          size="sm"
          class={item}
          onClick={() => void actions.recheck(props.hashes)}
        >
          Recheck
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger as={Button} variant="ghost" size="sm" class={item}>
            Category <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent class="min-w-48">
            <CategoryItems
              hashes={props.hashes}
              current={b().category}
              onNew={() => prompts.ask("category")}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger as={Button} variant="ghost" size="sm" class={item}>
            Tags <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent class="min-w-44">
            <TagItems
              hashes={props.hashes}
              counts={b().tags}
              count={b().count}
              onNew={() => prompts.ask("tag")}
            />
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger as={Button} variant="ghost" size="sm" class={item}>
            Queue <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent class="min-w-36">
            <For each={QUEUE_MOVES}>
              {(q) => (
                <DropdownMenuItem onSelect={() => void actions.queue(props.hashes, q.to)}>
                  Move to {q.label.toLowerCase()}
                </DropdownMenuItem>
              )}
            </For>
          </DropdownMenuContent>
        </DropdownMenu>
        <span class="h-[18px] w-px flex-none bg-border" aria-hidden="true" />
        <Button
          variant="outline"
          size="sm"
          class="h-7 border-danger/40 text-danger hover:bg-danger/10 hover:text-danger"
          onClick={() => dialogs.remove(props.hashes)}
        >
          Remove…
        </Button>
        <Button
          variant="ghost"
          size="icon"
          class="size-[26px]"
          aria-label="Clear the selection"
          onClick={() => props.onClear()}
        >
          <X />
        </Button>
      </div>
      {prompts.dialogs()}
    </div>
  );
}

function Figure(props: { label: string; value: string; class?: string }) {
  return (
    <div class="flex min-w-0 flex-col gap-0.5 rounded-lg border border-divider px-2.5 py-2">
      <span class="truncate text-xs text-subtle">{props.label}</span>
      <span class={cn("truncate mono text-base", props.class)}>{props.value}</span>
    </div>
  );
}

function SetRow(props: { label: string; for?: string; children: JSX.Element }) {
  return (
    <div class="flex min-h-9 items-center justify-between gap-3 text-sm">
      <Show when={props.for} fallback={<span class="text-foreground-2">{props.label}</span>}>
        <label for={props.for} class="text-foreground-2">
          {props.label}
        </label>
      </Show>
      {props.children}
    </div>
  );
}

export function BulkPanel(props: {
  hashes: readonly string[];
  /** Torrents shown in the list, for Select all. */
  shown: number;
  onSelectAll: () => void;
  onClear: () => void;
  class?: string;
}) {
  const rows = useRows(() => props.hashes);
  const b = createMemo(() => bulk(rows()));
  const dialogs = useTorrentDialogs();
  const prompts = usePrompts(() => props.hashes);
  const h = () => props.hashes;
  const [limit, setLimit] = createSignal("");
  // Only a new shared limit resets the field: the rows change every second
  // (rates), and what is being typed stays.
  const shared = createMemo(() => b().uploadLimit);
  createEffect(on(shared, (v) => setLimit(v === undefined ? "" : kbText(v))));
  const applyLimit = () => {
    const text = limit();
    if (b().uploadLimit === undefined && text.trim() === "") return;
    const v = parseKb(text);
    if (v === undefined || v === b().uploadLimit) return;
    void actions.limits(h(), { upload_limit: v });
  };
  const shareValue = () => b().share ?? MIXED;
  const actionButton = "h-7 justify-start";
  return (
    <section
      aria-label={`${formatCount(b().count)} torrents selected`}
      class={cn("flex min-h-0 flex-col bg-card", props.class)}
    >
      <div class="flex h-12 flex-none items-center gap-1 border-b border-divider pr-3 pl-4">
        <span class="text-sm text-subtle">{formatCount(b().count)} torrents selected</span>
        <span class="flex-1" />
        <Show when={props.shown > b().count}>
          <Button variant="outline" size="xs" onClick={() => props.onSelectAll()}>
            Select all {formatCount(props.shown)}
          </Button>
        </Show>
        <Button variant="outline" size="xs" onClick={() => props.onClear()}>
          Clear
        </Button>
      </div>
      <div class="flex min-h-0 flex-1 flex-col gap-[18px] overflow-auto p-4">
        <div class="flex flex-col gap-2">
          <div class="grid grid-cols-3 gap-2">
            <Figure label="On disk" value={formatBytes(b().onDisk)} />
            <Figure
              label="Uploading"
              value={b().uploadRate > 0 ? `↑ ${formatRate(b().uploadRate)}` : "—"}
              class={b().uploadRate > 0 ? "text-upload" : undefined}
            />
            <Figure label="Avg ratio" value={formatRatio(b().avgRatio)} />
          </div>
          <ul class="m-0 flex list-none flex-col p-0" aria-label="Chosen torrents">
            <For each={rows().slice(0, LISTED)}>
              {(t: Row) => (
                <li class="flex h-[26px] items-center gap-2 text-sm">
                  <StatusDot class={toneBg[stateLook(t).tone]} />
                  <span class="min-w-0 flex-1 truncate">{t.name}</span>
                  <span class="flex-none mono text-xs text-subtle">{formatBytes(t.size)}</span>
                </li>
              )}
            </For>
            <Show when={rows().length > LISTED}>
              <li class="flex h-[26px] items-center text-sm text-subtle">
                and {formatCount(rows().length - LISTED)} more
              </li>
            </Show>
          </ul>
          <p class="m-0 text-sm text-subtle">
            {statesLine(b().states)} · {b().categories.length === 1 ? "category" : "categories"}{" "}
            {b()
              .categories.map((c) => c ?? "none")
              .join(", ")}
            <Show when={b().tags.length > 0}>
              {" "}
              · tags{" "}
              {b()
                .tags.map(([t]) => t)
                .join(", ")}
            </Show>
          </p>
        </div>

        <section aria-label="Actions" class="flex flex-col gap-1.5">
          <h3 class="m-0 section-label">
            Actions on {b().count === 2 ? "both" : b().count === 3 ? "all three" : "all"}
          </h3>
          <div class="grid grid-cols-2 gap-1.5">
            <Button
              variant="outline"
              size="sm"
              class={actionButton}
              onClick={() => void actions.start(h())}
            >
              Start
            </Button>
            <Button
              variant="outline"
              size="sm"
              class={actionButton}
              onClick={() => void actions.stop(h())}
            >
              Stop
            </Button>
            <Button
              variant="outline"
              size="sm"
              class={actionButton}
              onClick={() => void actions.recheck(h())}
            >
              Recheck
            </Button>
            <Button
              variant="outline"
              size="sm"
              class={actionButton}
              onClick={() => void actions.reannounce(h())}
            >
              Reannounce
            </Button>
            <Button
              variant="outline"
              size="sm"
              class={actionButton}
              onClick={() => void actions.forceStart(h(), true)}
            >
              Force start
            </Button>
            <Button
              variant="outline"
              size="sm"
              class={cn(
                actionButton,
                "border-danger/40 text-danger hover:bg-danger/10 hover:text-danger",
              )}
              onClick={() => dialogs.remove(h())}
            >
              Remove…
            </Button>
          </div>
        </section>

        <section aria-label="Queue" class="flex flex-col gap-1.5">
          <h3 class="m-0 section-label">Queue</h3>
          <div class="flex gap-0.5 self-start rounded-md border border-border p-0.5">
            <For each={QUEUE_MOVES}>
              {(q) => (
                <button
                  type="button"
                  class="h-[22px] rounded-sm px-2 text-xs font-medium text-muted-foreground hover:bg-border hover:text-foreground"
                  aria-label={`Move to the ${q.label.toLowerCase()} of the queue`}
                  onClick={() => void actions.queue(h(), q.to)}
                >
                  {q.label}
                </button>
              )}
            </For>
          </div>
        </section>

        <section aria-label="Set for all" class="flex flex-col">
          <h3 class="m-0 mb-1 section-label">Set for all</h3>
          <SetRow label="Category">
            <DropdownMenu>
              <DropdownMenuTrigger
                as={Button}
                variant="outline"
                size="sm"
                class="w-[170px] justify-between"
                aria-label={`Category: ${b().category === undefined ? "mixed" : (b().category ?? "none")}. Change`}
              >
                <Show
                  when={b().category !== undefined}
                  fallback={<span class="text-subtle">mixed · choose…</span>}
                >
                  <span class="flex min-w-0 items-center gap-1.5">
                    <StatusDot class={categoryTone(b().category ?? null)} />
                    <span class="truncate">{b().category ?? "None"}</span>
                  </span>
                </Show>
                <ChevronDown class="text-subtle" />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="min-w-48">
                <CategoryItems
                  hashes={h()}
                  current={b().category}
                  onNew={() => prompts.ask("category")}
                />
              </DropdownMenuContent>
            </DropdownMenu>
          </SetRow>
          <SetRow label="Tags">
            <span class="flex max-w-[260px] flex-wrap items-center justify-end gap-1">
              <For each={b().tags}>
                {([tag, n]) => (
                  <Badge class="gap-1 pr-0.5">
                    {tag}
                    <Show when={n < b().count}>
                      <span class="text-subtle">
                        · {formatCount(n)} of {formatCount(b().count)}
                      </span>
                    </Show>
                    <button
                      type="button"
                      class="flex size-3.5 items-center justify-center rounded-sm text-subtle hover:text-foreground"
                      aria-label={`Remove tag ${tag} from all`}
                      onClick={() => void actions.tags(h(), "remove", [tag])}
                    >
                      <X size={10} />
                    </button>
                  </Badge>
                )}
              </For>
              <DropdownMenu>
                <DropdownMenuTrigger as={Button} variant="outline" size="xs" class="h-5 px-1.5">
                  Add to all
                </DropdownMenuTrigger>
                <DropdownMenuContent class="min-w-44">
                  <TagItems
                    hashes={h()}
                    counts={b().tags}
                    count={b().count}
                    onNew={() => prompts.ask("tag")}
                  />
                </DropdownMenuContent>
              </DropdownMenu>
            </span>
          </SetRow>
          <SetRow label="Upload limit" for="bulk-upload-limit">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                applyLimit();
              }}
            >
              <UnitInput
                id="bulk-upload-limit"
                class="h-[30px]"
                value={limit()}
                unit="kB/s"
                placeholder={b().uploadLimit === undefined ? "mixed" : "∞"}
                inputMode="numeric"
                invalid={parseKb(limit()) === undefined}
                onInput={setLimit}
              />
            </form>
          </SetRow>
          <SetRow label="Share limits">
            <div
              role="radiogroup"
              aria-label="Share limits for all"
              class="flex gap-0.5 rounded-md border border-border p-0.5"
            >
              <For
                each={
                  [
                    ["global", "Global"],
                    ["unlimited", "∞"],
                    ["own", "Own…"],
                  ] as const
                }
              >
                {([value, label]) => (
                  <button
                    type="button"
                    role="radio"
                    aria-checked={shareValue() === value}
                    class={cn(
                      "h-[22px] rounded-sm px-2 text-xs font-medium",
                      shareValue() === value
                        ? "bg-border text-foreground"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                    onClick={() => {
                      if (value === "own") dialogs.shareLimits(h());
                      else
                        void actions.shareLimits(h(), {
                          ratio: { mode: value },
                          seeding_time: { mode: value },
                          inactive_seeding_time: { mode: value },
                          action: null,
                        });
                    }}
                  >
                    {label}
                  </button>
                )}
              </For>
            </div>
          </SetRow>
          <SetRow label="Location">
            <Button variant="outline" size="sm" onClick={() => dialogs.move(h())}>
              Move all…
            </Button>
          </SetRow>
          <SetRow label="Automatic management">
            <span class="flex items-center gap-2">
              <Show when={b().autoManagement === undefined}>
                <span class="text-xs text-subtle">mixed</span>
              </Show>
              <Switch
                class="flex items-center"
                checked={b().autoManagement === true}
                onChange={(v) => void actions.autoManagement(h(), v)}
              >
                <SwitchLabel class="sr-only">Automatic management for all</SwitchLabel>
                <SwitchControl />
              </Switch>
            </span>
          </SetRow>
        </section>
      </div>
      {prompts.dialogs()}
    </section>
  );
}
