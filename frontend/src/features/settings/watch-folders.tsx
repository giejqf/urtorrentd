// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Watch folders, as the design has it: each folder with its
// standing (`GET /watch-folders`: when it was last read, why it cannot be)
// opens to edit its path, subfolders, what happens to a file once added and
// the options its torrents get; the folders are one setting
// (`watch_folders`), a draft saved with one `PATCH /settings`. Then the
// files the folders took lately and what became of each.

import { createQuery } from "@tanstack/solid-query";
import ChevronDown from "lucide-solid/icons/chevron-down";
import Folder from "lucide-solid/icons/folder";
import Plus from "lucide-solid/icons/plus";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";

import { api, type Schemas, unwrap } from "~/api/client";
import { FolderPicker } from "~/components/folder-picker";
import { StatusDot } from "~/components/status-dot";
import { TagInput } from "~/components/tag-input";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useLive } from "~/features/shell/live";
import { formatAgo, formatCount, formatDateTime } from "~/lib/format";
import { categoryTone } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { useAppInfo } from "./app-info";
import { RowSwitch, Segmented, SettingRow, UnitInput } from "./controls";
import { createSettingsForm, SettingsPage, WithSettings } from "./form";
import {
  emptyFolder,
  type FolderDraft,
  folderProblem,
  MAX_FOLDERS,
  type WatchDraft,
  watchDiff,
  watchDraft,
  type WatchField,
} from "./watch-form";

const NO_CATEGORY = "\u0000none";
const WEEK = 7 * 86_400;

const AFTER: { value: Schemas["AfterAdd"]; label: string }[] = [
  { value: "rename", label: "Rename" },
  { value: "delete", label: "Delete" },
];

type Stopped = "yes" | "no" | "default";
const STOPPED: { value: Stopped; label: string }[] = [
  { value: "yes", label: "Yes" },
  { value: "no", label: "No" },
  { value: "default", label: "Default" },
];

function Tag(props: { children: JSX.Element }) {
  return (
    <span class="inline-flex h-[18px] items-center rounded border border-border px-1.5 mono text-2xs whitespace-nowrap text-muted-foreground">
      {props.children}
    </span>
  );
}

function Box(props: { title: string; line: string; brand?: boolean }) {
  return (
    <div
      class={cn(
        "flex min-w-0 flex-col gap-[3px] rounded-lg border bg-card px-3 py-2.5",
        props.brand ? "border-brand" : "border-border",
      )}
    >
      <span class={cn("text-xs", props.brand ? "text-brand" : "text-subtle")}>{props.title}</span>
      <span class="truncate mono text-sm">{props.line}</span>
    </div>
  );
}

function Arrow() {
  return (
    <svg
      width="24"
      height="12"
      viewBox="0 0 24 12"
      aria-hidden="true"
      class="mx-auto rotate-90 text-faint sm:rotate-0"
    >
      <path d="M0 6h18" stroke="currentColor" stroke-width="1.5" />
      <path d="M16 2 23 6 16 10Z" fill="currentColor" />
    </svg>
  );
}

