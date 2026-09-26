// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// "Move content": a new save path, or download path, for one torrent or
// many, with what the daemon will do (move now, or on completion), the
// free space where it goes, and whether the move is a rename (the same file
// system as now) or a copy. Moves run in the background: the torrent's
// state shows Moving until done.

import { createQuery } from "@tanstack/solid-query";
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";

import { api, type Schemas, unwrap } from "~/api/client";
import { FolderPicker } from "~/components/folder-picker";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { useLive } from "~/features/shell/live";
import { formatBytes, formatCount, formatPercent } from "~/lib/format";
import { useSettled } from "~/lib/settled";
import { stateLook } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { actions } from "./actions";
import { contentDir, locationProblem, type MoveTarget, movePlan } from "./move";

function useFileSystem(path: () => string) {
  return createQuery(() => ({
    queryKey: ["fs", "file-system", path()],
    queryFn: () =>
      unwrap(api.GET("/api/v1/fs/file-system", { params: { query: { path: path() } } })),
    enabled: path().startsWith("/"),
    retry: false,
  }));
}

function Choice(props: {
  on: boolean;
  disabled?: boolean;
  title: string;
  hint: string;
  onChoose: () => void;
}) {
  return (
    <label
      class={cn(
        "flex cursor-pointer items-start gap-3 rounded-lg border px-3.5 py-3",
        props.on ? "border-border-strong bg-accent" : "border-divider",
        props.disabled && "cursor-not-allowed opacity-50",
      )}
    >
      <input
        type="radio"
        name="move-target"
        class="mt-0.5 size-3.5 flex-none accent-[var(--foreground)]"
        checked={props.on}
        disabled={props.disabled}
        onChange={() => props.onChoose()}
      />
      <span class="flex flex-col gap-0.5">
        <span class="text-sm font-medium">{props.title}</span>
        <span class="text-sm text-subtle">{props.hint}</span>
      </span>
    </label>
  );
}

