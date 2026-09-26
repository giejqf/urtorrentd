// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The list's context menu: what applies to the torrents chosen, with the
// keys that do the same in the list (S, ⇧F, R, A, L, M, ⌘C, ⌫).

import { useNavigate } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";

import {
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "~/components/ui/context-menu";
import { useLive } from "~/features/shell/live";
import { formatCount } from "~/lib/format";

import { actions, isRunning } from "./actions";
import { bulk } from "./bulk";
import { QUEUE_MOVES } from "./bulk-panel";
import { useTorrentDialogs } from "./torrent-dialogs";

const MIXED = "\u0000mixed";
const mac = () => /Mac|iPhone|iPad/.test(navigator.platform);

export function RowMenu(props: {
  hashes: readonly string[];
  onCopy: () => void;
  onPrompt: (what: "category" | "tag") => void;
}) {
  const live = useLive();
  const dialogs = useTorrentDialogs();
  const navigate = useNavigate();
  const rows = createMemo(() =>
    props.hashes.flatMap((h) => {
      const t = live.state.torrents[h];
      return t ? [t] : [];
    }),
  );
  const b = createMemo(() => bulk(rows()));
  const one = () => (rows().length === 1 ? rows()[0] : undefined);
  const running = () => rows().filter((t) => isRunning(t)).length;
  const names = createMemo(() => Object.keys(live.state.categories).sort());
  const tags = createMemo(() =>
    [...new Set([...live.state.tags, ...b().tags.map(([t]) => t)])].sort((x, y) =>
      x.localeCompare(y),
    ),
  );
  const has = (tag: string) => b().tags.find(([t]) => t === tag)?.[1] ?? 0;
  const h = () => props.hashes;
  const exportTorrent = () => {
    const t = one();
    if (!t) return;
    const a = document.createElement("a");
    a.href = "/api/v1/torrents/{hash}/torrent-file".replace("{hash}", t.hash);
    a.download = `${t.name}.torrent`;
    a.click();
  };
  return (
    <ContextMenuContent class="w-60">
      <ContextMenuLabel class="truncate text-xs font-normal text-subtle">
        {one()?.name ?? `${formatCount(rows().length)} torrents`}
      </ContextMenuLabel>
      <Show when={running() < rows().length}>
        <ContextMenuItem onSelect={() => void actions.start(h())}>
          Start
          <Show when={running() === 0}>
            <ContextMenuShortcut>S</ContextMenuShortcut>
          </Show>
        </ContextMenuItem>
      </Show>
      <Show when={running() > 0}>
        <ContextMenuItem onSelect={() => void actions.stop(h())}>
          Stop
          <ContextMenuShortcut>S</ContextMenuShortcut>
        </ContextMenuItem>
      </Show>
      <ContextMenuItem onSelect={() => void actions.forceStart(h(), true)}>
        Force start
        <ContextMenuShortcut>⇧F</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void actions.recheck(h())}>
        Recheck
        <ContextMenuShortcut>R</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => void actions.reannounce(h())}>
        Reannounce
        <ContextMenuShortcut>A</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuSub>
        <ContextMenuSubTrigger>Queue</ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <For each={QUEUE_MOVES}>
            {(q) => (
              <ContextMenuItem onSelect={() => void actions.queue(h(), q.to)}>
                Move to {q.label.toLowerCase()}
              </ContextMenuItem>
            )}
          </For>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Category</ContextMenuSubTrigger>
        <ContextMenuSubContent class="min-w-44">
          <ContextMenuRadioGroup
            value={b().category === undefined ? MIXED : (b().category ?? "")}
            onChange={(v) => void actions.category(h(), v === "" ? null : v)}
          >
            <ContextMenuRadioItem value="" closeOnSelect>
              No category
            </ContextMenuRadioItem>
            <For each={names()}>
              {(name) => (
                <ContextMenuRadioItem value={name} closeOnSelect>
                  {name}
                </ContextMenuRadioItem>
              )}
            </For>
          </ContextMenuRadioGroup>
          <ContextMenuSeparator />
          <ContextMenuItem onSelect={() => props.onPrompt("category")}>
            New category…
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuSub>
        <ContextMenuSubTrigger>Tags</ContextMenuSubTrigger>
        <ContextMenuSubContent class="min-w-44">
          <For each={tags()}>
            {(tag) => (
              <ContextMenuCheckboxItem
                checked={has(tag) === rows().length}
                indeterminate={has(tag) > 0 && has(tag) < rows().length}
                closeOnSelect={false}
                onChange={(on) => void actions.tags(h(), on ? "add" : "remove", [tag])}
              >
                {tag}
              </ContextMenuCheckboxItem>
            )}
          </For>
          <Show when={tags().length > 0}>
            <ContextMenuSeparator />
          </Show>
          <ContextMenuItem onSelect={() => props.onPrompt("tag")}>New tag…</ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
      <ContextMenuItem onSelect={() => dialogs.shareLimits(h())}>
        Share limits…
        <ContextMenuShortcut>L</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={() => dialogs.move(h())}>
        Move location…
        <ContextMenuShortcut>M</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem onSelect={() => props.onCopy()}>
        Copy magnet {rows().length === 1 ? "link" : "links"}
        <ContextMenuShortcut>{mac() ? "⌘C" : "Ctrl C"}</ContextMenuShortcut>
      </ContextMenuItem>
      <Show when={one()?.has_metadata}>
        <ContextMenuItem onSelect={exportTorrent}>Download .torrent</ContextMenuItem>
      </Show>
      <Show when={one()}>
        {(t) => (
          <ContextMenuItem onSelect={() => navigate(`/stats/timeline?hash=${t().hash}`)}>
            Open in Stats
          </ContextMenuItem>
        )}
      </Show>
      <ContextMenuSeparator />
      <ContextMenuItem class="text-danger" onSelect={() => dialogs.remove(h())}>
        Remove…
        <ContextMenuShortcut>⌫</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