function WatchForm(props: { saved: Schemas["Settings"] }) {
  const live = useLive();
  const app = useAppInfo();
  const form = createSettingsForm<WatchDraft, WatchField>(() => props.saved, watchDraft, watchDiff);
  const { draft, setDraft } = form;
  const [open, setOpen] = createSignal<string | null>(null);
  const status = createQuery(() => ({
    queryKey: ["watch-folders"],
    queryFn: () => unwrap(api.GET("/api/v1/watch-folders")),
    refetchInterval: 5_000,
  }));
  const now = () => Date.now() / 1000;
  const categories = createMemo(() =>
    Object.keys(live.state.categories).sort((a, b) => a.localeCompare(b)),
  );
  const tags = () => live.state.tags;

  const edit = <K extends keyof FolderDraft>(i: number, k: K, v: FolderDraft[K]) => {
    (setDraft as (...a: unknown[]) => void)("folders", i, k, v);
  };
  const add = () => {
    const f = emptyFolder();
    setDraft("folders", (list) => [...list, f]);
    setOpen(f.key);
  };
  const remove = (i: number) => setDraft("folders", (list) => list.filter((_, j) => j !== i));

  /** The saved folder's standing (`null` while the folder is not saved). */
  const standing = (f: FolderDraft) =>
    props.saved.watch_folders.some((w) => w.path === f.path.trim())
      ? (status.data?.folders.find((s) => s.path === f.path.trim()) ?? null)
      : null;
  const started = () => app.data?.started_at ?? 0;
  const addedLately = (f: FolderDraft) =>
    (status.data?.recent ?? []).filter(
      (p) => p.folder === f.path.trim() && p.outcome === "added" && p.time >= now() - WEEK,
    ).length;
  const lately = () => (now() - started() >= WEEK ? "in 7 days" : "since start");
  const summary = (f: FolderDraft) =>
    [
      f.category === null ? "no category" : `category ${f.category}`,
      f.tags.length > 0 ? `tags ${f.tags.join(", ")}` : null,
      f.save_path.trim() !== ""
        ? `save to ${f.save_path.trim()}`
        : "save path follows the category",
    ]
      .filter((x) => x !== null)
      .join(" · ");

  return (
    <SettingsPage
      title="Watch folders"
      description="Drop a .torrent or .magnet file into one of these and it is added with the folder's options. Up to 32 folders."
      form={form}
      action={
        <Button onClick={add} disabled={draft.folders.length >= MAX_FOLDERS}>
          <Plus />
          Add folder
        </Button>
      }
    >
      <section
        aria-label="Folders"
        class="flex flex-col overflow-hidden rounded-tile border border-divider bg-card"
      >
        <Show
          when={draft.folders.length > 0}
          fallback={<p class="m-0 px-4 py-3 text-sm text-subtle">No watch folder yet.</p>}
        >
          <For each={draft.folders}>
            {(f, i) => {
              const expanded = () => open() === f.key;
              const st = () => standing(f);
              const id = (x: string) => `w-${f.key}-${x}`;
              return (
                <div>
                  <button
                    type="button"
                    class={cn(
                      "grid w-full grid-cols-[20px_minmax(0,1fr)_auto_16px] items-center gap-3 border-b border-accent px-4 py-3 text-left hover:bg-muted",
                      expanded() && "bg-muted",
                    )}
                    aria-expanded={expanded()}
                    onClick={() => setOpen(expanded() ? null : f.key)}
                  >
                    <Folder class="size-4 text-muted-foreground" />
                    <span class="flex min-w-0 flex-col gap-1">
                      <span class="flex min-w-0 items-center gap-2">
                        <span class="truncate mono font-medium">
                          {f.path.trim() || "New folder"}
                        </span>
                        <Show when={f.recursive}>
                          <Tag>subfolders</Tag>
                        </Show>
                        <Tag>{f.after_add === "rename" ? "rename → .added" : "delete file"}</Tag>
                      </span>
                      <span class="truncate text-sm text-subtle">{summary(f)}</span>
                    </span>
                    <span class="flex flex-col items-end gap-1">
                      <span class="mono text-sm text-subtle">
                        {formatCount(addedLately(f))} added {lately()}
                      </span>
                      <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <StatusDot
                          class={st()?.error ? "bg-danger" : st()?.scanned ? "bg-ok" : "bg-faint"}
                        />
                        {st() === null
                          ? "not saved yet"
                          : st()?.error
                            ? `cannot be read: ${st()?.error}`
                            : st()?.scanned
                              ? `read ${formatAgo(st()?.scanned ?? null, now())}`
                              : "not read yet"}
                      </span>
                    </span>
                    <ChevronDown
                      class={cn(
                        "size-4 text-subtle transition-transform",
                        expanded() && "rotate-180",
                      )}
                    />
                  </button>
                  <Show when={expanded()}>
                    <div class="flex flex-col border-b border-accent bg-background/40">
                      <SettingRow
                        label="Folder"
                        for={id("path")}
                        description="An absolute path on the daemon's machine."
                        error={folderProblem(f, draft.folders) ?? undefined}
                      >
                        <UnitInput
                          id={id("path")}
                          class="w-[300px]"
                          align="left"
                          value={f.path}
                          placeholder="/srv/watch"
                          invalid={folderProblem(f, draft.folders) !== null}
                          onInput={(v) => edit(i(), "path", v)}
                          trailing={
                            <FolderPicker
                              inline
                              value={f.path.startsWith("/") ? f.path : "/"}
                              what="folder to watch"
                              onPick={(p) => edit(i(), "path", p)}
                            />
                          }
                        />
                      </SettingRow>
                      <SettingRow
                        label="Look in subfolders"
                        for={`${id("recursive")}-input`}
                        description="Up to 8 levels; links to folders are not followed."
                      >
                        <RowSwitch
                          id={id("recursive")}
                          checked={f.recursive}
                          onChange={(v) => edit(i(), "recursive", v)}
                        />
                      </SettingRow>
                      <SettingRow
                        label="After a file is added"
                        description="Rename appends .added so it is not taken again; Delete removes it. A file that cannot be added is renamed .rejected."
                      >
                        <Segmented
                          label="After a file is added"
                          options={AFTER}
                          value={f.after_add}
                          onChange={(v) => edit(i(), "after_add", v)}
                        />
                      </SettingRow>
                      <SettingRow
                        label="Category"
                        description="The save path follows it with automatic management."
                      >
                        <Select<string>
                          options={[
                            NO_CATEGORY,
                            ...(f.category !== null && !categories().includes(f.category)
                              ? [f.category]
                              : []),
                            ...categories(),
                          ]}
                          value={f.category ?? NO_CATEGORY}
                          onChange={(v) =>
                            v !== null && edit(i(), "category", v === NO_CATEGORY ? null : v)
                          }
                          itemComponent={(p) => (
                            <SelectItem item={p.item}>
                              {p.item.rawValue === NO_CATEGORY ? "No category" : p.item.rawValue}
                            </SelectItem>
                          )}
                        >
                          <SelectTrigger
                            aria-label="Category"
                            class="h-8 w-auto min-w-[170px] rounded-md px-2.5 text-sm"
                          >
                            <SelectValue<string>>
                              {(s) => (
                                <span class="flex items-center gap-2">
                                  <StatusDot
                                    class={categoryTone(
                                      s.selectedOption() === NO_CATEGORY
                                        ? null
                                        : s.selectedOption(),
                                    )}
                                  />
                                  {s.selectedOption() === NO_CATEGORY
                                    ? "No category"
                                    : s.selectedOption()}
                                </span>
                              )}
                            </SelectValue>
                          </SelectTrigger>
                          <SelectContent />
                        </Select>
                      </SettingRow>
                      <SettingRow label="Tags" for={id("tags")} description="Created if missing.">
                        <TagInput
                          id={id("tags")}
                          label="Tags"
                          class="w-[300px]"
                          value={f.tags}
                          suggestions={tags()}
                          onChange={(v) => edit(i(), "tags", v)}
                        />
                      </SettingRow>
                      <SettingRow label="Add stopped" description="Default: the Downloads setting.">
                        <Segmented
                          label="Add stopped"
                          options={STOPPED}
                          value={f.stopped === null ? "default" : f.stopped ? "yes" : "no"}
                          onChange={(v) =>
                            edit(i(), "stopped", v === "default" ? null : v === "yes")
                          }
                        />
                      </SettingRow>
                      <SettingRow
                        label="Own save path"
                        for={id("save")}
                        description="Used only without automatic management."
                      >
                        <UnitInput
                          id={id("save")}
                          class="w-[300px]"
                          align="left"
                          value={f.save_path}
                          placeholder="follow the category"
                          onInput={(v) => edit(i(), "save_path", v)}
                          trailing={
                            <FolderPicker
                              inline
                              value={f.save_path.startsWith("/") ? f.save_path : "/"}
                              what="save path of its torrents"
                              onPick={(p) => edit(i(), "save_path", p)}
                            />
                          }
                        />
                      </SettingRow>
                      <div class="flex flex-col gap-2.5 px-4 pt-3.5 pb-4">
                        <span class="text-sm text-subtle">What happens to a file dropped here</span>
                        <div class="grid grid-cols-1 items-center gap-1.5 sm:grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)_24px_minmax(0,1fr)_24px_minmax(0,1fr)]">
                          <Box title="Taken within" line="3 to 5 s" />
                          <Arrow />
                          <Box title="Read" line=".torrent · .magnet" />
                          <Arrow />
                          <Box
                            title="Added"
                            brand
                            line={[f.category ?? "no category", ...f.tags].join(" · ")}
                          />
                          <Arrow />
                          <Box
                            title="Then the file is"
                            line={f.after_add === "rename" ? "renamed *.added" : "deleted"}
                          />
                        </div>
                        <div class="flex justify-end pt-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            class="text-danger hover:text-danger"
                            onClick={() => remove(i())}
                          >
                            Remove folder
                          </Button>
                        </div>
                      </div>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>
      </section>

      <section aria-label="Picked up recently" class="flex flex-col gap-2.5">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4">
          <h2 class="m-0 text-md font-semibold">Picked up recently</h2>
          <span class="text-sm text-subtle">
            Files these folders turned into torrents · <span class="mono">GET /watch-folders</span>
          </span>
        </div>
        <div class="flex flex-col rounded-tile border border-divider bg-card">
          <Show
            when={(status.data?.recent ?? []).length > 0}
            fallback={
              <p class="m-0 px-4 py-3 text-sm text-subtle">
                Nothing taken since the daemon started.
              </p>
            }
          >
            <ul class="m-0 list-none p-0">
              <For each={(status.data?.recent ?? []).slice(0, 10)}>
                {(p) => {
                  const file = p.file.slice(p.file.lastIndexOf("/") + 1);
                  const what =
                    p.outcome === "added"
                      ? `→ added${p.name ? ` as ${p.name}` : ""}`
                      : p.outcome === "duplicate"
                        ? "— already here"
                        : `— not added: ${p.error ?? "refused"}`;
                  return (
                    <li class="grid h-[34px] grid-cols-[104px_18px_minmax(0,1fr)_minmax(0,160px)] items-center gap-2.5 border-b border-accent px-4 text-sm last:border-b-0">
                      <span class="mono text-subtle">{formatDateTime(p.time)}</span>
                      <StatusDot
                        class={
                          p.outcome === "added"
                            ? "bg-ok"
                            : p.outcome === "duplicate"
                              ? "bg-warn"
                              : "bg-danger"
                        }
                      />
                      <span class="truncate" title={p.file}>
                        <span class="mono">{file}</span> <span class="text-subtle">{what}</span>
                      </span>
                      <span class="truncate text-right mono text-subtle" title={p.folder}>
                        {p.folder}
                      </span>
                    </li>
                  );
                }}
              </For>
            </ul>
          </Show>
        </div>
      </section>
    </SettingsPage>
  );
}

export default function WatchFolders() {
  return (
    <WithSettings title="Watch folders">{(saved) => <WatchForm saved={saved()} />}</WithSettings>
  );
}
