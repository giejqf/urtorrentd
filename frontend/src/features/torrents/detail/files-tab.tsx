// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Files tab: the torrent's files as a tree with their size, progress
// and priority; a checkbox downloads or skips a file or a folder; Priority
// sets the chosen rows (or every file), Rename the chosen one. Above, the
// pieces we have, and each file's span of them while there are few enough
// files for a lane each.

import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { createVirtualizer } from "@tanstack/solid-virtual";
import ChevronDown from "lucide-solid/icons/chevron-down";
import ChevronRight from "lucide-solid/icons/chevron-right";
import FolderIcon from "lucide-solid/icons/folder";
import { createMemo, createSignal, createUniqueId, For, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { PromptDialog } from "~/components/prompt-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox, CheckboxLabel } from "~/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Switch, SwitchControl, SwitchLabel } from "~/components/ui/switch";
import { dash, formatBytes, formatCount, formatPercent } from "~/lib/format";
import { cn } from "~/lib/utils";

import { actions } from "../actions";
import { priorityLabel, PRIORITIES } from "../add/form";
import {
  chosenIndexes,
  type FileRow,
  fileRows,
  filesSummary,
  nameProblem,
  pieceRuns,
  renamedPath,
  runsPath,
  shownRows,
  toggleWanted,
} from "./files";
import { TabHeading } from "./parts";

type TorrentSummary = Schemas["TorrentSummary"];

const W = 388;
/** Files with a lane of their own at most; more and only the whole bar shows. */
const MAX_LANES = 12;
const ROW = 34;
const CHOICES = [...PRIORITIES].reverse().map((p) => ({ value: p.value, label: p.label }));

function Lanes(props: {
  files: readonly Schemas["FileInfo"][];
  pieces: Schemas["PiecesResponse"];
}) {
  const hatch = createUniqueId();
  const total = () => props.pieces.states.length;
  const lanes = () =>
    props.files.length <= MAX_LANES && props.files.length > 1 ? props.files : [];
  const height = () => (lanes().length > 0 ? 12 + lanes().length * 8 : 8);
  const have = (first: number, last: number) =>
    pieceRuns(props.pieces.states, first, last, (s) => s === "have");
  const label = () => {
    const had = props.pieces.states.filter((s) => s === "have").length;
    return `${formatCount(had)} of ${formatCount(total())} pieces had`;
  };
  return (
    <svg
      viewBox={`0 0 ${W} ${height()}`}
      class="block h-auto w-full flex-none"
      role="img"
      aria-label={label()}
    >
      <defs>
        <pattern
          id={hatch}
          width="4"
          height="4"
          patternUnits="userSpaceOnUse"
          patternTransform="rotate(45)"
        >
          <rect width="1.5" height="4" class="fill-border-strong" />
        </pattern>
      </defs>
      <rect x="0" y="0" width={W} height="8" rx="2" class="fill-border" />
      <path d={runsPath(have(0, total() - 1), total(), W, 0, 8)} class="fill-brand" />
      <path
        d={runsPath(
          pieceRuns(props.pieces.states, 0, total() - 1, (s) => s === "downloading"),
          total(),
          W,
          0,
          8,
        )}
        class="fill-brand opacity-50"
      />
      <For each={lanes()}>
        {(f, k) => {
          const y = () => 12 + k() * 8;
          const x = () => (f.first_piece / Math.max(total(), 1)) * W;
          const w = () =>
            Math.max(2, ((f.last_piece + 1 - f.first_piece) / Math.max(total(), 1)) * W);
          return (
            <g>
              <title>{f.path}</title>
              <rect
                x={x()}
                y={y()}
                width={w()}
                height="5"
                rx="1.5"
                fill={f.priority === 0 ? `url(#${hatch})` : "var(--border)"}
              />
              <Show when={f.priority > 0}>
                <path
                  d={runsPath(have(f.first_piece, f.last_piece), total(), W, y(), 5)}
                  class="fill-brand"
                />
              </Show>
            </g>
          );
        }}
      </For>
    </svg>
  );
}

