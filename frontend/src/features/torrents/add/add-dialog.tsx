// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Adding torrents, as the design has it (AGENTS.md 6.4): sources on the
// left (links, .torrent files, or a folder to watch) with the options, the
// daemon's preview of each source on the right. Every source is added on
// its own (`POST /torrents`), with the shared options and its own file
// choices; what failed stays in the dialog with the daemon's reason.

import { createQuery, useQueryClient } from "@tanstack/solid-query";
import FileUp from "lucide-solid/icons/file-up";
import X from "lucide-solid/icons/x";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  Match,
  on,
  onCleanup,
  Show,
  Switch as Branch,
  untrack,
} from "solid-js";
import { createStore } from "solid-js/store";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { FolderPicker } from "~/components/folder-picker";
import { PromptDialog } from "~/components/prompt-dialog";
import { TagInput } from "~/components/tag-input";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "~/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch, SwitchControl, SwitchLabel } from "~/components/ui/switch";
import { Tabs, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { TextField, TextFieldLabel, TextFieldTextArea } from "~/components/ui/text-field";
import { useAuth } from "~/features/auth/auth";
import { useLive } from "~/features/shell/live";
import { formatCount } from "~/lib/format";
import { cn } from "~/lib/utils";

import {
  type AddForm,
  addOptions,
  categoryPath,
  filePriorities,
  type Layout,
  parseSources,
  type Stop,
} from "./form";
import { PreviewPanel } from "./preview-panel";
import { addable, createSources } from "./sources";

type Mode = "links" | "files" | "folder";

const LAYOUTS: readonly { value: Layout; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "subfolder", label: "Create subfolder" },
  { value: "no_subfolder", label: "Don't create subfolder" },
];

const STOPS: readonly { value: Stop; label: string }[] = [
  { value: "none", label: "None" },
  { value: "metadata_received", label: "Metadata received" },
  { value: "files_checked", label: "Files checked" },
];

const NO_CATEGORY = "\u0000none";
const NEW_CATEGORY = "\u0000new";

const hintClass = "m-0 text-sm text-subtle";
const pathInput =
  "mono h-9 w-full rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none placeholder:text-subtle focus-visible:border-ring focus-visible:shadow-focus disabled:cursor-not-allowed disabled:text-muted-foreground";
const labelClass = "text-sm font-medium text-foreground";

function Field(props: {
  label: string;
  for: string;
  children: JSX.Element;
  hint?: JSX.Element;
  class?: string;
}) {
  return (
    <div class={cn("flex min-w-0 flex-col gap-1.5", props.class)}>
      <label for={props.for} class={labelClass}>
        {props.label}
      </label>
      {props.children}
      <Show when={props.hint}>
        <p class={hintClass}>{props.hint}</p>
      </Show>
    </div>
  );
}

function Toggle(props: {
  label: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Switch
      class="flex items-center justify-between gap-3"
      checked={props.checked}
      onChange={props.onChange}
      disabled={props.disabled}
    >
      <SwitchLabel>{props.label}</SwitchLabel>
      <SwitchControl />
    </Switch>
  );
}

