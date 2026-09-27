// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Not designed: the keyboard shortcuts in one place (AGENTS.md 6.3), opened
// with ? or from the palette, in the palette's language.

import { For } from "solid-js";

import { Kbd } from "~/components/kbd";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";

const mac = () => /Mac|iPhone|iPad/.test(navigator.platform);

function groups(): { title: string; keys: [string[], string][] }[] {
  const m = mac() ? "⌘" : "Ctrl ";
  const alt = mac() ? "⌥" : "Alt ";
  return [
    {
      title: "Anywhere",
      keys: [
        [[`${m}K`, "/"], "Open the palette"],
        [[","], "Open Settings"],
        [[`${alt}S`], "Switch the alternative limits"],
        [[`${m}V`], "Add the magnet link, URL or .torrent file pasted"],
        [["?"], "These shortcuts"],
      ],
    },
    {
      title: "The torrent list",
      keys: [
        [["↑", "↓"], "Move (j and k too)"],
        [["⇧↑", "⇧↓"], "Choose more"],
        [[`${m}A`], "Choose all shown"],
        [["Home", "End"], "First, last"],
        [["Space", "S"], "Start or stop"],
        [["⇧F"], "Force start"],
        [["R"], "Recheck"],
        [["A"], "Reannounce"],
        [["L"], "Share limits…"],
        [["M"], "Move location…"],
        [[`${m}C`], "Copy the magnet links"],
        [["⌫", "Delete"], "Remove…"],
        [["Esc"], "Choose none"],
      ],
    },
    {
      title: "The palette",
      keys: [
        [["↑", "↓"], "Move"],
        [["↵"], "Open"],
        [[`${m}↵`], "Open in Stats"],
        [["Tab"], "Next scope (t, f or > first chooses one)"],
      ],
    },
  ];
}

export function ShortcutsDialog(props: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="max-w-[560px] gap-4">
        <div class="flex flex-col gap-1 pr-8">
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription class="text-sm text-subtle">
            Not while typing in a field or with a dialog open, except in the palette.
          </DialogDescription>
        </div>
        <div class="grid gap-x-8 gap-y-4 sm:grid-cols-2">
          <For each={groups()}>
            {(g) => (
              <section aria-label={g.title} class="flex flex-col gap-1">
                <h3 class="m-0 mb-1 section-label">{g.title}</h3>
                <dl class="m-0 flex flex-col gap-1">
                  <For each={g.keys}>
                    {([keys, what]) => (
                      <div class="flex items-center justify-between gap-3 text-sm">
                        <dt class="text-foreground-2">{what}</dt>
                        <dd class="m-0 flex flex-none gap-1">
                          <For each={keys}>{(k) => <Kbd>{k}</Kbd>}</For>
                        </dd>
                      </div>
                    )}
                  </For>
                </dl>
              </section>
            )}
          </For>
        </div>
      </DialogContent>
    </Dialog>
  );
}
