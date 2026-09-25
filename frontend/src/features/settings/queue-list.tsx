// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The queue's running and waiting torrents in order, reordered by dragging
// a row's handle, or from the keyboard: Space picks the row up, the arrow
// keys move it, Space drops it, Escape puts it back. A drop is one
// `PUT /torrents/{hash}/queue-position`; the new order shows until the
// daemon's own arrives.

import GripVertical from "lucide-solid/icons/grip-vertical";
import { createEffect, createMemo, createSignal, For, onCleanup, Show } from "solid-js";

import type { Schemas } from "~/api/client";
import { StatusDot } from "~/components/status-dot";
import { formatCount } from "~/lib/format";
import { stateLook, toneBg } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { moved, type QueueEntry } from "./queue-now";

type Row = Schemas["TorrentSummary"];

/** Rows shown at most; the rest are counted. */
const ROWS = 10;
/** How long a drop's order shows without the daemon's confirming it. */
const PENDING_MS = 3000;

interface Drag {
  hash: string;
  from: number;
  over: number;
  keys: boolean;
  startY: number;
}

export function QueueList(props: {
  entries: QueueEntry<Row>[];
  holding: (e: QueueEntry<Row>) => { text: string; tone: "plain" | "warn" | "wait" };
  /** Put a torrent at a queue position; resolves once the daemon took it. */
  onPlace: (hash: string, position: number) => Promise<boolean>;
}) {
  const [drag, setDrag] = createSignal<Drag | null>(null);
  const [pending, setPending] = createSignal<string[] | null>(null);
  const [said, say] = createSignal("");
  const grips = new Map<string, HTMLButtonElement>();
  let body: HTMLTableSectionElement | undefined;

  const base = createMemo(() => props.entries.slice(0, ROWS));
  const byHash = createMemo(() => new Map(base().map((e) => [e.row.hash, e])));
  const hashes = createMemo(() => base().map((e) => e.row.hash));
  // What shows: a drag's preview, else a drop's order until the daemon's
  // arrives, else the daemon's.
  const shown = createMemo(() => {
    const d = drag();
    if (d) return moved(hashes(), d.from, d.over);
    const p = pending();
    if (!p) return hashes();
    const at = new Map(p.map((h, i) => [h, i]));
    return [...hashes()].sort((a, b) => (at.get(a) ?? ROWS) - (at.get(b) ?? ROWS));
  });
  createEffect(() => {
    const p = pending();
    if (p && hashes().every((h, i) => p[i] === h)) setPending(null);
  });
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(pendingTimer));

  const nameOf = (hash: string) => byHash().get(hash)?.row.name ?? "";
  const place = (i: number) => `place ${i + 1} of ${formatCount(hashes().length)}`;

  const start = (hash: string, keys: boolean, y = 0) => {
    const from = hashes().indexOf(hash);
    if (from < 0) return;
    setDrag({ hash, from, over: from, keys, startY: y });
    if (keys)
      say(
        `${nameOf(hash)} picked up, ${place(from)}. Arrow keys move it, Space drops it, Escape cancels.`,
      );
  };
  const over = (to: number) => {
    const d = drag();
    if (!d) return;
    const next = Math.max(0, Math.min(to, hashes().length - 1));
    if (next === d.over) return;
    setDrag({ ...d, over: next });
    if (d.keys) {
      say(`${nameOf(d.hash)}, ${place(next)}.`);
      // Moving the row in the page can take the focus with it.
      queueMicrotask(() => grips.get(d.hash)?.focus());
    }
  };
  const cancel = () => {
    const d = drag();
    if (!d) return;
    setDrag(null);
    if (d.keys) say(`${nameOf(d.hash)} put back at ${place(d.from)}.`);
  };
  const drop = async () => {
    const d = drag();
    if (!d) return;
    setDrag(null);
    if (d.over === d.from) {
      if (d.keys) say(`${nameOf(d.hash)} dropped where it was.`);
      return;
    }
    // Before a row when moving up, after it when moving down: its position
    // either way (the others shift).
    const target = base()[d.over];
    if (!target) return;
    const order = moved(hashes(), d.from, d.over);
    setPending(order);
    clearTimeout(pendingTimer);
    pendingTimer = setTimeout(() => setPending(null), PENDING_MS);
    if (d.keys) say(`${nameOf(d.hash)} dropped at ${place(d.over)}.`);
    if (!(await props.onPlace(d.hash, target.row.queue_position))) setPending(null);
  };

  const rowHeight = () => body?.rows[0]?.getBoundingClientRect().height || 36;

  return (
    <>
      <p id="queue-drag-help" class="sr-only">
        Drag to reorder, or press Space to pick the torrent up, the arrow keys to move it and Space
        to drop it. Escape puts it back.
      </p>
      <span class="sr-only" aria-live="assertive">
        {said()}
      </span>
      <table class="w-full table-fixed border-collapse text-sm">
        <colgroup>
          <col class="w-[48px]" />
          <col class="w-[28px]" />
          <col />
          <col class="w-[130px]" />
          <col class="w-[210px]" />
        </colgroup>
        <thead>
          <tr class="h-7 border-b border-accent text-xs text-subtle">
            <th class="pl-4 text-left font-normal">#</th>
            <th>
              <span class="sr-only">Reorder</span>
            </th>
            <th class="px-1.5 text-left font-normal">Torrent</th>
            <th class="px-1.5 text-left font-normal">State</th>
            <th class="pr-4 pl-1.5 text-left font-normal">Holding</th>
          </tr>
        </thead>
        <tbody ref={body}>
          <For each={shown()}>
            {(hash, i) => {
              const e = () => byHash().get(hash);
              const look = () => {
                const x = e();
                return x ? stateLook(x.row) : null;
              };
              const h = () => {
                const x = e();
                return x ? props.holding(x) : null;
              };
              const dragged = () => drag()?.hash === hash;
              return (
                <Show when={e()}>
                  {(x) => (
                    <tr
                      class={cn(
                        "h-9 border-b border-accent last:border-b-0",
                        dragged() && "relative bg-accent shadow-card",
                      )}
                    >
                      <td class="pl-4 mono text-subtle">
                        {base()[i()]?.row.queue_position ?? x().row.queue_position}
                      </td>
                      <td>
                        <button
                          ref={(el) => grips.set(hash, el)}
                          type="button"
                          class={cn(
                            "flex size-6 touch-none items-center justify-center rounded-md text-faint hover:text-muted-foreground focus-visible:shadow-focus focus-visible:outline-none",
                            dragged() ? "cursor-grabbing text-muted-foreground" : "cursor-grab",
                          )}
                          aria-label={`Reorder ${x().row.name}`}
                          aria-describedby="queue-drag-help"
                          aria-pressed={dragged() && drag()?.keys ? "true" : undefined}
                          onPointerDown={(ev) => {
                            if (ev.button !== 0) return;
                            ev.preventDefault();
                            ev.currentTarget.setPointerCapture(ev.pointerId);
                            start(hash, false, ev.clientY);
                          }}
                          onPointerMove={(ev) => {
                            const d = drag();
                            if (!d || d.keys) return;
                            over(d.from + Math.round((ev.clientY - d.startY) / rowHeight()));
                          }}
                          onPointerUp={() => {
                            if (drag() && !drag()?.keys) void drop();
                          }}
                          onPointerCancel={cancel}
                          onKeyDown={(ev) => {
                            const d = drag();
                            if (ev.key === " " || ev.key === "Enter") {
                              ev.preventDefault();
                              if (d?.keys) void drop();
                              else if (!d) start(hash, true);
                            } else if (d?.keys && ev.key === "ArrowUp") {
                              ev.preventDefault();
                              over(d.over - 1);
                            } else if (d?.keys && ev.key === "ArrowDown") {
                              ev.preventDefault();
                              over(d.over + 1);
                            } else if (d && ev.key === "Escape") {
                              ev.preventDefault();
                              cancel();
                            }
                          }}
                        >
                          <GripVertical class="size-3.5" />
                        </button>
                      </td>
                      <td class={cn("truncate px-1.5", x().waiting && "text-muted-foreground")}>
                        {x().row.name}
                      </td>
                      <td class="px-1.5">
                        <span class="inline-flex h-5 items-center gap-1.5 rounded-[5px] border border-border bg-muted px-[7px] text-xs font-medium whitespace-nowrap">
                          <StatusDot class={toneBg[look()?.tone ?? "subtle"]} />
                          {look()?.label}
                        </span>
                      </td>
                      <td
                        class={cn(
                          "truncate pr-4 pl-1.5",
                          h()?.tone === "warn"
                            ? "text-warn"
                            : h()?.tone === "wait"
                              ? "text-muted-foreground"
                              : "text-subtle",
                        )}
                      >
                        {h()?.text}
                      </td>
                    </tr>
                  )}
                </Show>
              );
            }}
          </For>
        </tbody>
      </table>
      <Show when={props.entries.length > ROWS}>
        <p class="m-0 border-t border-accent px-4 py-2 text-sm text-subtle">
          {formatCount(props.entries.length - ROWS)} more further down the queue.
        </p>
      </Show>
    </>
  );
}
