// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// "Browse": the daemon's directories (`GET /fs/directory`), to pick a path
// on the machine the daemon runs on (not the browser's).

import { createQuery } from "@tanstack/solid-query";
import ArrowUp from "lucide-solid/icons/arrow-up";
import Folder from "lucide-solid/icons/folder";
import { createSignal, For, Show } from "solid-js";

import { api, ApiError, unwrap } from "~/api/client";
import { Button } from "~/components/ui/button";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";

function parent(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const cut = trimmed.lastIndexOf("/");
  return cut <= 0 ? "/" : trimmed.slice(0, cut);
}

export function FolderPicker(props: {
  value: string;
  onPick: (path: string) => void;
  disabled?: boolean;
  /** What the picked folder is for, for its accessible name. */
  what: string;
}) {
  const [open, setOpen] = createSignal(false);
  const [cwd, setCwd] = createSignal("/");
  const dirs = createQuery(() => ({
    queryKey: ["fs", "directory", cwd()],
    queryFn: () =>
      unwrap(api.GET("/api/v1/fs/directory", { params: { query: { path: cwd(), mode: "dirs" } } })),
    enabled: open(),
    retry: false,
  }));
  return (
    <Popover
      open={open()}
      onOpenChange={(o) => {
        if (o) setCwd(props.value.startsWith("/") ? props.value : "/");
        setOpen(o);
      }}
      placement="bottom-end"
      modal
    >
      <PopoverTrigger
        as={Button}
        type="button"
        variant="outline"
        size="md"
        class="flex-none bg-background"
        disabled={props.disabled}
        aria-label={`Browse for the ${props.what}`}
      >
        <Folder />
        Browse
      </PopoverTrigger>
      <PopoverContent class="flex w-80 flex-col gap-2 p-2">
        <PopoverTitle class="sr-only">Choose the {props.what}</PopoverTitle>
        <div class="flex items-center gap-1">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Parent folder"
            disabled={cwd() === "/"}
            onClick={() => setCwd(parent(cwd()))}
          >
            <ArrowUp />
          </Button>
          <span class="truncate mono text-xs text-muted-foreground" title={cwd()}>
            {cwd()}
          </span>
        </div>
        <div class="flex max-h-60 min-h-24 flex-col overflow-auto rounded-md border border-border">
          <Show
            when={!dirs.isError}
            fallback={
              <p class="m-0 p-3 text-sm text-danger">
                {dirs.error instanceof ApiError ? dirs.error.message : "The folder cannot be read."}
              </p>
            }
          >
            <For
              each={dirs.data ?? []}
              fallback={
                <p class="m-0 p-3 text-sm text-subtle">
                  {dirs.isLoading ? "Reading…" : "No folders here."}
                </p>
              }
            >
              {(d) => (
                <button
                  type="button"
                  class="flex h-7 flex-none items-center gap-2 px-2 text-left text-sm text-foreground-2 hover:bg-accent hover:text-foreground"
                  onClick={() => setCwd(d.path)}
                >
                  <Folder size={13} class="flex-none text-subtle" />
                  <span class="truncate">{d.name}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
        <div class="flex justify-end">
          <Button
            type="button"
            size="sm"
            onClick={() => {
              props.onPick(cwd());
              setOpen(false);
            }}
          >
            Choose this folder
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
