// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The add dialog's right column: what the daemon found out about each
// source (a preview for links, the parsed metadata for files). One source
// shows in full, the others as a line each; the numbers are the daemon's.

import { createMemo, For, type JSX, Match, Show, Switch } from "solid-js";

import { Checkbox, CheckboxLabel } from "~/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { dash, formatBytes, formatCount, formatPieceSize } from "~/lib/format";
import { trackerHost } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { NORMAL, priorityLabel, PRIORITIES, selectedSize, shortHash, urlHost } from "./form";
import type { Source, Sources } from "./sources";

/** Files listed at most; the rest keep their priority. */
const MAX_FILES = 300;

const CHIP: Record<Source["status"], { label: string; class: string }> = {
  fetching: { label: "fetching", class: "border-warn/30 bg-warn/10 text-warn" },
  ready: { label: "ready", class: "border-ok/30 bg-ok/10 text-ok" },
  failed: { label: "failed", class: "border-danger/30 bg-danger/10 text-danger" },
  duplicate: { label: "added already", class: "border-border bg-accent text-muted-foreground" },
  unpreviewed: { label: "no preview", class: "border-border bg-accent text-muted-foreground" },
};

export function StatusChip(props: { status: Source["status"] }) {
  return (
    <span
      class={cn(
        "inline-flex h-[22px] flex-none items-center rounded-md border px-2 text-sm whitespace-nowrap",
        CHIP[props.status].class,
      )}
    >
      {CHIP[props.status].label}
    </span>
  );
}

/** One line on where a source stands. */
function hint(s: Source): string {
  if (s.error) return s.error;
  switch (s.status) {
    case "fetching":
      if (s.kind === "file") return "Reading the file…";
      if (s.kind === "url" && s.hash === null)
        return `Downloading the .torrent from ${urlHost(s.text)}…`;
      return s.peers === null
        ? "Fetching the metadata…"
        : `Fetching the metadata · ${formatCount(s.peers)} peers connected`;
    case "ready":
      return `${formatCount(s.metadata?.files.length ?? 0)} files · ${formatBytes(s.metadata?.total_size ?? 0)}`;
    default:
      return "";
  }
}

function Fact(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex min-w-0 flex-col gap-0.5">
      <dt class="text-sm text-subtle">{props.label}</dt>
      <dd class="m-0 mono text-sm">{props.children}</dd>
    </div>
  );
}

function swarm(s: Source): string {
  if (s.swarmSeeds !== null || s.swarmLeechers !== null) {
    return `${formatCount(s.swarmSeeds ?? 0)} seeds · ${formatCount(s.swarmLeechers ?? 0)} leechers`;
  }
  if (s.status === "fetching" && s.peers !== null) return `${formatCount(s.peers)} connected`;
  return dash;
}

