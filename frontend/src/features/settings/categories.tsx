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
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { useLive } from "~/features/shell/live";
import { formatCount } from "~/lib/format";
import { categoryTone } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { categoryDownloadPath, categoryMoves, categorySavePath } from "./paths";

type Category = Schemas["Category"];

/** Which dialog is open: a new category, the one being edited, or the question
 * before removing one (asked alone when `remove`). */
export type CategoryEditing = { kind: "new" } | { kind: "edit"; name: string; remove?: boolean };
type Editing = CategoryEditing;

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
        downloadPath={props.downloadPath}
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

export function CategoryDialog(props: {
  editing: Editing | null;
  savePath: string;
  /** The global download path; `null` = none. */
  downloadPath: string | null;
  count: (name: string) => number;
  onClose: () => void;
  /** After it is removed. */
  onRemoved?: (name: string) => void;
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
  /** Only the question was asked for: keeping the category closes it all. */
  const removeOnly = () => {
    const e = props.editing;
    return e?.kind === "edit" && e.remove === true;
  };
  const keep = () => {
    if (removeOnly()) props.onClose();
    setConfirmRemove(false);
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
        setConfirmRemove(e.kind === "edit" && e.remove === true);
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
      props.onRemoved?.(n);
      props.onClose();
      setConfirmRemove(false);
    } catch (e) {
      const message = e instanceof ApiError ? e.message : "The category could not be removed.";
      if (removeOnly()) {
        toast.error(message);
        props.onClose();
      } else {
        setProblem(message);
      }
      setConfirmRemove(false);
    } finally {
      setBusy(false);
    }
  };

  const moves = createMemo(() => categoryMoves(live.torrents(), editName() ?? ""));
  const movesLine = () => {
    const m = moves();
    const manual =
      m.manual.length === 0
        ? ""
        : m.manual.length === 1
          ? ` ${m.manual[0] ?? ""} is managed manually and stays where it is.`
          : ` ${formatCount(m.manual.length)} managed manually stay where they are.`;
    if (m.managed === 0) return `Its torrents are managed manually: they stay where they are.`;
    return `Changing a path moves the ${m.managed === 1 ? "automatically managed torrent" : `${formatCount(m.managed)} automatically managed torrents`} in this category.${manual}`;
  };
  const resolved = () =>
    categorySavePath(props.savePath, target() || "<name>", {
      save_path: save().trim() === "" ? null : save().trim(),
      download_path: null,
    });
  const label = "text-sm font-medium";

  return (
    <>
      <Dialog
        open={props.editing !== null && !confirmRemove()}
        onOpenChange={(o) => {
          if (!o && !confirmRemove()) props.onClose();
        }}
      >
        <DialogContent class="max-w-[540px] gap-0 p-0">
          <form
            class="flex flex-col"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div class="flex flex-col gap-0.5 px-5 pt-[18px] pr-12">
              <DialogTitle>
                {editName() === null ? "Add category" : `Edit category — ${editName() ?? ""}`}
              </DialogTitle>
              <DialogDescription class="text-sm text-subtle">
                {editName() === null
                  ? "Automatically managed torrents in it save here."
                  : `${formatCount(moves().total)} ${moves().total === 1 ? "torrent" : "torrents"}`}
              </DialogDescription>
            </div>
            <div class="flex flex-col gap-4 px-5 pt-4 pb-4">
              <div class="flex flex-col gap-1.5">
                <label for="category-name" class={label}>
                  Name
                </label>
                <div class={cn(box, editName() !== null && "opacity-60")}>
                  <input
                    id="category-name"
                    class={input}
                    value={editName() ?? name()}
                    readOnly={editName() !== null}
                    spellcheck={false}
                    autofocus={editName() === null}
                    onInput={(e) => setName(e.currentTarget.value)}
                  />
                </div>
                <p class="m-0 text-sm text-subtle">
                  {editName() === null
                    ? "A slash makes a subcategory: tv/shows."
                    : "A category cannot be renamed: make a new one and move its torrents to it."}
                </p>
              </div>
              <div class="flex flex-col gap-1.5">
                <label for="category-save" class={label}>
                  Save path
                </label>
                <div class="flex gap-1.5">
                  <div class={cn(box, "flex-1")}>
                    <input
                      id="category-save"
                      class={input}
                      value={save()}
                      placeholder={target() === "" ? "name" : target()}
                      spellcheck={false}
                      onInput={(e) => setSave(e.currentTarget.value)}
                    />
                  </div>
                  <FolderPicker
                    value={save().startsWith("/") ? save() : resolved()}
                    what="category's save path"
                    purpose={`Used as the save path of ${target() || "the category"}`}
                    onPick={setSave}
                  />
                </div>
                <p class="m-0 text-sm text-subtle">
                  <Show
                    when={save().trim().startsWith("/")}
                    fallback={
                      <>
                        Relative to the default save path →{" "}
                        <span class="mono text-muted-foreground">{resolved()}</span>. Absolute paths
                        allowed.
                      </>
                    }
                  >
                    An absolute path.
                  </Show>
                </p>
              </div>
              <div class="flex flex-col gap-1.5">
                <label for="category-download" class={label}>
                  Download path
                </label>
                <div class="flex gap-1.5">
                  <div class={cn(box, "flex-1")}>
                    <input
                      id="category-download"
                      class={input}
                      value={dl()}
                      placeholder={
                        props.downloadPath === null
                          ? "none: straight to the save path"
                          : `global (${props.downloadPath})`
                      }
                      spellcheck={false}
                      onInput={(e) => setDl(e.currentTarget.value)}
                    />
                  </div>
                  <FolderPicker
                    value={dl().startsWith("/") ? dl() : (props.downloadPath ?? props.savePath)}
                    what="category's download path"
                    purpose={`Used as the download path of ${target() || "the category"}`}
                    onPick={setDl}
                  />
                </div>
                <p class="m-0 text-sm text-subtle">
                  Where they stay until complete. A relative path goes under the global download
                  path.
                </p>
              </div>
              <Show when={editName() !== null && moves().total > 0}>
                <p
                  class="m-0 flex gap-2 rounded-lg border border-warn/40 bg-warn/8 px-3.5 py-2.5 text-sm text-foreground-2"
                  role="note"
                >
                  <span class="text-warn" aria-hidden="true">
                    !
                  </span>
                  <span>{movesLine()}</span>
                </p>
              </Show>
              <Show when={problem()}>
                <p class="m-0 text-sm text-danger" role="alert">
                  {problem()}
                </p>
              </Show>
            </div>
            <div class="flex items-center gap-2 border-t border-divider px-5 py-3.5">
              <Show when={editName() !== null}>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  class="border-danger/40 text-danger hover:bg-danger/10 hover:text-danger"
                  onClick={() => setConfirmRemove(true)}
                >
                  Remove category
                </Button>
              </Show>
              <span class="flex-1" />
              <Button type="button" variant="outline" size="sm" onClick={() => props.onClose()}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={target() === "" || busy()}>
                {editName() === null ? "Add category" : "Save"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmRemove()} onOpenChange={(o) => !o && keep()}>
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
            <Button variant="outline" onClick={keep}>
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
