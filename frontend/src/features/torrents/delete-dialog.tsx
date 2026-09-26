// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Removing always asks (AGENTS.md 4.4): the torrents by name with their
// size and ratio, those tagged `keep` pointed out, and deleting the files
// too as a separate, red choice that says how much it deletes and where.
// Trackers are told (the library sends `stopped`); statistics keep their
// history.

import { createEffect, createMemo, createSignal, For, Show } from "solid-js";

import { StatusDot } from "~/components/status-dot";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox, CheckboxLabel } from "~/components/ui/checkbox";
import { KEEP } from "~/features/stats/idle-view";
import { useLive } from "~/features/shell/live";
import { formatBytes, formatCount, formatRatio } from "~/lib/format";
import { stateLook, toneBg } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { actions } from "./actions";
import { removal } from "./removal";

/** Torrents named in the dialog at most; the rest are counted. */
const LISTED = 6;

export function DeleteDialog(props: {
  /** The torrents to remove; empty closes the dialog. */
  hashes: readonly string[];
  /** What to call them instead of their count ("3 idle torrents"). */
  label?: string;
  /** Whether "delete the files too" starts chosen (off unless asked for). */
  files?: boolean;
  onClose: (deleted: boolean) => void;
}) {
  const live = useLive();
  const [files, setFiles] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  createEffect(() => {
    if (props.hashes.length > 0) setFiles(props.files ?? false);
  });
  const rows = createMemo(() =>
    props.hashes.flatMap((h) => {
      const t = live.state.torrents[h];
      return t ? [t] : [];
    }),
  );
  const r = createMemo(() => removal(rows(), KEEP));
  const n = () => props.hashes.length;
  const title = () => {
    if (props.label) return `Remove ${props.label}?`;
    return n() === 1
      ? `Remove ${rows()[0]?.name ?? "this torrent"}?`
      : `Remove ${formatCount(n())} torrents?`;
  };
  const confirm = async () => {
    setBusy(true);
    const done = await actions.remove(props.hashes, files());
    setBusy(false);
    props.onClose(done !== null);
  };
  return (
    <AlertDialog
      open={n() > 0}
      onOpenChange={(open) => {
        if (!open) props.onClose(false);
      }}
    >
      <AlertDialogContent class="max-w-[520px] gap-0 p-0">
        <div class="flex items-start gap-3 px-5 pt-[18px]">
          <span
            aria-hidden="true"
            class="flex size-7 flex-none items-center justify-center rounded-md bg-danger/15 text-danger"
          >
            ×
          </span>
          <div class="flex min-w-0 flex-col gap-0.5">
            <AlertDialogTitle class="[overflow-wrap:anywhere]">{title()}</AlertDialogTitle>
            <AlertDialogDescription class="text-sm text-subtle">
              {n() === 1
                ? "It stops and leaves the list. Its trackers are told."
                : "They stop and leave the list. Their trackers are told."}
            </AlertDialogDescription>
          </div>
        </div>
        <div class="flex flex-col gap-3 px-5 pt-4 pb-4">
          <ul
            aria-label="Torrents to remove"
            class="m-0 flex list-none flex-col rounded-lg border border-divider p-0"
          >
            <For each={rows().slice(0, LISTED)}>
              {(t) => (
                <li class="flex h-8 items-center gap-2.5 border-b border-row-divider px-3 text-sm last:border-b-0">
                  <StatusDot class={toneBg[stateLook(t).tone]} small />
                  <span class="min-w-0 flex-1 truncate">{t.name}</span>
                  <span class="flex-none mono text-xs text-subtle">
                    {formatBytes(t.size)} · ratio {formatRatio(t.ratio)}
                    <Show when={t.tags.includes(KEEP)}>
                      {" · "}
                      <span class="text-warn">tag {KEEP}</span>
                    </Show>
                  </span>
                </li>
              )}
            </For>
            <Show when={rows().length > LISTED}>
              <li class="flex h-8 items-center px-3 text-sm text-subtle">
                and {formatCount(rows().length - LISTED)} more
              </li>
            </Show>
          </ul>
          <div
            class={cn(
              "flex flex-col gap-1 rounded-lg border px-3.5 py-3",
              files() ? "border-danger/40 bg-danger/8" : "border-divider",
            )}
          >
            <Checkbox checked={files()} onChange={setFiles} class="flex items-center gap-2.5">
              <CheckboxLabel class="text-sm font-medium text-foreground">
                Also delete the files on disk
              </CheckboxLabel>
            </Checkbox>
            <span class="pl-[26px] text-sm text-subtle">
              Deletes <span class="mono text-foreground-2">{formatBytes(r().bytes)}</span>{" "}
              downloaded
              <Show when={r().places.length > 0}>
                {" "}
                under {r().places.join(" and ")}
                <Show when={r().morePlaces > 0}> and {formatCount(r().morePlaces)} more</Show>
              </Show>
              . Cannot be undone: there is no trash.
            </span>
          </div>
          <Show when={r().kept.length > 0}>
            <p class="m-0 flex gap-1.5 text-sm text-warn" role="note">
              <span aria-hidden="true">!</span>
              <span>
                {r().kept.length === 1
                  ? `${r().kept[0] ?? ""} is tagged ${KEEP}.`
                  : `${formatCount(r().kept.length)} of them are tagged ${KEEP}.`}{" "}
                {r().kept.length === 1 ? "It goes" : "They go"} too, since you chose{" "}
                {r().kept.length === 1 ? "it" : "them"}.
              </span>
            </p>
          </Show>
        </div>
        <div class="flex items-center gap-2 border-t border-divider px-5 py-3.5">
          <span class="min-w-0 flex-1 text-sm text-subtle">Statistics keep their history.</span>
          <Button variant="outline" size="sm" onClick={() => props.onClose(false)}>
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            class="border-danger/40 text-danger hover:bg-danger/10 hover:text-danger"
            disabled={busy()}
            onClick={() => void confirm()}
          >
            {n() === 1 ? "Remove" : `Remove ${formatCount(n())}`}
            <Show when={files()}> and delete {formatBytes(r().bytes)}</Show>
          </Button>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}