function Files(props: { source: Source; sources: Sources }) {
  const files = () => props.source.metadata?.files ?? [];
  const priority = (i: number) => props.source.priorities?.[i] ?? NORMAL;
  return (
    <section aria-label="Files" class="flex flex-col gap-1.5 border-t border-border pt-3.5">
      <div class="flex items-center justify-between">
        <h3 class="m-0 text-sm font-normal text-subtle">Files</h3>
        <span class="text-sm text-subtle">
          {formatBytes(selectedSize(files(), props.source.priorities))} selected
        </span>
      </div>
      <For each={files().slice(0, MAX_FILES)}>
        {(f, i) => (
          <div class="grid h-[30px] grid-cols-[18px_minmax(0,1fr)_72px_64px] items-center gap-2.5 text-sm">
            <Checkbox
              checked={priority(i()) > 0}
              onChange={(on) => props.sources.setPriority(props.source.key, i(), on ? NORMAL : 0)}
              class="[&_[data-kb-checkbox-control]]:size-3.5"
            >
              <CheckboxLabel class="sr-only">Download {f.path}</CheckboxLabel>
            </Checkbox>
            <span class="truncate mono" title={f.path}>
              {f.path
                .split("/")
                .slice(files().length > 1 ? 1 : 0)
                .join("/")}
            </span>
            <span class="text-right mono text-muted-foreground">{formatBytes(f.size)}</span>
            <DropdownMenu>
              <DropdownMenuTrigger
                as="button"
                type="button"
                class="truncate rounded-sm text-right text-muted-foreground hover:text-foreground disabled:opacity-50"
                disabled={priority(i()) === 0}
                aria-label={`Priority of ${f.path}: ${priorityLabel(priority(i()))}`}
              >
                {priorityLabel(priority(i()))}
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuRadioGroup
                  value={String(priority(i()))}
                  onChange={(v) => props.sources.setPriority(props.source.key, i(), Number(v))}
                >
                  <For each={PRIORITIES}>
                    {(p) => (
                      <DropdownMenuRadioItem value={String(p.value)} closeOnSelect>
                        {p.label}
                      </DropdownMenuRadioItem>
                    )}
                  </For>
                </DropdownMenuRadioGroup>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </For>
      <Show when={files().length > MAX_FILES}>
        <p class="m-0 text-sm text-subtle">
          And {formatCount(files().length - MAX_FILES)} more files, downloaded as they are.
        </p>
      </Show>
    </section>
  );
}

function Details(props: { source: Source; sources: Sources }) {
  const m = () => props.source.metadata;
  const trackers = createMemo(() => [
    ...new Set(
      (m()?.trackers ?? [])
        .flat()
        .map((u) => trackerHost(u))
        .filter((h): h is string => h !== null),
    ),
  ]);
  return (
    <>
      <div class="flex flex-col gap-1">
        <h3 class="m-0 text-[14px] leading-[1.3] font-semibold [overflow-wrap:anywhere]">
          {props.source.label}
        </h3>
        <Show when={props.source.hash}>
          {(h) => <span class="mono text-sm text-subtle">{shortHash(h())}</span>}
        </Show>
        <Show when={!m() || props.source.error}>
          <p
            class={cn(
              "m-0 text-sm",
              props.source.status === "failed" ? "text-danger" : "text-subtle",
            )}
          >
            {hint(props.source)}
          </p>
        </Show>
      </div>
      <Show when={m()}>
        {(meta) => (
          <>
            <dl class="m-0 grid grid-cols-2 gap-x-4 gap-y-2.5">
              <Fact label="Size">{formatBytes(meta().total_size)}</Fact>
              <Fact label="Files">{formatCount(meta().files.length)}</Fact>
              <Fact label="Pieces">
                {formatCount(meta().pieces)} × {formatPieceSize(meta().piece_size)}
              </Fact>
              <Fact label="Swarm">{swarm(props.source)}</Fact>
              <Fact label="Created by">{meta().created_by ?? dash}</Fact>
              <Fact label="Private">{meta().private ? "yes" : "no"}</Fact>
            </dl>
            <Show when={trackers().length > 0}>
              <div class="flex flex-col gap-1.5">
                <span class="text-sm text-subtle">Trackers</span>
                <div class="flex flex-wrap gap-1.5">
                  <For each={trackers()}>
                    {(h) => (
                      <span class="inline-flex h-6 items-center rounded-md border border-border bg-accent px-2 mono text-xs">
                        {h}
                      </span>
                    )}
                  </For>
                </div>
              </div>
            </Show>
            <Files source={props.source} sources={props.sources} />
          </>
        )}
      </Show>
    </>
  );
}

export function PreviewPanel(props: {
  sources: Sources;
  open: string | null;
  onOpen: (key: string) => void;
  onRemove: (key: string) => void;
  empty: JSX.Element;
}) {
  const shown = () =>
    props.sources.list.find((s) => s.key === props.open) ?? props.sources.list[0] ?? null;
  return (
    <div class="flex flex-col gap-3.5">
      <div class="flex items-center justify-between">
        <h2 class="m-0 text-sm font-medium tracking-[0.04em] text-muted-foreground uppercase">
          Preview
        </h2>
        <Show when={shown()}>{(s) => <StatusChip status={s().status} />}</Show>
      </div>
      <Switch>
        <Match when={shown()}>{(s) => <Details source={s()} sources={props.sources} />}</Match>
        <Match when={true}>{props.empty}</Match>
      </Switch>
      <For each={props.sources.list.filter((s) => s.key !== shown()?.key)}>
        {(s) => (
          <div class="flex flex-col gap-2.5 border-t border-border pt-3.5">
            <div class="flex items-center justify-between gap-2">
              <button
                type="button"
                class="min-w-0 truncate text-left text-sm font-medium hover:underline"
                onClick={() => props.onOpen(s.key)}
                title={s.label}
              >
                {s.label}
              </button>
              <div class="flex flex-none items-center gap-1.5">
                <StatusChip status={s.status} />
                <Show when={s.kind === "file"}>
                  <button
                    type="button"
                    class="inline-flex size-5 items-center justify-center rounded-sm text-subtle hover:text-foreground"
                    aria-label={`Remove ${s.label}`}
                    onClick={() => props.onRemove(s.key)}
                  >
                    ×
                  </button>
                </Show>
              </div>
            </div>
            <p
              class={cn(
                "m-0 line-clamp-3 text-sm [overflow-wrap:anywhere]",
                s.status === "failed" ? "text-danger" : "text-subtle",
              )}
              title={hint(s)}
            >
              {hint(s)}
            </p>
          </div>
        )}
      </For>
    </div>
  );
}