function PriorityMenu(props: {
  label: string;
  value: number;
  onChange: (priority: number) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        as="button"
        type="button"
        aria-label={props.label}
        class={cn(
          "flex h-[22px] w-[76px] items-center justify-between gap-1 rounded-[5px] border border-border bg-background px-1.5 text-xs hover:bg-accent",
          props.value === 0 ? "text-subtle" : props.value > 4 ? "text-warn" : "text-foreground-2",
        )}
      >
        <span class="truncate">{priorityLabel(props.value)}</span>
        <ChevronDown size={10} class="flex-none text-subtle" />
      </DropdownMenuTrigger>
      <DropdownMenuContent class="min-w-32">
        <DropdownMenuRadioGroup
          value={String(props.value)}
          onChange={(v) => props.onChange(Number(v))}
        >
          <For each={CHOICES}>
            {(c) => (
              <DropdownMenuRadioItem value={String(c.value)} closeOnSelect>
                {c.label}
              </DropdownMenuRadioItem>
            )}
          </For>
          <DropdownMenuRadioItem value="0" closeOnSelect>
            Skip
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function FilesTab(props: { torrent: TorrentSummary }) {
  const client = useQueryClient();
  const hash = () => props.torrent.hash;
  const files = createQuery(() => ({
    queryKey: keys.torrentPart(hash(), "files"),
    queryFn: () =>
      unwrap(api.GET("/api/v1/torrents/{hash}/files", { params: { path: { hash: hash() } } })),
    enabled: props.torrent.has_metadata,
    refetchInterval: 2_000,
  }));
  const pieces = createQuery(() => ({
    queryKey: keys.torrentPart(hash(), "pieces"),
    queryFn: () =>
      unwrap(api.GET("/api/v1/torrents/{hash}/pieces", { params: { path: { hash: hash() } } })),
    enabled: props.torrent.has_metadata,
    refetchInterval: 2_000,
  }));
  const list = () => files.data ?? [];
  const rows = createMemo(() => fileRows(list()));
  const [collapsed, setCollapsed] = createSignal<ReadonlySet<string>>(new Set());
  const shown = createMemo(() => shownRows(rows(), collapsed()));
  const byPath = createMemo(() => new Map(shown().map((r) => [r.path, r])));
  const [chosen, setChosen] = createSignal<ReadonlySet<string>>(new Set());
  const [renaming, setRenaming] = createSignal<FileRow | null>(null);
  let anchor: string | null = null;

  const chosenRows = () => rows().filter((r) => chosen().has(r.path));
  const target = () => {
    const picked = chosenIndexes(rows(), chosen());
    return picked.length > 0 ? picked : list().map((f) => f.index);
  };

  const refresh = () => {
    void client.invalidateQueries({ queryKey: keys.torrentPart(hash(), "files") });
    void client.invalidateQueries({ queryKey: keys.torrentPart(hash(), "pieces") });
  };
  const setPriority = async (indexes: number[], priority: number) => {
    if (indexes.length === 0) return;
    const key = keys.torrentPart(hash(), "files");
    const set = new Set(indexes);
    // Shown at once; the next read brings the daemon's.
    client.setQueryData<Schemas["FileInfo"][]>(key, (old) =>
      old?.map((f) => (set.has(f.index) ? { ...f, priority } : f)),
    );
    try {
      await unwrap(
        api.POST("/api/v1/torrents/{hash}/files/priority", {
          params: { path: { hash: hash() } },
          body: { indexes, priority },
        }),
      );
    } catch (e) {
      toast.error(`File priority: ${e instanceof ApiError ? e.message : "failed"}`);
    }
    refresh();
  };
  const rename = async (row: FileRow, name: string) => {
    const body = { old_path: row.path, new_path: renamedPath(row.path, name) };
    try {
      await unwrap(
        row.folder
          ? api.POST("/api/v1/torrents/{hash}/folders/rename", {
              params: { path: { hash: hash() } },
              body,
            })
          : api.POST("/api/v1/torrents/{hash}/files/rename", {
              params: { path: { hash: hash() } },
              body,
            }),
      );
      setChosen(new Set([body.new_path]));
    } catch (e) {
      toast.error(`Rename: ${e instanceof ApiError ? e.message : "failed"}`);
    }
    refresh();
  };

  /** A click picks one row (again: none), Ctrl or ⌘ adds or drops one, Shift a range. */
  const pick = (row: FileRow, e: MouseEvent) => {
    const order = shown().map((r) => r.path);
    if (e.shiftKey && anchor !== null && order.includes(anchor)) {
      const [i, j] = [order.indexOf(anchor), order.indexOf(row.path)];
      setChosen(new Set(order.slice(Math.min(i, j), Math.max(i, j) + 1)));
      return;
    }
    if (e.metaKey || e.ctrlKey) {
      const next = new Set(chosen());
      if (next.has(row.path)) next.delete(row.path);
      else next.add(row.path);
      setChosen(next);
    } else {
      const only = chosen().size === 1 && chosen().has(row.path);
      setChosen(new Set(only ? [] : [row.path]));
    }
    anchor = row.path;
  };
  const toggleFolder = (path: string) => {
    const next = new Set(collapsed());
    if (next.has(path)) next.delete(path);
    else next.add(path);
    setCollapsed(next);
  };

  let scroller: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer({
    get count() {
      return shown().length;
    },
    getScrollElement: () => scroller ?? null,
    estimateSize: () => ROW,
    getItemKey: (i) => shown()[i]?.path ?? i,
    overscan: 10,
  });

  const menuLabel = () => {
    const n = target().length;
    return chosen().size > 0
      ? `${formatCount(n)} chosen ${n === 1 ? "file" : "files"}`
      : `All ${formatCount(n)} ${n === 1 ? "file" : "files"}`;
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2.5 px-4 pt-3 pb-4">
      <TabHeading torrent={props.torrent} />
      <Show
        when={props.torrent.has_metadata}
        fallback={
          <p class="m-0 py-6 text-center text-sm text-subtle">
            The files are known once the metadata arrives.
          </p>
        }
      >
        <div class="flex flex-none items-center gap-1.5 pt-1">
          <span class="flex-1 truncate mono text-xs text-subtle" title={filesSummary(list())}>
            {filesSummary(list())}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger as={Button} variant="outline" size="xs">
              Priority <ChevronDown />
            </DropdownMenuTrigger>
            <DropdownMenuContent class="min-w-40">
              <DropdownMenuGroup>
                <DropdownMenuGroupLabel>{menuLabel()}</DropdownMenuGroupLabel>
                <For each={CHOICES}>
                  {(c) => (
                    <DropdownMenuItem onSelect={() => void setPriority(target(), c.value)}>
                      {c.label}
                    </DropdownMenuItem>
                  )}
                </For>
                <DropdownMenuItem onSelect={() => void setPriority(target(), 0)}>
                  Skip
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="xs"
            disabled={chosenRows().length !== 1}
            title={chosenRows().length === 1 ? undefined : "Choose one file or folder"}
            onClick={() => setRenaming(chosenRows()[0] ?? null)}
          >
            Rename
          </Button>
        </div>
        <Show when={pieces.data}>{(p) => <Lanes files={list()} pieces={p()} />}</Show>
        <div
          ref={scroller}
          class="relative min-h-0 flex-1 overflow-auto border-t border-divider"
          role="table"
          aria-label="Files"
          aria-rowcount={shown().length + 1}
        >
          <div
            role="row"
            class="sticky top-0 z-10 grid h-[26px] grid-cols-[16px_minmax(0,1fr)_60px_72px_76px] items-center gap-2 bg-card px-1 text-xs text-subtle"
          >
            <span role="columnheader">
              <span class="sr-only">Download</span>
            </span>
            <span role="columnheader">Name</span>
            <span role="columnheader" class="text-right">
              Size
            </span>
            <span role="columnheader">Progress</span>
            <span role="columnheader">Priority</span>
          </div>
          <Show
            when={shown().length > 0}
            fallback={
              <Show
                when={files.isError}
                fallback={<div class="m-1 h-8 animate-pulse rounded-md bg-muted" />}
              >
                <p class="m-0 py-4 text-center text-sm text-danger">The files could not be read.</p>
              </Show>
            }
          >
            <div class="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
              <For each={virtualizer.getVirtualItems().map((v) => v.key as string)}>
                {(path) => (
                  <Show when={byPath().get(path)}>
                    {(r) => {
                      const v = () => virtualizer.getVirtualItems().find((x) => x.key === path);
                      const on = () => chosen().has(path);
                      return (
                        <div
                          role="row"
                          class={cn(
                            "absolute top-0 left-0 grid h-[34px] w-full grid-cols-[16px_minmax(0,1fr)_60px_72px_76px] items-center gap-2 border-b border-row-divider px-1 text-sm",
                            on() ? "bg-selected" : "hover:bg-muted",
                            r().wanted === "none" && "opacity-70",
                          )}
                          style={{ transform: `translateY(${v()?.start ?? 0}px)` }}
                          onClick={(e) => pick(r(), e)}
                        >
                          <span role="cell" onClick={(e) => e.stopPropagation()}>
                            <Checkbox
                              checked={r().wanted === "all"}
                              indeterminate={r().wanted === "some"}
                              onChange={() => {
                                const t = toggleWanted(r(), list());
                                void setPriority(t.indexes, t.priority);
                              }}
                              class="[&_[data-kb-checkbox-control]]:size-3.5"
                            >
                              <CheckboxLabel class="sr-only">Download {r().path}</CheckboxLabel>
                            </Checkbox>
                          </span>
                          <span
                            role="cell"
                            class="flex min-w-0 items-center gap-1.5"
                            style={{ "padding-left": `${r().depth * 14}px` }}
                          >
                            <Show when={r().folder}>
                              <button
                                type="button"
                                class="-ml-1 flex size-4 flex-none items-center justify-center rounded-sm text-subtle hover:text-foreground"
                                aria-label={`${collapsed().has(path) ? "Open" : "Close"} ${r().name}`}
                                aria-expanded={!collapsed().has(path)}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  toggleFolder(path);
                                }}
                              >
                                {collapsed().has(path) ? (
                                  <ChevronRight size={12} />
                                ) : (
                                  <ChevronDown size={12} />
                                )}
                              </button>
                              <FolderIcon size={13} class="flex-none text-muted-foreground" />
                            </Show>
                            <button
                              type="button"
                              aria-pressed={on()}
                              class={cn(
                                "truncate rounded-sm text-left focus-visible:shadow-focus",
                                r().folder && "font-medium",
                                r().wanted === "none" && "text-subtle line-through",
                              )}
                              title={r().path}
                              onClick={(e) => {
                                e.stopPropagation();
                                pick(r(), e);
                              }}
                            >
                              {r().name}
                            </button>
                          </span>
                          <span role="cell" class="text-right mono text-xs text-muted-foreground">
                            {formatBytes(r().size)}
                          </span>
                          <span role="cell" class="flex items-center gap-1.5">
                            <span class="block h-1 flex-1 overflow-hidden rounded-full bg-border">
                              <span
                                class={cn(
                                  "block h-full",
                                  (r().progress ?? 0) >= 1 ? "bg-ok" : "bg-brand",
                                )}
                                style={{ width: `${(r().progress ?? 0) * 100}%` }}
                              />
                            </span>
                            <span class="w-[30px] text-right mono text-2xs text-subtle">
                              {r().progress === null ? dash : formatPercent(r().progress ?? 0)}
                            </span>
                          </span>
                          <span role="cell" onClick={(e) => e.stopPropagation()}>
                            <Show when={!r().folder}>
                              <PriorityMenu
                                label={`Priority of ${r().path}: ${priorityLabel(r().priority ?? 0)}`}
                                value={r().priority ?? 0}
                                onChange={(p) => void setPriority(r().indexes, p)}
                              />
                            </Show>
                          </span>
                        </div>
                      );
                    }}
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </div>
        <div class="flex flex-none items-center justify-between gap-3 border-t border-divider pt-2 text-sm">
          <Switch
            class="flex items-center gap-2"
            checked={props.torrent.first_last_piece_priority}
            onChange={(on) => void actions.firstLast([hash()], on)}
          >
            <SwitchControl />
            <SwitchLabel class="text-sm text-muted-foreground">
              First and last pieces first
            </SwitchLabel>
          </Switch>
          <span class="mono text-xs text-subtle">
            availability{" "}
            {props.torrent.availability === null ? dash : props.torrent.availability.toFixed(2)}
          </span>
        </div>
      </Show>
      <PromptDialog
        open={renaming() !== null}
        title={renaming()?.folder ? "Rename folder" : "Rename file"}
        label="Name"
        action="Rename"
        initial={renaming()?.name ?? ""}
        onClose={() => setRenaming(null)}
        onSubmit={(name) => {
          const row = renaming();
          const problem = nameProblem(name);
          if (problem) toast.error(`Rename: ${problem}`);
          else if (row && name !== row.name) void rename(row, name);
        }}
      />
    </div>
  );
}
