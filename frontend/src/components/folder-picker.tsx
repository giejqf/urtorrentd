// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// "Browse": a dialog over the daemon's directories (`GET /fs/directory`) to
// pick a path on the machine the daemon runs on, not the browser's: a
// folder, or a file with a given extension (`pickFile`). It shows where it
// is, the free space there (`GET /fs/file-system`), what each folder holds
// and whether the daemon can write in it; a path can be typed too (one
// that does not exist yet is made when content goes there).

import { createQuery } from "@tanstack/solid-query";
import ChevronRight from "lucide-solid/icons/chevron-right";
import File from "lucide-solid/icons/file";
import Folder from "lucide-solid/icons/folder";
import { createEffect, createSignal, For, on, Show } from "solid-js";

import { api, ApiError, unwrap } from "~/api/client";
import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { formatBytes } from "~/lib/format";
import { cn } from "~/lib/utils";

import { crumbs, itemsLabel, parentOf } from "./folder-paths";

function FolderDialog(props: {
  open: boolean;
  value: string;
  what: string;
  purpose?: string;
  pickFile?: string;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const [cwd, setCwd] = createSignal("/");
  const [path, setPath] = createSignal("");
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        const v = props.value.startsWith("/") ? props.value : "/";
        // Nothing typed yet: the root, as a start.
        setPath(props.value.startsWith("/") ? props.value : props.pickFile ? "" : "/");
        setCwd(props.pickFile && v.endsWith(props.pickFile) ? parentOf(v) : v);
      },
    ),
  );
  const entries = createQuery(() => ({
    queryKey: ["fs", "directory", cwd(), props.pickFile ? "all" : "dirs"],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/fs/directory", {
          params: { query: { path: cwd(), mode: props.pickFile ? "all" : "dirs" } },
        }),
      ),
    enabled: props.open,
    retry: false,
  }));
  const space = createQuery(() => ({
    queryKey: ["fs", "file-system", cwd()],
    queryFn: () =>
      unwrap(api.GET("/api/v1/fs/file-system", { params: { query: { path: cwd() } } })),
    enabled: props.open,
    retry: false,
  }));
  // A path that does not exist yet opens at its nearest existing folder.
  createEffect(() => {
    const e = entries.error;
    if (e instanceof ApiError && e.status === 404 && cwd() !== "/") setCwd(parentOf(cwd()));
  });
  const shown = () =>
    (entries.data ?? []).filter(
      (e) => e.is_dir || (props.pickFile !== undefined && e.name.endsWith(props.pickFile)),
    );
  const chosen = () => shown().find((e) => e.path === path());
  const valid = () => {
    const p = path().trim();
    if (!p.startsWith("/")) return false;
    return props.pickFile === undefined || p.endsWith(props.pickFile);
  };
  const go = (dir: string) => {
    setCwd(dir);
    if (props.pickFile === undefined) setPath(dir);
  };
  const choose = () => {
    if (valid()) props.onPick(path().trim());
  };
  const kind = () => (props.pickFile ? "file" : "folder");
  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="max-w-[600px] gap-0 p-0">
        <div class="flex flex-col gap-0.5 px-5 pt-[18px] pr-12">
          <DialogTitle>Choose a {kind()}</DialogTitle>
          <DialogDescription class="text-sm text-subtle">
            The {props.what}, on the daemon's machine
          </DialogDescription>
        </div>
        <div class="flex items-center gap-1.5 px-5 pt-3.5 pb-2.5">
          <nav aria-label="Where" class="flex min-w-0 flex-wrap items-center gap-1">
            <For each={crumbs(cwd())}>
              {(c, i) => (
                <>
                  <Show when={i() > 0}>
                    <ChevronRight size={12} class="flex-none text-subtle" aria-hidden="true" />
                  </Show>
                  <Button
                    variant="outline"
                    size="xs"
                    class={cn("mono", c.path === cwd() && "bg-accent text-foreground")}
                    aria-current={c.path === cwd() ? "location" : undefined}
                    onClick={() => go(c.path)}
                  >
                    {c.name}
                  </Button>
                </>
              )}
            </For>
          </nav>
          <span class="flex-1" />
          <Show when={space.data}>
            {(fs) => (
              <span class="flex-none mono text-xs text-subtle">
                {formatBytes(fs().free)} free of {formatBytes(fs().total)}
              </span>
            )}
          </Show>
        </div>
        <div class="max-h-[300px] min-h-[160px] overflow-auto border-y border-divider">
          <Show when={cwd() !== "/"}>
            <button
              type="button"
              class="grid h-[34px] w-full grid-cols-[16px_minmax(0,1fr)_70px_80px] items-center gap-2.5 border-b border-row-divider px-3 text-left text-sm hover:bg-muted"
              onClick={() => go(parentOf(cwd()))}
            >
              <span class="text-subtle" aria-hidden="true">
                ↑
              </span>
              <span class="mono">..</span>
              <span />
              <span class="text-right text-xs text-subtle">parent</span>
            </button>
          </Show>
          <div role="listbox" aria-label={`Folders in ${cwd()}`}>
            <Show
              when={
                !entries.isError ||
                (entries.error instanceof ApiError && entries.error.status === 404)
              }
              fallback={
                <p class="m-0 p-4 text-sm text-danger">
                  {entries.error instanceof ApiError
                    ? entries.error.message
                    : "The folder cannot be read."}
                </p>
              }
            >
              <For
                each={shown()}
                fallback={
                  <p class="m-0 p-4 text-sm text-subtle">
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
                    role="option"
                    aria-selected={path() === d.path}
                    title={d.is_dir ? "Click again to open" : undefined}
                    class={cn(
                      "grid h-[34px] w-full grid-cols-[16px_minmax(0,1fr)_70px_80px] items-center gap-2.5 border-b border-row-divider px-3 text-left text-sm",
                      path() === d.path ? "bg-accent" : "hover:bg-muted",
                      d.is_dir && !d.writable && "text-subtle",
                    )}
                    onClick={() => {
                      if (d.is_dir && path() === d.path) go(d.path);
                      else setPath(d.path);
                    }}
                    onDblClick={() => {
                      if (d.is_dir) go(d.path);
                      else props.onPick(d.path);
                    }}
                  >
                    <Show when={d.is_dir} fallback={<File size={13} class="text-subtle" />}>
                      <Folder size={13} class="text-subtle" />
                    </Show>
                    <span class="truncate mono">{d.name}</span>
                    <span class="text-right mono text-xs text-muted-foreground">
                      {d.is_dir ? itemsLabel(d.entries) : ""}
                    </span>
                    <span class="text-right text-xs text-subtle">
                      {d.is_dir ? (d.writable ? "writable" : "read-only") : ""}
                    </span>
                  </button>
                )}
              </For>
            </Show>
          </div>
        </div>
        <form
          class="flex flex-col gap-1.5 px-5 pt-3.5 pb-3"
          onSubmit={(e) => {
            e.preventDefault();
            choose();
          }}
        >
          <label for="folder-path" class="text-sm font-medium">
            Path
          </label>
          <input
            id="folder-path"
            class="h-[30px] rounded-md border border-border bg-background px-2.5 mono text-sm text-foreground outline-none focus:border-ring focus:shadow-focus"
            spellcheck={false}
            value={path()}
            onInput={(e) => setPath(e.currentTarget.value)}
          />
          <span class="text-sm text-subtle">
            <Show
              when={chosen()?.is_dir && chosen()?.writable === false && !props.pickFile}
              fallback={
                props.pickFile
                  ? `Type a path, or pick a ${props.pickFile} file above.`
                  : "Type a path, or pick above; a folder that does not exist yet is made when content goes there. Folders the daemon cannot write to are greyed out."
              }
            >
              <span class="text-warn">The daemon cannot write in this folder.</span>
            </Show>
          </span>
        </form>
        <div class="flex items-center gap-2 border-t border-divider px-5 py-3.5">
          <span class="min-w-0 flex-1 text-sm text-subtle">{props.purpose ?? ""}</span>
          <Button variant="outline" size="sm" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button size="sm" class="max-w-[260px]" disabled={!valid()} onClick={choose}>
            <span class="truncate">Choose {path().trim() || kind()}</span>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function FolderPicker(props: {
  value: string;
  onPick: (path: string) => void;
  disabled?: boolean;
  /** What the picked folder is for, for its accessible name. */
  what: string;
  /** A line in the dialog's footer: "Used as the save path of …". */
  purpose?: string;
  /** An icon inside a field's box (settings) instead of a "Browse" button. */
  inline?: boolean;
  /** Pick a file with this extension (`.mmdb`) instead of a folder. */
  pickFile?: string;
}) {
  const [open, setOpen] = createSignal(false);
  return (
    <>
      <Show
        when={props.inline}
        fallback={
          <Button
            type="button"
            variant="outline"
            size="md"
            class="flex-none bg-background"
            disabled={props.disabled}
            aria-label={`Browse for the ${props.what}`}
            onClick={() => setOpen(true)}
          >
            <Folder />
            Browse
          </Button>
        }
      >
        <button
          type="button"
          class="flex h-full w-8 flex-none items-center justify-center border-l border-border bg-card text-muted-foreground hover:text-foreground focus-visible:shadow-focus focus-visible:outline-none disabled:opacity-50"
          disabled={props.disabled}
          aria-label={`Browse for the ${props.what}`}
          onClick={() => setOpen(true)}
        >
          <Folder size={14} />
        </button>
      </Show>
      <FolderDialog
        open={open()}
        value={props.value}
        what={props.what}
        purpose={props.purpose}
        pickFile={props.pickFile}
        onClose={() => setOpen(false)}
        onPick={(p) => {
          props.onPick(p);
          setOpen(false);
        }}
      />
    </>
  );
}