export function MoveDialog(props: { hashes: readonly string[]; onClose: () => void }) {
  const live = useLive();
  const rows = createMemo(() =>
    props.hashes.flatMap((h) => {
      const t = live.state.torrents[h];
      return t ? [t] : [];
    }),
  );
  const one = () => (rows().length === 1 ? rows()[0] : undefined);
  const anyIncomplete = () => rows().some((t) => !t.complete);
  const [target, setTarget] = createSignal<MoveTarget>("save");
  const [path, setPath] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  /** What every torrent chosen shares, else nothing. */
  const common = (pick: (t: Schemas["TorrentSummary"]) => string) => {
    const all = rows().map(pick);
    return all.every((p) => p === all[0]) ? (all[0] ?? "") : "";
  };
  // Opening, or another target: start from where things are.
  createEffect(
    on(
      () => [props.hashes.length > 0, target()] as const,
      ([open, to]) => {
        if (!open) return;
        setPath(to === "save" ? common((t) => t.save_path) : common((t) => t.download_path ?? ""));
      },
    ),
  );
  createEffect(
    on(
      () => props.hashes.length,
      (n) => {
        if (n > 0) setTarget("save");
      },
    ),
  );
  const typed = () => path().trim();
  const settled = useSettled(typed);
  const there = useFileSystem(settled);
  const here = useFileSystem(() => {
    const t = one();
    return t ? contentDir(t) : "";
  });
  const problem = () => locationProblem(target(), typed());
  const plan = () => {
    const t = one();
    return t ? movePlan(t, target(), typed()) : null;
  };
  const managed = () => rows().filter((t) => t.auto_management);
  const size = () => rows().reduce((n, t) => n + t.size, 0);
  const place = () => {
    const fs = there.data;
    if (!fs || typed() === "") return null;
    const where = fs.mount_point ?? fs.path;
    const same =
      here.data && one()
        ? here.data.mount_point !== null && here.data.mount_point === fs.mount_point
        : null;
    const how =
      same === null
        ? ""
        : same
          ? " · the same file system as now, so the move is a rename"
          : " · another file system: the files are copied";
    return `${where} · ${formatBytes(fs.free)} free${how}`;
  };
  const move = async () => {
    if (problem() !== null) return;
    setBusy(true);
    const hashes = rows().map((t) => t.hash);
    const r =
      target() === "save"
        ? await actions.location(hashes, typed())
        : await actions.downloadPath(hashes, typed() === "" ? null : typed());
    setBusy(false);
    if (r !== null) props.onClose();
  };
  const subtitle = () => {
    const t = one();
    if (!t) return `${formatCount(rows().length)} torrents · ${formatBytes(size())}`;
    const parts = [t.name, formatBytes(t.size)];
    if (!t.complete) parts.push(formatPercent(t.progress));
    parts.push(stateLook(t).label.toLowerCase());
    return parts.join(" · ");
  };
  return (
    <Dialog open={props.hashes.length > 0} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="max-w-[560px] gap-0 p-0">
        <div class="flex flex-col gap-0.5 px-5 pt-[18px] pr-12">
          <DialogTitle>Move content</DialogTitle>
          <DialogDescription class="truncate text-sm text-subtle">{subtitle()}</DialogDescription>
        </div>
        <form
          class="flex flex-col gap-3.5 px-5 pt-4 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            void move();
          }}
        >
          <div role="radiogroup" aria-label="What to move" class="flex flex-col gap-2">
            <Choice
              on={target() === "save"}
              title="Save path — where the content belongs"
              hint={
                anyIncomplete()
                  ? "Moves the content now; an incomplete torrent in its download path goes there when it completes. Turns automatic management off."
                  : "Moves the content now. Turns automatic management off."
              }
              onChoose={() => setTarget("save")}
            />
            <Choice
              on={target() === "download"}
              disabled={!anyIncomplete()}
              title="Download path — where it lives while incomplete"
              hint={
                anyIncomplete()
                  ? "Moves the partial files now. Clear it to download straight into the save path."
                  : "Only for incomplete torrents: these are complete."
              }
              onChoose={() => setTarget("download")}
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="move-path" class="text-sm font-medium">
              New location
            </label>
            <div class="flex gap-1.5">
              <input
                id="move-path"
                class={cn(
                  "h-9 min-w-0 flex-1 rounded-md border bg-background px-2.5 mono text-sm text-foreground outline-none focus:shadow-focus",
                  problem() !== null && typed() !== ""
                    ? "border-danger"
                    : "border-border focus:border-ring",
                )}
                spellcheck={false}
                placeholder={
                  target() === "download" ? "none: straight into the save path" : "/data/…"
                }
                value={path()}
                onInput={(e) => setPath(e.currentTarget.value)}
              />
              <FolderPicker
                what={target() === "save" ? "new save path" : "new download path"}
                purpose={
                  one()
                    ? `Used as the ${target() === "save" ? "save" : "download"} path of ${one()?.name ?? ""}`
                    : `Used for ${formatCount(rows().length)} torrents`
                }
                value={typed()}
                onPick={setPath}
              />
            </div>
            <span class="text-sm text-subtle">
              <Show
                when={problem() === null || typed() === ""}
                fallback={<span class="text-danger">{problem()}</span>}
              >
                {place() ?? ""}
              </Show>
            </span>
          </div>
          <Show when={plan()}>
            {(p) => (
              <dl class="m-0 flex flex-col gap-1 rounded-lg border border-divider px-3.5 py-2.5 text-sm">
                <div class="flex justify-between gap-3">
                  <dt class="text-subtle">Now</dt>
                  <dd class="m-0 truncate text-right mono">{p().now}</dd>
                </div>
                <div class="flex justify-between gap-3">
                  <dt class="text-subtle">After</dt>
                  <dd class="m-0 truncate text-right mono">{p().after || "—"}</dd>
                </div>
                <For each={managed()}>
                  {(t) => (
                    <div class="flex justify-between gap-3">
                      <dt class="text-subtle">Category {t.category ?? "none"}</dt>
                      <dd class="m-0 text-right mono text-warn">
                        no longer followed (automatic management off)
                      </dd>
                    </div>
                  )}
                </For>
              </dl>
            )}
          </Show>
          <Show when={!one() && managed().length > 0}>
            <p class="m-0 text-sm text-warn">
              Automatic management goes off for {formatCount(managed().length)} of them: their
              category's path no longer applies.
            </p>
          </Show>
        </form>
        <div class="flex items-center gap-2 border-t border-divider px-5 py-3.5">
          <span class="min-w-0 flex-1 text-sm text-subtle">
            Runs in the background: the state shows Moving until done.
          </span>
          <Button variant="outline" size="sm" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy() || problem() !== null || (target() === "save" && typed() === "")}
            onClick={() => void move()}
          >
            Move
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
