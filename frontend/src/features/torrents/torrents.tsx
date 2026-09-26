// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The torrents screen (AGENTS.md 6.3): the list and one torrent's details.
// Filters, search and the open torrent live in the URL; the list is the
// live store filtered, sorted and grouped in memos (4.3); search uses the
// daemon's matching (4.4).

import { useLocation, useNavigate, useParams, useSearchParams } from "@solidjs/router";
import { createQuery, keepPreviousData } from "@tanstack/solid-query";
import LayoutGrid from "lucide-solid/icons/layout-grid";
import ListFilterIcon from "lucide-solid/icons/list-filter";
import Plus from "lucide-solid/icons/plus";
import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch } from "solid-js";

import { api, type Schemas, unwrap } from "~/api/client";
import { Button } from "~/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "~/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuGroupLabel,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import { Skeleton } from "~/components/ui/skeleton";
import { useLive } from "~/features/shell/live";
import { PageHeader } from "~/features/shell/page-header";
import { type FilterParams, STATUS_LABELS } from "~/features/shell/sidebar";
import { formatCount } from "~/lib/format";
import { FILTERS } from "~/lib/torrent";
import { usePref } from "~/lib/prefs";
import { useWide } from "~/lib/use-wide";

import { actions, copy, isRunning } from "./actions";
import { AddDialog } from "./add/add-dialog";
import { DeleteDialog } from "./delete-dialog";
import { DetailPanel } from "./detail-panel";
import { type SelectMode, TorrentList } from "./torrent-list";
import {
  DEFAULT_DISPLAY,
  type Display,
  type ListFilter,
  listItems,
  matches,
  SORT_KEYS,
  type SortKey,
  sortTorrents,
  type StatusFilter,
  viewTitle,
} from "./view";

type TorrentSummary = Schemas["TorrentSummary"];

const STATUSES = new Set<string>([...FILTERS, "queued"]);

function isDisplay(v: unknown): v is Display {
  if (typeof v !== "object" || v === null) return false;
  const d = v as Record<string, unknown>;
  return (
    typeof d.group === "boolean" &&
    typeof d.reverse === "boolean" &&
    SORT_KEYS.some((k) => k.key === d.sort)
  );
}

function EmptyState(props: { title: string; text: string; action?: () => void; label?: string }) {
  return (
    <div class="flex h-full min-h-60 items-center justify-center p-8">
      <div class="flex max-w-sm flex-col items-center gap-3 text-center">
        <h2 class="m-0 text-md font-semibold">{props.title}</h2>
        <p class="m-0 text-base text-muted-foreground">{props.text}</p>
        <Show when={props.action}>
          <Button variant="outline" size="sm" onClick={() => props.action?.()}>
            {props.label}
          </Button>
        </Show>
      </div>
    </div>
  );
}

function LoadingRows() {
  return (
    <div class="flex flex-col" aria-label="Loading torrents" role="status">
      <For each={Array.from({ length: 8 })}>
        {() => (
          <div class="flex h-10 items-center gap-3 border-b border-row-divider px-4">
            <Skeleton class="size-[18px] rounded-full" />
            <Skeleton class="h-3 w-2/5" />
          </div>
        )}
      </For>
    </div>
  );
}