function Choice<T extends string>(props: {
  id: string;
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const label = (v: T) => props.options.find((o) => o.value === v)?.label ?? v;
  return (
    <Select<T>
      modal
      class="flex min-w-0 flex-col gap-1.5"
      options={props.options.map((o) => o.value)}
      value={props.value}
      onChange={(v) => v !== null && props.onChange(v)}
      itemComponent={(p) => <SelectItem item={p.item}>{label(p.item.rawValue)}</SelectItem>}
    >
      <SelectLabel class={labelClass}>{props.label}</SelectLabel>
      <SelectTrigger id={props.id}>
        <SelectValue<T>>{(s) => label(s.selectedOption())}</SelectValue>
      </SelectTrigger>
      <SelectContent />
    </Select>
  );
}

function LimitInput(props: {
  id: string;
  label: string;
  value: string;
  onInput: (v: string) => void;
  unit?: string;
  placeholder: string;
  disabled?: boolean;
}) {
  return (
    <Field label={props.label} for={props.id}>
      <div class="relative">
        <input
          id={props.id}
          class={cn(
            "h-9 w-full rounded-lg border border-input bg-background px-3 mono text-sm text-foreground outline-none placeholder:text-subtle focus-visible:border-ring focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-60",
            props.unit && "pr-12",
          )}
          inputMode="decimal"
          placeholder={props.placeholder}
          value={props.value}
          disabled={props.disabled}
          onInput={(e) => props.onInput(e.currentTarget.value)}
        />
        <Show when={props.unit}>
          <span class="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-sm text-subtle">
            {props.unit}
          </span>
        </Show>
      </div>
    </Field>
  );
}

function Body(props: {
  onClose: () => void;
  mode: Mode;
  setMode: (m: Mode) => void;
  links?: string;
}) {
  const auth = useAuth();
  const live = useLive();
  const client = useQueryClient();
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
    staleTime: 30_000,
  }));
  const defaultPath = () => {
    const s = auth.state();
    return settings.data?.save_path ?? (s.kind === "signed-in" ? s.app.default_save_path : "");
  };

  const [form, setForm] = createStore<AddForm>({
    savePath: "",
    category: null,
    tags: [],
    layout: "original",
    stop: "none",
    start: true,
    autoManagement: false,
    sequential: false,
    firstLast: false,
    inheritLimits: true,
    downloadLimit: "",
    uploadLimit: "",
    ratio: "",
  });
  // The daemon's defaults, once known.
  createEffect(
    on(
      () => settings.data,
      (s) => {
        if (!s) return;
        setForm({
          savePath: s.save_path,
          layout: s.content_layout ?? "original",
          stop: s.stop_condition ?? "none",
          start: !s.add_stopped,
          autoManagement: s.auto_management,
        });
      },
    ),
  );

  const [links, setLinks] = createSignal(untrack(() => props.links ?? ""));
  const [folder, setFolder] = createSignal({
    path: "",
    recursive: false,
    afterAdd: "rename" as const as Schemas["AfterAdd"],
  });
  const [open, setOpen] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [creating, setCreating] = createSignal(false);
  let picker: HTMLInputElement | undefined;

  const sources = createSources((hash) => live.state.torrents[hash] !== undefined);
  onCleanup(() => sources.dropAll());

  // Follow the links as they are typed, once typing pauses.
  const parsed = createMemo(() => parseSources(links()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(parsed, (p) => {
      clearTimeout(timer);
      timer = setTimeout(() => sources.setLinks(p.sources), 400);
    }),
  );
  onCleanup(() => clearTimeout(timer));

  const categories = createMemo(() => Object.keys(live.state.categories).sort());
  const category = () =>
    form.category === null ? undefined : live.state.categories[form.category];
  const managedPath = () => categoryPath(defaultPath(), form.category, category());

  /** What the torrent inherits: its category's ratio limit, else the setting. */
  const inheritedRatio = () => {
    const c = category()?.share_limits?.ratio;
    if (c?.mode === "limit") return `${c.value.toFixed(1)} (category)`;
    if (c?.mode === "unlimited") return "none (category)";
    const g = settings.data?.max_ratio;
    return g === null || g === undefined ? "none (global)" : `${g.toFixed(1)} (global)`;
  };

  const inMode = () => sources.list.filter((s) => (props.mode === "files") === (s.kind === "file"));
  const toAdd = () => inMode().filter(addable);
  const ready = () => inMode().filter((s) => s.status === "ready").length;

  const categoryValue = () => form.category ?? NO_CATEGORY;
  const categoryOptions = createMemo(() => {
    const names = categories();
    const current = form.category;
    const all = current !== null && !names.includes(current) ? [...names, current] : names;
    return [NO_CATEGORY, ...all, NEW_CATEGORY];
  });
  const categoryLabel = (v: string) =>
    v === NO_CATEGORY ? "None" : v === NEW_CATEGORY ? "New category…" : v;

  const submit = async () => {
    const o = addOptions(form);
    if ("error" in o) {
      setError(o.error);
      return;
    }
    setError(null);
    if (props.mode === "folder") return watch(o.options);
    const todo = toAdd();
    if (todo.length === 0) return;
    setBusy(true);
    const added: string[] = [];
    await Promise.all(
      todo.map(async (s) => {
        const options: Schemas["AddOptions"] = { ...o.options };
        const priorities = s.metadata ? filePriorities(s.priorities) : undefined;
        if (priorities) options.file_priorities = priorities;
        // A URL whose .torrent the preview fetched is added by its hash:
        // the daemon uses that .torrent instead of downloading it again.
        const body =
          s.kind === "file"
            ? { torrents: [s.torrent ?? ""], options }
            : {
                urls: [s.kind === "url" && s.status === "ready" && s.hash ? s.hash : s.text],
                options,
              };
        try {
          const r = await unwrap(api.POST("/api/v1/torrents", { body }));
          const fail = r.failed[0];
          if (fail) sources.notAdded(s.key, fail.error.message);
          else {
            added.push(r.added[0]?.name ?? s.label);
            sources.added(s.key);
          }
        } catch (e) {
          sources.notAdded(s.key, e instanceof ApiError ? e.message : "the daemon did not answer");
        }
      }),
    );
    setBusy(false);
    if (added.length > 0) {
      toast.success(
        added.length === 1 ? `Added ${added[0]}` : `Added ${formatCount(added.length)} torrents`,
      );
    }
    if (inMode().length === 0) props.onClose();
    else
      setLinks(
        inMode()
          .filter((s) => s.kind !== "file")
          .map((s) => s.text)
          .join("\n"),
      );
  };

  const watch = async (options: Schemas["AddOptions"]) => {
    const f = folder();
    if (!f.path.trim().startsWith("/")) {
      setError("Choose the folder to watch (an absolute path on the daemon's machine).");
      return;
    }
    setBusy(true);
    try {
      const current = settings.data ?? (await unwrap(api.GET("/api/v1/settings")));
      const entry: Schemas["WatchFolder"] = {
        path: f.path.trim(),
        recursive: f.recursive,
        after_add: f.afterAdd,
        options,
      };
      const next = await unwrap(
        api.PATCH("/api/v1/settings", {
          body: { watch_folders: [...current.watch_folders, entry] },
        }),
      );
      client.setQueryData(keys.settings(), next);
      toast.success(`Watching ${entry.path}`);
      props.onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The folder could not be added.");
    } finally {
      setBusy(false);
    }
  };

  const folderFiles = createQuery(() => ({
    queryKey: ["fs", "files", folder().path],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/fs/directory", {
          params: { query: { path: folder().path, mode: "files" } },
        }),
      ),
    enabled: props.mode === "folder" && folder().path.startsWith("/"),
    retry: false,
  }));
  const watchable = () =>
    (folderFiles.data ?? []).filter((f) => /\.(torrent|magnet)$/i.test(f.name));

  const primary = () => {
    if (props.mode === "folder") return "Watch this folder";
    const n = toAdd().length;
    return n === 1 ? "Add 1 torrent" : n === 0 ? "Add" : `Add ${formatCount(n)} torrents`;
  };
  const footnote = () => {
    if (error()) return <span class="text-danger">{error()}</span>;
    if (props.mode === "folder")
      return "Every .torrent and .magnet file that appears in it is added with these options.";
    const n = toAdd().length;
    return n > 1
      ? `Options apply to all ${formatCount(n)}. Sources already in the list are skipped.`
      : "Sources already in the list are skipped.";
  };

  return (
    <form
      class="flex min-h-0 flex-1 flex-col"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const files = [...(e.dataTransfer?.files ?? [])].filter((f) => /\.torrent$/i.test(f.name));
        if (files.length > 0) {
          props.setMode("files");
          void sources.addFiles(files);
        }
      }}
    >
      <div class="flex items-start justify-between gap-4 px-6 pt-[22px]">
        <div class="flex flex-col gap-1">
          <DialogTitle class="m-0 text-[17px] font-semibold">Add torrents</DialogTitle>
          <DialogDescription class={hintClass}>
            Magnet links, info-hashes, URLs or .torrent files — each source is added on its own.
          </DialogDescription>
        </div>
        <DialogClose
          as={Button}
          type="button"
          variant="ghost"
          size="md"
          class="w-9 px-0 text-muted-foreground"
          aria-label="Close"
        >
          <X class="size-4" />
        </DialogClose>
      </div>

      <div class="grid min-h-0 flex-1 grid-cols-1 overflow-auto md:grid-cols-[minmax(0,1fr)_340px] md:overflow-hidden">
        <div class="flex flex-col gap-[18px] px-6 pt-5 pb-6 md:overflow-auto md:border-r md:border-border">
          <Tabs value={props.mode} onChange={(v) => props.setMode(v as Mode)}>
            <TabsList
              class="h-auto w-fit gap-1 rounded-lg border-0 bg-accent p-1"
              aria-label="Source"
            >
              <For
                each={
                  [
                    ["links", "Magnet / URL"],
                    ["files", ".torrent file"],
                    ["folder", "Watch folder"],
                  ] as const
                }
              >
                {([value, label]) => (
                  <TabsTrigger
                    value={value}
                    class="h-8 rounded-md px-3 text-base font-medium text-muted-foreground data-[selected]:bg-border data-[selected]:text-foreground"
                  >
                    {label}
                  </TabsTrigger>
                )}
              </For>
            </TabsList>
          </Tabs>

          <Branch>
            <Match when={props.mode === "links"}>
              <TextField value={links()} onChange={setLinks} class="gap-1.5">
                <TextFieldLabel class={labelClass}>Sources</TextFieldLabel>
                <TextFieldTextArea
                  class="h-24 min-h-24 resize-none rounded-lg px-3 py-2.5 mono text-sm leading-normal"
                  placeholder="magnet:?xt=urn:btih:…  (one per line)"
                  spellcheck={false}
                  autofocus
                />
                <p class={hintClass}>
                  {formatCount(parsed().sources.length)} sources · metadata fetched for{" "}
                  {formatCount(ready())}
                  <Show when={parsed().invalid.length > 0}>
                    <span class="text-danger">
                      {" "}
                      · {formatCount(parsed().invalid.length)} lines are not sources
                    </span>
                  </Show>
                </p>
              </TextField>
            </Match>
            <Match when={props.mode === "files"}>
              <div class="flex flex-col gap-1.5">
                <span class={labelClass}>Torrent files</span>
                <div class="flex h-24 flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border-strong bg-background text-sm text-subtle">
                  <Button
                    type="button"
                    variant="outline"
                    size="md"
                    class="bg-background"
                    onClick={() => picker?.click()}
                  >
                    <FileUp />
                    Choose .torrent files
                  </Button>
                  or drop them anywhere on this dialog
                </div>
                <input
                  ref={picker}
                  type="file"
                  accept=".torrent,application/x-bittorrent"
                  multiple
                  class="hidden"
                  aria-label="Torrent files"
                  onChange={(e) => {
                    void sources.addFiles([...(e.currentTarget.files ?? [])]);
                    e.currentTarget.value = "";
                  }}
                />
                <p class={hintClass}>
                  {formatCount(inMode().length)} files · {formatCount(ready())} read
                </p>
              </div>
            </Match>
            <Match when={props.mode === "folder"}>
              <div class="grid grid-cols-2 gap-4">
                <Field label="Folder to watch" for="add-folder" class="col-span-2">
                  <div class="flex gap-2">
                    <input
                      id="add-folder"
                      class={pathInput}
                      placeholder="/srv/torrents/incoming"
                      value={folder().path}
                      spellcheck={false}
                      onInput={(e) => setFolder({ ...folder(), path: e.currentTarget.value })}
                    />
                    <FolderPicker
                      value={folder().path}
                      what="folder to watch"
                      onPick={(p) => setFolder({ ...folder(), path: p })}
                    />
                  </div>
                </Field>
                <Toggle
                  label="Include subfolders"
                  checked={folder().recursive}
                  onChange={(recursive) => setFolder({ ...folder(), recursive })}
                />
                <Choice<Schemas["AfterAdd"]>
                  id="add-after"
                  label="After adding a file"
                  value={folder().afterAdd}
                  options={[
                    { value: "rename", label: "Rename it to .added" },
                    { value: "delete", label: "Delete it" },
                  ]}
                  onChange={(afterAdd) => setFolder({ ...folder(), afterAdd })}
                />
              </div>
            </Match>
          </Branch>

          <div class="grid grid-cols-2 gap-4">
            <Field
              label="Save path"
              for="add-save-path"
              class="col-span-2"
              hint={
                form.autoManagement
                  ? "Follows the category while automatic management is on."
                  : "Where the content is saved on the daemon's machine."
              }
            >
              <div class="flex gap-2">
                <input
                  id="add-save-path"
                  class={pathInput}
                  value={form.autoManagement ? managedPath() : form.savePath}
                  disabled={form.autoManagement}
                  placeholder={defaultPath()}
                  spellcheck={false}
                  onInput={(e) => setForm("savePath", e.currentTarget.value)}
                />
                <FolderPicker
                  value={form.savePath || defaultPath()}
                  what="save path"
                  disabled={form.autoManagement}
                  onPick={(p) => setForm("savePath", p)}
                />
              </div>
            </Field>
            <Select<string>
              modal
              class="flex min-w-0 flex-col gap-1.5"
              options={categoryOptions()}
              value={categoryValue()}
              onChange={(v) => {
                if (v === null) return;
                if (v === NEW_CATEGORY) setCreating(true);
                else setForm("category", v === NO_CATEGORY ? null : v);
              }}
              itemComponent={(p) => (
                <SelectItem item={p.item}>{categoryLabel(p.item.rawValue)}</SelectItem>
              )}
            >
              <SelectLabel class={labelClass}>Category</SelectLabel>
              <SelectTrigger id="add-category">
                <SelectValue<string>>{(s) => categoryLabel(s.selectedOption())}</SelectValue>
              </SelectTrigger>
              <SelectContent />
            </Select>
            <div class="flex min-w-0 flex-col gap-1.5">
              <label for="add-tags" class={labelClass}>
                Tags
              </label>
              <TagInput
                id="add-tags"
                label="Tags"
                value={form.tags}
                suggestions={live.state.tags}
                onChange={(tags) => setForm("tags", tags)}
              />
            </div>
            <Choice<Layout>
              id="add-layout"
              label="Content layout"
              value={form.layout}
              options={LAYOUTS}
              onChange={(v) => setForm("layout", v)}
            />
            <Choice<Stop>
              id="add-stop"
              label="Stop condition"
              value={form.stop}
              options={STOPS}
              onChange={(v) => setForm("stop", v)}
            />
          </div>

          <div class="grid grid-cols-1 gap-x-8 gap-y-3 pt-1 sm:grid-cols-2">
            <Toggle
              label="Start immediately"
              checked={form.start}
              onChange={(v) => setForm("start", v)}
            />
            <Toggle
              label="Automatic management"
              checked={form.autoManagement}
              onChange={(v) => setForm("autoManagement", v)}
            />
            <Toggle
              label="Sequential download"
              checked={form.sequential}
              onChange={(v) => setForm("sequential", v)}
            />
            <Toggle
              label="First and last pieces first"
              checked={form.firstLast}
              onChange={(v) => setForm("firstLast", v)}
            />
            <Toggle
              label={
                form.category === null ? "Use global share limits" : "Use category share limits"
              }
              checked={form.inheritLimits}
              onChange={(v) => setForm("inheritLimits", v)}
            />
          </div>

          <div class="grid grid-cols-3 gap-4">
            <LimitInput
              id="add-download-limit"
              label="Download limit"
              unit="kB/s"
              placeholder="∞"
              value={form.downloadLimit}
              onInput={(v) => setForm("downloadLimit", v)}
            />
            <LimitInput
              id="add-upload-limit"
              label="Upload limit"
              unit="kB/s"
              placeholder="∞"
              value={form.uploadLimit}
              onInput={(v) => setForm("uploadLimit", v)}
            />
            <LimitInput
              id="add-ratio"
              label="Ratio limit"
              placeholder={form.inheritLimits ? inheritedRatio() : "∞"}
              value={form.inheritLimits ? "" : form.ratio}
              disabled={form.inheritLimits}
              onInput={(v) => setForm("ratio", v)}
            />
          </div>
        </div>

        <div class="flex flex-col gap-3.5 bg-background px-6 py-5 md:overflow-auto">
          <Show
            when={props.mode !== "folder"}
            fallback={
              <div class="flex flex-col gap-3.5">
                <h2 class="m-0 text-sm font-medium tracking-[0.04em] text-muted-foreground uppercase">
                  In the folder now
                </h2>
                <Branch>
                  <Match when={!folder().path.startsWith("/")}>
                    <p class={hintClass}>
                      Choose a folder to see the .torrent and .magnet files in it.
                    </p>
                  </Match>
                  <Match when={folderFiles.isError}>
                    <p class="m-0 text-sm text-danger">
                      {folderFiles.error instanceof ApiError
                        ? folderFiles.error.message
                        : "The folder cannot be read."}
                    </p>
                  </Match>
                  <Match when={true}>
                    <p class={hintClass}>
                      {formatCount(watchable().length)} files to add once it is watched
                    </p>
                    <ul class="m-0 flex list-none flex-col gap-1 p-0">
                      <For each={watchable().slice(0, 100)}>
                        {(f) => <li class="truncate mono text-sm">{f.name}</li>}
                      </For>
                    </ul>
                  </Match>
                </Branch>
                <Show when={(settings.data?.watch_folders.length ?? 0) > 0}>
                  <div class="flex flex-col gap-1.5 border-t border-border pt-3.5">
                    <span class="text-sm text-subtle">Watched already</span>
                    <For each={settings.data?.watch_folders ?? []}>
                      {(w) => <span class="truncate mono text-sm">{w.path}</span>}
                    </For>
                  </div>
                </Show>
              </div>
            }
          >
            <PreviewPanel
              sources={{ ...sources, list: inMode() } as typeof sources}
              open={open()}
              onOpen={setOpen}
              onRemove={(key) => sources.removeFile(key)}
              empty={
                <p class={hintClass}>
                  {props.mode === "files"
                    ? "The files, size and trackers of each .torrent file show here."
                    : "Paste a magnet link or a URL: its files, size and swarm show here."}
                </p>
              }
            />
          </Show>
        </div>
      </div>

      <div class="flex items-center gap-2.5 border-t border-border bg-card px-6 py-4">
        <p class={cn(hintClass, "min-w-0 flex-1")} role={error() ? "alert" : undefined}>
          {footnote()}
        </p>
        <DialogClose
          as={Button}
          type="button"
          variant="outline"
          size="md"
          class="bg-background"
          aria-label="Cancel"
        >
          Cancel
        </DialogClose>
        <Button
          type="submit"
          size="md"
          disabled={busy() || (props.mode !== "folder" && toAdd().length === 0)}
        >
          {busy() ? "Adding…" : primary()}
        </Button>
      </div>

      <PromptDialog
        open={creating()}
        title="New category"
        label="Name"
        action="Use it"
        onClose={() => setCreating(false)}
        onSubmit={(name) => setForm("category", name)}
      />
    </form>
  );
}

export function AddDialog(props: {
  open: boolean;
  onClose: () => void;
  /** Links to start from (an RSS article's torrent). */
  links?: string;
}) {
  const [mode, setMode] = createSignal<Mode>("links");
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (open && props.links) setMode("links");
      },
    ),
  );
  return (
    <Dialog
      open={props.open}
      onOpenChange={(o) => {
        if (!o) props.onClose();
      }}
    >
      <DialogContent
        noClose
        class="flex h-[min(780px,calc(100dvh-2rem))] w-full max-w-[920px] flex-col gap-0 overflow-hidden p-0"
      >
        <Body onClose={props.onClose} mode={mode()} setMode={setMode} links={props.links} />
      </DialogContent>
    </Dialog>
  );
}
