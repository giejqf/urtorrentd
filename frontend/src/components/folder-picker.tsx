// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// "Browse": the daemon's directories (`GET /fs/directory`), to pick a path
// on the machine the daemon runs on (not the browser's): a folder, or a file
// with a given extension (`pickFile`).

import { createQuery } from "@tanstack/solid-query";
import ArrowUp from "lucide-solid/icons/arrow-up";
import File from "lucide-solid/icons/file";
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
  /** An icon inside a field's box (settings) instead of a "Browse" button. */
  inline?: boolean;
  /** Pick a file with this extension (`.mmdb`) instead of a folder. */
  pickFile?: string;
}) {
  const [open, setOpen] = createSignal(false);
  const [cwd, setCwd] = createSignal("/");
  const entries = createQuery(() => ({
    queryKey: ["fs", "directory", cwd(), props.pickFile ? "all" : "dirs"],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/fs/directory", {
          params: { query: { path: cwd(), mode: props.pickFile ? "all" : "dirs" } },
        }),
      ),
    enabled: open(),
    retry: false,
  }));
  const shown = () =>
    (entries.data ?? []).filter(
      (e) => e.is_dir || (props.pickFile !== undefined && e.name.endsWith(props.pickFile)),
    );
  return (
    <Popover
      open={open()}
      onOpenChange={(o) => {
        // A file's folder, or the folder typed.
        if (o) {
          const v = props.value.startsWith("/") ? props.value : "/";
          setCwd(props.pickFile && v.endsWith(props.pickFile) ? parent(v) : v);
        }
        setOpen(o);
      }}
      placement="bottom-end"
      modal
    >
      <Show
        when={props.inline}
        fallback={
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
        }
      >
        <PopoverTrigger
          type="button"
          class="flex h-full w-8 flex-none items-center justify-center border-l border-border bg-card text-muted-foreground hover:text-foreground focus-visible:shadow-focus focus-visible:outline-none disabled:opacity-50"
          disabled={props.disabled}
          aria-label={`Browse for the ${props.what}`}
        >
          <Folder size={14} />
        </PopoverTrigger>
      </Show>
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
            when={!entries.isError}
            fallback={
              <p class="m-0 p-3 text-sm text-danger">
                {entries.error instanceof ApiError
                  ? entries.error.message
                  : "The folder cannot be read."}
              </p>
            }
          >
            <For
              each={shown()}
              fallback={
                <p class="m-0 p-3 text-sm text-subtle">
                  {entries.isLoading
                    ? "Reading…"
                    : props.pickFile
                      ? `No folders or ${props.pickFile} files here.`
                      : "No folders here."}
                </p>
              }
            >
              {(d) => (
                <button
                  type="button"
                  class="flex h-7 flex-none items-center gap-2 px-2 text-left text-sm text-foreground-2 hover:bg-accent hover:text-foreground"
                  onClick={() => {
                    if (d.is_dir) {
                      setCwd(d.path);
                    } else {
                      props.onPick(d.path);
                      setOpen(false);
                    }
                  }}
                >
                  <Show when={d.is_dir} fallback={<File size={13} class="flex-none text-subtle" />}>
                    <Folder size={13} class="flex-none text-subtle" />
                  </Show>
                  <span class="truncate">{d.name}</span>
                </button>
              )}
            </For>
          </Show>
        </div>
        <Show when={props.pickFile === undefined}>
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
        </Show>
      </PopoverContent>
    </Popover>
  );
}
