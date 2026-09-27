// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Not designed: a torrent's piece hashes (`GET .../pieces/hashes`), the
// SHA-1 each piece must have, beside its state now, to compare with another
// copy of the content. Rows are drawn as they scroll (a torrent can have
// 100 000 pieces); a piece is found by its number or the start of its
// hash. Copied or saved as text: one hash per line, in piece order.

import { createQuery } from "@tanstack/solid-query";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { createMemo, createSignal, Index, Match, Show, Switch } from "solid-js";

import { api, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { StatusDot } from "~/components/status-dot";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { formatCount, formatPieceSize } from "~/lib/format";
import { cn } from "~/lib/utils";

import { copy } from "./actions";
import { findPiece } from "./pieces";

type TorrentSummary = Schemas["TorrentSummary"];

const ROW = 28;

const STATE: Record<Schemas["PieceState"], { label: string; dot: string }> = {
  have: { label: "Have", dot: "bg-brand" },
  downloading: { label: "Downloading", dot: "bg-warn" },
  missing: { label: "Missing", dot: "bg-faint" },
};

export function PieceHashesDialog(props: { torrent: TorrentSummary | null; onClose: () => void }) {
  return (
    <Dialog open={props.torrent !== null} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="flex max-h-[min(720px,85vh)] max-w-[640px] flex-col gap-0 p-0">
        <Show when={props.torrent}>{(t) => <Body torrent={t()} />}</Show>
      </DialogContent>
    </Dialog>
  );
}

function Body(props: { torrent: TorrentSummary }) {
  const hash = () => props.torrent.hash;
  const hashes = createQuery(() => ({
    queryKey: keys.torrentPart(hash(), "piece-hashes"),
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/torrents/{hash}/pieces/hashes", { params: { path: { hash: hash() } } }),
      ),
    staleTime: Infinity,
  }));
  const pieces = createQuery(() => ({
    queryKey: keys.torrentPart(hash(), "pieces"),
    queryFn: () =>
      unwrap(api.GET("/api/v1/torrents/{hash}/pieces", { params: { path: { hash: hash() } } })),
    refetchInterval: 2_000,
  }));
  const list = () => hashes.data ?? [];
  const [search, setSearch] = createSignal("");
  const found = createMemo(() => findPiece(list(), search()));
  const have = createMemo(() => (pieces.data?.states ?? []).filter((s) => s === "have").length);

  let scroller: HTMLDivElement | undefined;
  const virtualizer = createVirtualizer({
    get count() {
      return list().length;
    },
    getScrollElement: () => scroller ?? null,
    estimateSize: () => ROW,
    overscan: 20,
  });
  const go = (text: string) => {
    setSearch(text);
    const i = findPiece(list(), text);
    if (i !== null) virtualizer.scrollToIndex(i, { align: "center" });
  };
  const text = () => list().join("\n") + "\n";
  const save = () => {
    const url = URL.createObjectURL(new Blob([text()], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${props.torrent.name}.sha1.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div class="flex flex-col gap-0.5 px-5 pt-[18px] pr-12">
        <DialogTitle>Piece hashes</DialogTitle>
        <DialogDescription class="truncate text-sm text-subtle">
          {props.torrent.name} · {formatCount(props.torrent.pieces_total)} pieces of{" "}
          {formatPieceSize(props.torrent.piece_size)} · SHA-1
        </DialogDescription>
      </div>
      <div class="flex items-center gap-3 px-5 pt-3 pb-3">
        <input
          type="search"
          aria-label="Find a piece by number or hash"
          placeholder="Piece number or start of a hash"
          class="h-8 w-64 min-w-0 rounded-md border border-input bg-background px-2.5 mono text-sm outline-none placeholder:text-subtle focus:border-ring focus:shadow-focus"
          value={search()}
          onInput={(e) => go(e.currentTarget.value)}
        />
        <span class="text-sm text-subtle" role="status">
          <Show when={search().trim() !== ""}>
            {found() === null ? "No such piece" : `Piece ${formatCount(found() ?? 0)}`}
          </Show>
        </span>
      </div>
      <div class="grid grid-cols-[72px_120px_minmax(0,1fr)] gap-3 border-y border-divider px-5 py-1.5 text-xs text-subtle">
        <span class="text-right">Piece</span>
        <span>State now</span>
        <span>SHA-1</span>
      </div>
      <div ref={scroller} class="min-h-[240px] flex-1 overflow-auto">
        <Switch>
          <Match when={hashes.isError}>
            <p class="m-0 px-5 py-4 text-sm text-danger" role="alert">
              {hashes.error?.message}
            </p>
          </Match>
          <Match when={hashes.isPending}>
            <p class="m-0 px-5 py-4 text-sm text-subtle">Loading…</p>
          </Match>
          <Match when={true}>
            <div
              class="relative w-full"
              style={{ height: `${virtualizer.getTotalSize()}px` }}
              role="table"
              aria-label="Piece hashes"
              aria-rowcount={list().length}
            >
              <Index each={virtualizer.getVirtualItems()}>
                {(v) => {
                  const state = () => pieces.data?.states[v().index];
                  return (
                    <div
                      role="row"
                      aria-rowindex={v().index + 1}
                      class={cn(
                        "absolute top-0 left-0 grid w-full grid-cols-[72px_120px_minmax(0,1fr)] items-center gap-3 px-5 text-sm",
                        found() === v().index && "bg-accent",
                      )}
                      style={{ height: `${ROW}px`, transform: `translateY(${v().start}px)` }}
                    >
                      <span role="cell" class="text-right mono text-muted-foreground">
                        {v().index}
                      </span>
                      <span role="cell" class="flex items-center gap-2 text-muted-foreground">
                        <Show when={state()} fallback="—">
                          {(s) => (
                            <>
                              <StatusDot class={STATE[s()].dot} />
                              {STATE[s()].label}
                            </>
                          )}
                        </Show>
                      </span>
                      <span role="cell" class="truncate mono text-foreground-2 select-all">
                        {list()[v().index]}
                      </span>
                    </div>
                  );
                }}
              </Index>
            </div>
          </Match>
        </Switch>
      </div>
      <div class="flex items-center gap-2 border-t border-divider px-5 py-3.5">
        <span class="text-sm text-subtle">
          <Show when={pieces.data}>
            {formatCount(have())} of {formatCount(list().length)} verified
          </Show>
        </span>
        <span class="flex-1" />
        <Button
          variant="outline"
          size="sm"
          disabled={list().length === 0}
          onClick={() => void copy(text(), "Piece hashes")}
        >
          Copy all
        </Button>
        <Button size="sm" disabled={list().length === 0} onClick={save}>
          Save as text
        </Button>
      </div>
    </>
  );
}