export default function Torrents() {
  const live = useLive();
  const params = useParams<{ hash?: string }>();
  const [search, setSearch] = useSearchParams<FilterParams>();
  const navigate = useNavigate();
  const location = useLocation();
  const wide = useWide();
  const [display, setDisplay] = usePref("torrents.display", DEFAULT_DISPLAY, isDisplay);
  const [adding, setAdding] = createSignal(false);
  const [deleting, setDeleting] = createSignal<string[]>([]);

  // The daemon's search: which info-hashes match (AGENTS.md 4.4).
  const q = () => search.q?.trim() ?? "";
  const found = createQuery(() => ({
    queryKey: ["torrents", "search", q()],
    queryFn: async () =>
      new Set(
        await unwrap(api.GET("/api/v1/torrents/hashes", { params: { query: { search: q() } } })),
      ),
    enabled: q() !== "",
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  }));

  const filter = createMemo<ListFilter>(() => ({
    status: STATUSES.has(search.status ?? "") ? (search.status as StatusFilter) : "all",
    category: search.category ?? null,
    tag: search.tag ?? null,
    tracker: search.tracker ?? null,
    search: q() === "" ? null : (found.data ?? new Set<string>()),
  }));
  const filtered = () =>
    filter().status !== "all" ||
    filter().category !== null ||
    filter().tag !== null ||
    filter().tracker !== null ||
    filter().search !== null;
  const visible = createMemo(() =>
    sortTorrents(
      live.torrents().filter((t) => matches(t, filter())),
      display(),
    ),
  );
  const items = createMemo(() => listItems(visible(), display().group));
  /** The torrents in the order they show (grouped or not). */
  const order = createMemo(() => items().flatMap((i) => (i.kind === "torrent" ? [i.hash] : [])));

  // Selection: the open torrent (in the URL) and the others picked with it.
  const focus = () => (params.hash && live.state.torrents[params.hash] ? params.hash : null);
  const focused = (): TorrentSummary | null => {
    const h = focus();
    return h ? (live.state.torrents[h] ?? null) : null;
  };
  const [picked, setPicked] = createSignal<ReadonlySet<string>>(new Set());
  let anchor: string | null = null;
  const selection = createMemo<ReadonlySet<string>>(() => {
    const s = new Set([...picked()].filter((h) => live.state.torrents[h]));
    const f = focus();
    if (f) s.add(f);
    return s;
  });
  createEffect(
    on(
      () => params.hash,
      (h) => {
        if (h && !picked().has(h)) {
          setPicked(new Set([h]));
          anchor = h;
        }
      },
    ),
  );

  const open = (hash: string | null) =>
    navigate(`/torrents${hash ? `/${hash}` : ""}${location.search}`, { scroll: false });

  const select = (hash: string, mode: SelectMode) => {
    if (mode === "toggle") {
      const next = new Set(selection());
      if (next.has(hash)) {
        next.delete(hash);
        setPicked(next);
        if (focus() === hash) open([...next][0] ?? null);
        return;
      }
      next.add(hash);
      setPicked(next);
    } else if (mode === "range" && anchor && order().includes(anchor)) {
      const ends = [order().indexOf(anchor), order().indexOf(hash)].sort((x, y) => x - y);
      const from = ends[0] ?? 0;
      setPicked(new Set(order().slice(from, (ends[1] ?? from) + 1)));
      open(hash);
      return;
    } else {
      setPicked(new Set([hash]));
    }
    anchor = hash;
    open(hash);
  };

  const move = (delta: number, extend: boolean) => {
    const list = order();
    if (list.length === 0) return;
    const at = focus() ? list.indexOf(focus() as string) : -1;
    const next = list[Math.min(Math.max(at + delta, 0), list.length - 1)];
    if (next) select(next, extend ? "range" : "one");
  };

  const chosen = () => [...selection()];
  const toggleRun = () => {
    const hashes = chosen();
    if (hashes.length === 0) return;
    const anyRunning = hashes.some((h) => {
      const t = live.state.torrents[h];
      return t ? isRunning(t) : false;
    });
    void (anyRunning ? actions.stop(hashes) : actions.start(hashes));
  };

  const onKey = (e: KeyboardEvent) => {
    const key = e.key;
    if (key === "ArrowDown" || key === "j") move(1, e.shiftKey);
    else if (key === "ArrowUp" || key === "k") move(-1, e.shiftKey);
    else if (key === "Home") move(-order().length, e.shiftKey);
    else if (key === "End") move(order().length, e.shiftKey);
    else if (key === " ") toggleRun();
    else if (key === "Delete" || key === "Backspace") setDeleting(chosen());
    else if (key === "Escape") {
      setPicked(new Set<string>());
      open(null);
    } else if (key === "a" && (e.metaKey || e.ctrlKey)) setPicked(new Set(order()));
    else return;
    e.preventDefault();
  };

  const deleteLabel = () => {
    const hs = deleting();
    if (hs.length === 1) return live.state.torrents[hs[0] as string]?.name ?? "this torrent";
    return `${formatCount(hs.length)} torrents`;
  };

  const labels = STATUS_LABELS as Record<StatusFilter, string>;
  const title = () => viewTitle(filter(), labels);

  const panel = () => (
    <Show
      when={focused()}
      fallback={
        <div class="flex h-full items-center justify-center bg-card p-8 text-center text-base text-subtle">
          Select a torrent to see its details.
        </div>
      }
    >
      {(t) => <DetailPanel torrent={t()} onDelete={setDeleting} class="h-full" />}
    </Show>
  );

  return (
    <div class="flex min-w-0 flex-1">
      <main class="flex min-w-0 flex-1 flex-col border-r border-divider">
        <PageHeader
          title={title()}
          count={<span class="mono text-xs text-subtle">{formatCount(visible().length)}</span>}
        >
          <Show when={selection().size > 1}>
            <span class="mr-1 mono text-xs text-muted-foreground">
              {formatCount(selection().size)} selected
            </span>
            <Button variant="outline" size="sm" onClick={() => void actions.start(chosen())}>
              Start
            </Button>
            <Button variant="outline" size="sm" onClick={() => void actions.stop(chosen())}>
              Stop
            </Button>
            <Button variant="outline" size="sm" onClick={() => setDeleting(chosen())}>
              Delete
            </Button>
            <span class="mx-1 h-4 w-px bg-divider" aria-hidden="true" />
          </Show>
          <DropdownMenu>
            <DropdownMenuTrigger as={Button} variant="outline" size="sm">
              <ListFilterIcon />
              Filter
            </DropdownMenuTrigger>
            <DropdownMenuContent class="min-w-52">
              <DropdownMenuGroup>
                <DropdownMenuGroupLabel>Status</DropdownMenuGroupLabel>
                <DropdownMenuRadioGroup
                  value={filter().status}
                  onChange={(v) => setSearch({ status: v === "all" ? undefined : v })}
                >
                  <For each={[...FILTERS, "queued" as const]}>
                    {(s) => <DropdownMenuRadioItem value={s}>{labels[s]}</DropdownMenuRadioItem>}
                  </For>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                disabled={!filtered()}
                onSelect={() =>
                  setSearch({
                    status: undefined,
                    category: undefined,
                    tag: undefined,
                    tracker: undefined,
                    q: undefined,
                  })
                }
              >
                Clear every filter
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger as={Button} variant="outline" size="sm">
              <LayoutGrid />
              Display
            </DropdownMenuTrigger>
            <DropdownMenuContent class="min-w-52">
              <DropdownMenuCheckboxItem
                checked={display().group}
                onChange={(group) => setDisplay({ ...display(), group })}
              >
                Group by state
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuGroupLabel>Sort by</DropdownMenuGroupLabel>
                <DropdownMenuRadioGroup
                  value={display().sort}
                  onChange={(sort) =>
                    setDisplay({
                      ...display(),
                      sort: sort as SortKey,
                      reverse: SORT_KEYS.find((k) => k.key === sort)?.reverse ?? false,
                    })
                  }
                >
                  <For each={SORT_KEYS}>
                    {(k) => <DropdownMenuRadioItem value={k.key}>{k.label}</DropdownMenuRadioItem>}
                  </For>
                </DropdownMenuRadioGroup>
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={display().reverse}
                onChange={(reverse) => setDisplay({ ...display(), reverse })}
              >
                Descending
              </DropdownMenuCheckboxItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus class="stroke-[2.5]" />
            Add
          </Button>
        </PageHeader>

        <ContextMenu>
          <ContextMenuTrigger class="flex min-h-0 flex-1 flex-col">
            <Switch>
              <Match when={!live.ready()}>
                <LoadingRows />
              </Match>
              <Match when={true}>
                <TorrentList
                  items={items()}
                  torrents={live.state.torrents}
                  selected={selection()}
                  focus={focus()}
                  onSelect={select}
                  onKey={onKey}
                  empty={
                    <Show
                      when={live.torrents().length > 0}
                      fallback={
                        <EmptyState
                          title="No torrents yet"
                          text="Add a magnet link or a .torrent file to start."
                          action={() => setAdding(true)}
                          label="Add torrents"
                        />
                      }
                    >
                      <EmptyState
                        title="No torrents match"
                        text="No torrent passes the filters and search in use."
                        action={() =>
                          setSearch({
                            status: undefined,
                            category: undefined,
                            tag: undefined,
                            tracker: undefined,
                            q: undefined,
                          })
                        }
                        label="Clear every filter"
                      />
                    </Show>
                  }
                />
              </Match>
            </Switch>
          </ContextMenuTrigger>
          <Show when={selection().size > 0}>
            <ContextMenuContent class="min-w-52">
              <ContextMenuItem onSelect={() => void actions.start(chosen())}>Start</ContextMenuItem>
              <ContextMenuItem onSelect={() => void actions.stop(chosen())}>Stop</ContextMenuItem>
              <ContextMenuItem onSelect={() => void actions.forceStart(chosen(), true)}>
                Force start
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => void actions.recheck(chosen())}>
                Recheck
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void actions.reannounce(chosen())}>
                Reannounce
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                onSelect={() =>
                  void copy(
                    chosen()
                      .map((h) => live.state.torrents[h]?.magnet_uri ?? "")
                      .filter((m) => m !== "")
                      .join("\n"),
                    selection().size === 1 ? "Magnet link" : "Magnet links",
                  )
                }
              >
                Copy magnet {selection().size === 1 ? "link" : "links"}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem class="text-danger" onSelect={() => setDeleting(chosen())}>
                Delete…
              </ContextMenuItem>
            </ContextMenuContent>
          </Show>
        </ContextMenu>
      </main>

      <Show when={wide()}>
        <aside class="flex w-[420px] flex-none flex-col" aria-label="Torrent details">
          {panel()}
        </aside>
      </Show>
      <Sheet
        open={!wide() && focused() !== null}
        onOpenChange={(o) => {
          if (!o) open(null);
        }}
      >
        <SheetContent position="right" class="w-full max-w-[420px] p-0">
          <SheetTitle class="sr-only">Torrent details</SheetTitle>
          {panel()}
        </SheetContent>
      </Sheet>

      <AddDialog open={adding()} onClose={() => setAdding(false)} />
      <DeleteDialog
        hashes={deleting()}
        label={deleteLabel()}
        onClose={(deleted) => {
          const gone = deleting();
          setDeleting([]);
          if (deleted && focus() && gone.includes(focus() as string)) open(null);
        }}
      />
    </div>
  );
}
