// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Adding torrents (`POST /torrents`): magnet links, info-hashes, URLs and
// `.torrent` files in one request with shared options. What failed is
// listed in the dialog, never dropped. The mockups link to an "Add torrent"
// screen that is not designed yet (AGENTS.md 6.4): this is built from the
// same tokens and primitives.

import FileUp from "lucide-solid/icons/file-up";
import X from "lucide-solid/icons/x";
import { createMemo, createSignal, For, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { Button } from "~/components/ui/button";
import { Checkbox, CheckboxLabel } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  TextField,
  TextFieldInput,
  TextFieldLabel,
  TextFieldTextArea,
} from "~/components/ui/text-field";
import { useAuth } from "~/features/auth/auth";
import { useLive } from "~/features/shell/live";

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

export function AddDialog(props: { open: boolean; onClose: () => void }) {
  const auth = useAuth();
  const live = useLive();
  const [links, setLinks] = createSignal("");
  const [files, setFiles] = createSignal<File[]>([]);
  const [category, setCategory] = createSignal("");
  const [tags, setTags] = createSignal("");
  const [savePath, setSavePath] = createSignal("");
  const [stopped, setStopped] = createSignal(false);
  const [sequential, setSequential] = createSignal(false);
  const [firstLast, setFirstLast] = createSignal(false);
  const [top, setTop] = createSignal(false);
  const [failed, setFailed] = createSignal<Schemas["AddFailure"][]>([]);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  let picker: HTMLInputElement | undefined;

  const defaultPath = () => {
    const s = auth.state();
    return s.kind === "signed-in" ? s.app.default_save_path : "";
  };
  const categories = createMemo(() => Object.keys(live.state.categories).sort());
  const urls = () =>
    links()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
  const empty = () => urls().length === 0 && files().length === 0;

  const reset = () => {
    setLinks("");
    setFiles([]);
    setFailed([]);
    setError(null);
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    setFiles((old) => [...old, ...[...list].filter((f) => !old.some((o) => o.name === f.name))]);
  };

  const submit = async () => {
    if (busy() || empty()) return;
    setBusy(true);
    setError(null);
    setFailed([]);
    try {
      const torrents = await Promise.all(
        files().map(async (f) => base64(new Uint8Array(await f.arrayBuffer()))),
      );
      const tagList = tags()
        .split(",")
        .map((t) => t.trim())
        .filter((t) => t !== "");
      const r = await unwrap(
        api.POST("/api/v1/torrents", {
          body: {
            urls: urls(),
            torrents,
            options: {
              category: category().trim() || null,
              tags: tagList,
              save_path: savePath().trim() || null,
              stopped: stopped() || null,
              sequential: sequential(),
              first_last_piece_priority: firstLast(),
              add_to_top_of_queue: top() || null,
            },
          },
        }),
      );
      if (r.added.length > 0) {
        toast.success(
          r.added.length === 1 ? `Added ${r.added[0]?.name}` : `Added ${r.added.length} torrents`,
        );
      }
      if (r.failed.length > 0) {
        setFailed(r.failed);
        const bad = new Set(r.failed.map((f) => f.source));
        setLinks(
          urls()
            .filter((u) => bad.has(u))
            .join("\n"),
        );
        setFiles(files().filter((_, i) => bad.has(`torrents[${i}]`)));
      } else {
        reset();
        props.onClose();
      }
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The torrents could not be added.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent class="max-w-xl">
        <form
          class="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            addFiles(e.dataTransfer?.files ?? null);
          }}
        >
          <DialogHeader>
            <DialogTitle>Add torrents</DialogTitle>
            <DialogDescription>
              Paste magnet links, info-hashes or URLs of .torrent files, or choose .torrent files.
            </DialogDescription>
          </DialogHeader>

          <TextField value={links()} onChange={setLinks}>
            <TextFieldLabel>Links</TextFieldLabel>
            <TextFieldTextArea
              class="min-h-24 mono text-sm"
              placeholder="magnet:?xt=urn:btih:…  (one per line)"
              spellcheck={false}
              autofocus
            />
          </TextField>

          <div class="flex flex-col gap-2">
            <div class="flex items-center gap-2">
              <Button type="button" variant="outline" size="sm" onClick={() => picker?.click()}>
                <FileUp />
                Choose .torrent files
              </Button>
              <span class="text-sm text-subtle">or drop them here</span>
              <input
                ref={picker}
                type="file"
                accept=".torrent,application/x-bittorrent"
                multiple
                class="hidden"
                aria-label="Torrent files"
                onChange={(e) => {
                  addFiles(e.currentTarget.files);
                  e.currentTarget.value = "";
                }}
              />
            </div>
            <Show when={files().length > 0}>
              <ul class="m-0 flex list-none flex-col gap-1 p-0">
                <For each={files()}>
                  {(f) => (
                    <li class="flex items-center gap-2 text-sm text-foreground-2">
                      <span class="truncate mono">{f.name}</span>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${f.name}`}
                        onClick={() => setFiles(files().filter((o) => o !== f))}
                      >
                        <X />
                      </Button>
                    </li>
                  )}
                </For>
              </ul>
            </Show>
          </div>

          <div class="grid grid-cols-2 gap-3">
            <TextField value={category()} onChange={setCategory}>
              <TextFieldLabel>Category</TextFieldLabel>
              <TextFieldInput list="add-categories" placeholder="None" spellcheck={false} />
              <datalist id="add-categories">
                <For each={categories()}>{(c) => <option value={c} />}</For>
              </datalist>
            </TextField>
            <TextField value={tags()} onChange={setTags}>
              <TextFieldLabel>Tags</TextFieldLabel>
              <TextFieldInput placeholder="iso, keep" spellcheck={false} />
            </TextField>
          </div>
          <TextField value={savePath()} onChange={setSavePath}>
            <TextFieldLabel>Save path</TextFieldLabel>
            <TextFieldInput class="mono text-sm" placeholder={defaultPath()} spellcheck={false} />
          </TextField>

          <div class="grid grid-cols-2 gap-x-3 gap-y-2">
            <Checkbox checked={stopped()} onChange={setStopped}>
              <CheckboxLabel>Add stopped</CheckboxLabel>
            </Checkbox>
            <Checkbox checked={top()} onChange={setTop}>
              <CheckboxLabel>Top of the queue</CheckboxLabel>
            </Checkbox>
            <Checkbox checked={sequential()} onChange={setSequential}>
              <CheckboxLabel>Sequential download</CheckboxLabel>
            </Checkbox>
            <Checkbox checked={firstLast()} onChange={setFirstLast}>
              <CheckboxLabel>First and last pieces first</CheckboxLabel>
            </Checkbox>
          </div>

          <Show when={failed().length > 0}>
            <div
              role="alert"
              class="flex flex-col gap-1 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm"
            >
              <span class="font-medium text-danger">Not added:</span>
              <For each={failed()}>
                {(f) => (
                  <span class="text-foreground-2">
                    <span class="mono">
                      {f.source.startsWith("torrents[") ? "a .torrent file" : f.source.slice(0, 60)}
                    </span>
                    : {f.error.message}
                  </span>
                )}
              </For>
            </div>
          </Show>
          <Show when={error()}>
            <p role="alert" class="m-0 text-sm text-danger">
              {error()}
            </p>
          </Show>

          <DialogFooter>
            <Button type="submit" disabled={busy() || empty()}>
              {busy() ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
