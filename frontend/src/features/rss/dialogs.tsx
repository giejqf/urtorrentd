// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Adding and editing a feed (its URL, name, folder and refresh interval:
// the one place its full URL shows, as the user edits it), and asking
// before something is removed.

import { createEffect, createSignal, For, on, Show } from "solid-js";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";

type Feed = Schemas["RssFeed"];

const field =
  "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-subtle focus:border-ring focus:shadow-focus";

/** Minutes typed as seconds; empty = the setting (`null`); `undefined` = not valid. */
export function intervalOf(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d+(\.\d+)?$/.test(t) || Number(t) < 1) return undefined;
  return Math.round(Number(t) * 60);
}

/** A feed's form: a new one (`feed` null), or one to change. */
export function FeedDialog(props: {
  open: boolean;
  feed: Feed | null;
  folders: readonly string[];
  /** The folder a new feed goes in. */
  folder?: string | null;
  onClose: () => void;
  onSaved: (f: Feed) => void;
}) {
  const [url, setUrl] = createSignal("");
  const [name, setName] = createSignal("");
  const [folder, setFolder] = createSignal("");
  const [every, setEvery] = createSignal("");
  const [problem, setProblem] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        const f = props.feed;
        setUrl(f?.url ?? "");
        setName(f?.name ?? "");
        setFolder(f ? (f.folder ?? "") : (props.folder ?? ""));
        setEvery(f?.refresh_interval != null ? String(f.refresh_interval / 60) : "");
        setProblem(null);
      },
    ),
  );
  const submit = async () => {
    const interval = intervalOf(every());
    if (interval === undefined) {
      setProblem("Minutes, at least 1; empty follows the setting.");
      return;
    }
    const body = {
      url: url().trim(),
      name: name().trim() === "" ? null : name().trim(),
      folder:
        folder().trim() === ""
          ? null
          : folder()
              .trim()
              .replace(/^\/+|\/+$/g, ""),
      refresh_interval: interval,
    };
    setBusy(true);
    try {
      const f = props.feed;
      const saved = f
        ? await unwrap(
            api.PATCH("/api/v1/rss/feeds/{id}", { params: { path: { id: f.id } }, body }),
          )
        : await unwrap(api.POST("/api/v1/rss/feeds", { body }));
      props.onSaved(saved);
      props.onClose();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "The feed could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const label = "text-sm font-medium";
  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="max-w-md">
        <form
          class="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.feed ? "Edit feed" : "Add feed"}</DialogTitle>
            <DialogDescription>
              {props.feed
                ? "A new URL is read at once."
                : "It is read at once, then as often as the polling settings say."}
            </DialogDescription>
          </DialogHeader>
          <div class="flex flex-col gap-1.5">
            <label for="feed-url" class={label}>
              URL
            </label>
            <input
              id="feed-url"
              class={`${field} mono`}
              placeholder="https://indexer.example/rss"
              value={url()}
              spellcheck={false}
              autocomplete="off"
              autofocus
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="feed-name" class={label}>
              Name
            </label>
            <input
              id="feed-name"
              class={field}
              placeholder="the feed's own title"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </div>
          <div class="grid grid-cols-2 gap-3">
            <div class="flex flex-col gap-1.5">
              <label for="feed-folder" class={label}>
                Folder
              </label>
              <input
                id="feed-folder"
                class={field}
                placeholder="none"
                list="feed-folders"
                value={folder()}
                spellcheck={false}
                onInput={(e) => setFolder(e.currentTarget.value)}
              />
              <datalist id="feed-folders">
                <For each={props.folders}>{(f) => <option value={f} />}</For>
              </datalist>
            </div>
            <div class="flex flex-col gap-1.5">
              <label for="feed-every" class={label}>
                Refresh every (min)
              </label>
              <input
                id="feed-every"
                class={`${field} mono`}
                placeholder="the setting"
                inputMode="decimal"
                value={every()}
                onInput={(e) => setEvery(e.currentTarget.value)}
              />
            </div>
          </div>
          <Show when={problem()}>
            <p class="m-0 text-sm text-danger" role="alert">
              {problem()}
            </p>
          </Show>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => props.onClose()}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy() || url().trim() === ""}>
              {props.feed ? "Save feed" : "Add feed"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Ask before removing something. */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  description: string;
  action: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose as={Button} variant="outline" aria-label="Cancel">
            Cancel
          </AlertDialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              props.onConfirm();
              props.onClose();
            }}
          >
            {props.action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
