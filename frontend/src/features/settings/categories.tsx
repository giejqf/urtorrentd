// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Downloads page's category paths: each category's save and download
// path and its torrents now, from the live store; adding, editing and
// removing one are API calls of their own (`/categories`), not part of the
// page's draft. Editing sends the category whole, its share limits
// included, because `PUT /categories` replaces it.

import Plus from "lucide-solid/icons/plus";
import { createEffect, createMemo, createSignal, For, on, Show, untrack } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { FolderPicker } from "~/components/folder-picker";
import { StatusDot } from "~/components/status-dot";
import {
  AlertDialog,
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
import { useLive } from "~/features/shell/live";
import { formatCount } from "~/lib/format";
import { categoryTone } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { categoryDownloadPath, categorySavePath } from "./paths";

type Category = Schemas["Category"];

/** Which dialog is open: a new category, or the one being edited. */
type Editing = { kind: "new" } | { kind: "edit"; name: string };

export function CategoryPaths(props: { savePath: string; downloadPath: string | null }) {
  const live = useLive();
  const [editing, setEditing] = createSignal<Editing | null>(null);
  const names = createMemo(() =>
    Object.keys(live.state.categories).sort((a, b) => a.localeCompare(b)),
  );
  const counts = createMemo(() => {
    const m = new Map<string, number>();
    for (const t of live.torrents()) {
      if (t.category !== null) m.set(t.category, (m.get(t.category) ?? 0) + 1);
    }
    return m;
  });
  // The design's 120px / 1fr / 1fr / 70px columns, 12px apart, 16px in.
  const td = "truncate px-1.5 first:pl-4 last:pr-4";
  const row = "border-b border-accent";
  return (
    <>
      <div class="flex flex-col rounded-tile border border-divider bg-card">
        <table class="w-full table-fixed border-collapse text-sm">
          <colgroup>
            <col class="w-[142px]" />
            <col />
            <col />
            <col class="w-[92px]" />
          </colgroup>
          <thead>
            <tr class={cn(row, "h-[30px] text-xs text-subtle")}>
              <th class={cn(td, "text-left font-normal")}>Category</th>
              <th class={cn(td, "text-left font-normal")}>Save path</th>
              <th class={cn(td, "text-left font-normal")}>Download path</th>
              <th class={cn(td, "text-right font-normal")}>Torrents</th>
            </tr>
          </thead>
          <tbody>
            <For
              each={names()}
              fallback={
                <tr class={cn(row, "h-9 text-subtle")}>
                  <td class={td} colSpan={4}>
                    No categories yet.
                  </td>
                </tr>
              }
            >
              {(name) => {
                const c = () =>
                  live.state.categories[name] ?? { save_path: null, download_path: null };
                const save = () => categorySavePath(props.savePath, name, c());
                const dl = () => categoryDownloadPath(props.downloadPath, c());
                return (
                  <tr
                    class={cn(row, "h-9 cursor-pointer hover:bg-accent/60")}
                    onClick={() => setEditing({ kind: "edit", name })}
                  >
                    <td class={td}>
                      <span class="flex min-w-0 items-center gap-2">
                        <StatusDot class={categoryTone(name)} />
                        <button
                          type="button"
                          class="min-w-0 truncate text-left hover:underline focus-visible:underline focus-visible:outline-none"
                          aria-label={`Edit category ${name}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing({ kind: "edit", name });
                          }}
                        >
                          {name}
                        </button>
                      </span>
                    </td>
                    <td class={cn(td, "mono")} title={save()}>
                      {c().save_path ?? name}
                    </td>
                    <td
                      class={cn(td, "mono text-muted-foreground")}
                      title={dl() ?? "Straight to the save path"}
                    >
                      {c().download_path ?? "— (global)"}
                    </td>
                    <td class={cn(td, "text-right mono text-muted-foreground")}>
                      {formatCount(counts().get(name) ?? 0)}
                    </td>
                  </tr>
                );
              }}
            </For>
          </tbody>
        </table>
        <div class="flex h-10 items-center px-4">
          <Button
            variant="ghost"
            size="sm"
            class="-ml-2 text-muted-foreground"
            onClick={() => setEditing({ kind: "new" })}
          >
            <Plus />
            Add category
          </Button>
        </div>
      </div>
      <CategoryDialog
        editing={editing()}
        savePath={props.savePath}
        count={(n) => counts().get(n) ?? 0}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

const input =
  "h-full w-full min-w-0 bg-transparent px-3 mono text-sm text-foreground outline-none placeholder:text-subtle";
const box =
  "flex h-9 items-center overflow-hidden rounded-lg border border-input bg-background focus-within:border-ring focus-within:shadow-focus";

function CategoryDialog(props: {
  editing: Editing | null;
  savePath: string;
  count: (name: string) => number;
  onClose: () => void;
}) {
  const live = useLive();
  const [name, setName] = createSignal("");
  const [save, setSave] = createSignal("");
  const [dl, setDl] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [confirmRemove, setConfirmRemove] = createSignal(false);

  const editName = () => {
    const e = props.editing;
    return e?.kind === "edit" ? e.name : null;
  };
  const existing = (): Category | undefined => {
    const n = editName();
    return n === null ? undefined : live.state.categories[n];
  };
  // Each opening starts from the category as it is then.
  createEffect(
    on(
      () => props.editing,
      (e) => {
        if (e === null) return;
        const c = untrack(existing);
        setName(e.kind === "edit" ? e.name : "");
        setSave(c?.save_path ?? "");
        setDl(c?.download_path ?? "");
        setProblem(null);
        setConfirmRemove(false);
      },
    ),
  );

  const target = () => editName() ?? name().trim();
  const submit = async () => {
    const n = target();
    if (n === "" || busy()) return;
    const body: Schemas["CategoryDefinition"] = {
      name: n,
      save_path: save().trim() === "" ? null : save().trim(),
      download_path: dl().trim() === "" ? null : dl().trim(),
    };
    setBusy(true);
    try {
      if (editName() === null) {
        await unwrap(api.POST("/api/v1/categories", { body }));
        toast.success(`Category ${n} added`);
      } else {
        // `PUT` replaces the category: keep its share limits as the daemon
        // has them now (the live store can be a second behind).
        const now = await unwrap(api.GET("/api/v1/categories"));
        const limits = now[n]?.share_limits;
        if (limits) body.share_limits = limits;
        await unwrap(api.PUT("/api/v1/categories", { body }));
        toast.success(`Category ${n} saved`);
      }
      props.onClose();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "The category could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    const n = editName();
    if (n === null) return;
    setBusy(true);
    try {
      await unwrap(api.POST("/api/v1/categories/remove", { body: { names: [n] } }));
      toast.success(`Category ${n} removed`);
      setConfirmRemove(false);
      props.onClose();
    } catch (e) {
      setConfirmRemove(false);
      setProblem(e instanceof ApiError ? e.message : "The category could not be removed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Dialog
        open={props.editing !== null && !confirmRemove()}
        onOpenChange={(o) => {
          if (!o && !confirmRemove()) props.onClose();
        }}
      >
        <DialogContent class="max-w-md">
          <form
            class="flex flex-col gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {editName() === null ? "Add category" : `Category ${editName() ?? ""}`}
              </DialogTitle>
              <DialogDescription>
                Automatically managed torrents in it save here.
                {editName() === null ? "" : " Changing a path moves them."}
              </DialogDescription>
            </DialogHeader>
            <Show when={editName() === null}>
              <div class="flex flex-col gap-1.5">
                <label for="category-name" class="text-sm font-medium">
                  Name
                </label>
                <div class={box}>
                  <input
                    id="category-name"
                    class={cn(input, "font-sans")}
                    value={name()}
                    spellcheck={false}
                    autofocus
                    onInput={(e) => setName(e.currentTarget.value)}
                  />
                </div>
                <p class="m-0 text-sm text-subtle">A slash makes a subcategory: tv/shows.</p>
              </div>
            </Show>
            <div class="flex flex-col gap-1.5">
              <label for="category-save" class="text-sm font-medium">
                Save path
              </label>
              <div class={box}>
                <input
                  id="category-save"
                  class={input}
                  value={save()}
                  placeholder={target() === "" ? "name" : target()}
                  spellcheck={false}
                  onInput={(e) => setSave(e.currentTarget.value)}
                />
                <FolderPicker
                  inline
                  value={save().startsWith("/") ? save() : props.savePath}
                  what="category's save path"
                  onPick={setSave}
                />
              </div>
              <p class="m-0 text-sm text-subtle">
                Empty: {props.savePath.replace(/\/+$/, "")}/{target() === "" ? "<name>" : target()}.
                A relative path goes under the save path.
              </p>
            </div>
            <div class="flex flex-col gap-1.5">
              <label for="category-download" class="text-sm font-medium">
                Download path
              </label>
              <div class={box}>
                <input
                  id="category-download"
                  class={input}
                  value={dl()}
                  placeholder="the global download path"
                  spellcheck={false}
                  onInput={(e) => setDl(e.currentTarget.value)}
                />
                <FolderPicker
                  inline
                  value={dl().startsWith("/") ? dl() : props.savePath}
                  what="category's download path"
                  onPick={setDl}
                />
              </div>
              <p class="m-0 text-sm text-subtle">
                Where they stay until complete. A relative path goes under the global download path.
              </p>
            </div>
            <Show when={problem()}>
              <p class="m-0 text-sm text-danger" role="alert">
                {problem()}
              </p>
            </Show>
            <DialogFooter class="sm:justify-between">
              <div>
                <Show when={editName() !== null}>
                  <Button
                    type="button"
                    variant="ghost"
                    class="text-danger hover:text-danger"
                    onClick={() => setConfirmRemove(true)}
                  >
                    Remove
                  </Button>
                </Show>
              </div>
              <div class="flex flex-col-reverse gap-2 sm:flex-row">
                <Button type="button" variant="outline" onClick={() => props.onClose()}>
                  Cancel
                </Button>
                <Button type="submit" disabled={target() === "" || busy()}>
                  {editName() === null ? "Add category" : "Save"}
                </Button>
              </div>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmRemove()} onOpenChange={(o) => !o && setConfirmRemove(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove category {editName()}?</AlertDialogTitle>
            <AlertDialogDescription>
              {(() => {
                const n = props.count(editName() ?? "");
                return n === 0
                  ? "No torrent is in it."
                  : `${n === 1 ? "Its torrent loses" : `Its ${formatCount(n)} torrents lose`} the category; automatically managed ones move to ${props.savePath}.`;
              })()}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmRemove(false)}>
              Keep it
            </Button>
            <Button variant="destructive" disabled={busy()} onClick={() => void remove()}>
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
