// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// "Where a new torrent goes with these settings": added, where its files
// grow while incomplete, where they end up. Drawn from the page's draft, so
// it answers before saving; the counts of what is there now are the live
// store's.

import { type JSX, Show } from "solid-js";

import type { Schemas } from "~/api/client";
import { formatBytes, formatCount } from "~/lib/format";
import { cn } from "~/lib/utils";

function Arrow() {
  return (
    <svg
      width="28"
      height="14"
      viewBox="0 0 28 14"
      aria-hidden="true"
      class="mx-auto flex-none rotate-90 text-faint sm:rotate-0"
    >
      <path d="M0 7h22" stroke="currentColor" stroke-width="1.5" />
      <path d="M20 3 27 7 20 11Z" fill="currentColor" />
    </svg>
  );
}

function Box(props: { title: string; path: JSX.Element; note: string; tone?: "brand" | "ok" }) {
  return (
    <div
      class={cn(
        "flex min-w-0 flex-col gap-0.5 rounded-lg border bg-muted px-3 py-2.5",
        props.tone === "brand"
          ? "border-brand"
          : props.tone === "ok"
            ? "border-ok"
            : "border-border",
      )}
    >
      <span
        class={cn(
          "text-xs",
          props.tone === "brand" ? "text-brand" : props.tone === "ok" ? "text-ok" : "text-subtle",
        )}
      >
        {props.title}
      </span>
      <span class="truncate mono text-sm">{props.path}</span>
      <span class="text-xs text-muted-foreground">{props.note}</span>
    </div>
  );
}

const STARTS: Record<Schemas["StopCondition"], string> = {
  none: "starts at once",
  metadata_received: "stops once the metadata is in",
  files_checked: "stops once its files are checked",
};

export function PathFlow(props: {
  savePath: string;
  /** The download path, when one is on. */
  downloadPath: string | null;
  suffix: string | null;
  autoManagement: boolean;
  manualCategoryPaths: boolean;
  stopCondition: Schemas["StopCondition"];
  addStopped: boolean;
  recheck: boolean;
  /** Free space where the saved save path is. */
  free: { path: string; bytes: number } | null;
  /** What is in the download path now. */
  staged: { count: number; bytes: number };
}) {
  const save = () => props.savePath.replace(/\/+$/, "") || "/";
  const destination = () => (
    <>
      {props.autoManagement ? `${save().replace(/\/$/, "")}/` : save()}
      <Show when={props.autoManagement}>
        <span class="text-subtle">{"{category}"}</span>
      </Show>
    </>
  );
  const growing = () => (
    <>
      <Show when={props.downloadPath} fallback={destination()}>
        {(d) => d().replace(/\/+$/, "")}
      </Show>
      /<span class="text-subtle">…</span>
      <Show when={props.suffix}>
        <span class="text-warn">{props.suffix}</span>
      </Show>
    </>
  );
  const recheck = () => (props.recheck ? "recheck on" : "recheck off");
  const where = () =>
    props.autoManagement
      ? `no category → ${save()}`
      : props.manualCategoryPaths
        ? "a category without a path of its own → its path"
        : "categories do not change it";
  return (
    <div class="flex flex-col gap-3 border-t border-accent px-4 pt-3.5 pb-4">
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span class="text-sm text-subtle">Where a new torrent goes with these settings</span>
        <Show when={props.free}>
          {(f) => (
            <span class="mono text-sm text-subtle">
              {f().path} · {formatBytes(f().bytes)} free
            </span>
          )}
        </Show>
      </div>
      <div class="grid grid-cols-1 items-center gap-2 sm:grid-cols-[minmax(0,1fr)_28px_minmax(0,1fr)_28px_minmax(0,1.3fr)]">
        <Box
          title="Added"
          path="magnet · .torrent · URL"
          note={props.addStopped ? "added stopped" : STARTS[props.stopCondition]}
        />
        <Arrow />
        <Box
          title="While incomplete"
          tone="brand"
          path={growing()}
          note={
            props.downloadPath === null
              ? "in place, no separate folder"
              : `${props.staged.count === 1 ? "1 torrent" : `${formatCount(props.staged.count)} torrents`} here now · ${formatBytes(props.staged.bytes)}`
          }
        />
        <Arrow />
        <Box
          title={
            props.downloadPath === null
              ? "Complete"
              : `On completion → ${props.autoManagement ? "category path" : "save path"}`
          }
          tone="ok"
          path={destination()}
          note={`${where()} · ${recheck()}`}
        />
      </div>
    </div>
  );
}
