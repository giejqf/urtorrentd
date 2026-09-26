// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Options tab: one torrent's name and comment, limits, share limits,
// behaviour, category, tags and location, as a draft saved together (the
// footer, Ctrl/⌘ S). The draft lives with the panel, so it outlasts a switch
// of tab; leaving the torrent with it unsaved asks first. Share limits set
// to Global show what the torrent gets instead: its category's, else the
// settings'.

import { useBeforeLeave } from "@solidjs/router";
import ChevronDown from "lucide-solid/icons/chevron-down";
import Plus from "lucide-solid/icons/plus";
import X from "lucide-solid/icons/x";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { createStore, reconcile, unwrap as plain } from "solid-js/store";

import { api, type Schemas, unwrap } from "~/api/client";
import { FolderPicker } from "~/components/folder-picker";
import { PromptDialog } from "~/components/prompt-dialog";
import { StatusDot } from "~/components/status-dot";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { RowSwitch, UnitInput } from "~/features/settings/controls";
import { useLive } from "~/features/shell/live";
import { categoryTone } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import {
  mergeDraft,
  type OptionsChange,
  type OptionsDraft,
  optionsDiff,
  optionsDraft,
  type OptionsRow,
} from "./options";
import { useTorrentDialogs } from "../torrent-dialogs";
import { TabHeading } from "./parts";
import { OptionHeading, OptionRow, ShareFields, useInherited } from "./share-fields";

type TorrentSummary = Schemas["TorrentSummary"];
type BulkResult = Schemas["BulkResult"];

/** A bulk call for this one torrent: what did not apply is an error. */
function applied(r: BulkResult): void {
  const why = r.failed[0]?.error.message ?? (r.not_found.length > 0 ? "no such torrent" : null);
  if (why !== null) throw new Error(why);
}

async function saveChange(hash: string, c: OptionsChange): Promise<void> {
  const hashes = [hash];
  if (c.patch) {
    await unwrap(
      api.PATCH("/api/v1/torrents/{hash}", { params: { path: { hash } }, body: c.patch }),
    );
  }
  if (c.limits) {
    applied(await unwrap(api.POST("/api/v1/torrents/limits", { body: { hashes, ...c.limits } })));
  }
  if (c.shareLimits) {
    applied(
      await unwrap(
        api.POST("/api/v1/torrents/share-limits", {
          body: { hashes, share_limits: c.shareLimits },
        }),
      ),
    );
  }
  if (c.sequential !== null) {
    applied(
      await unwrap(
        api.POST("/api/v1/torrents/sequential", { body: { hashes, value: c.sequential } }),
      ),
    );
  }
  if (c.firstLast !== null) {
    applied(
      await unwrap(
        api.POST("/api/v1/torrents/first-last-piece-priority", {
          body: { hashes, value: c.firstLast },
        }),
      ),
    );
  }
  if (c.forced !== null) {
    applied(
      await unwrap(api.POST("/api/v1/torrents/force-start", { body: { hashes, value: c.forced } })),
    );
  }
  // The category before automatic management, so a torrent put under it
  // moves to the new category's path.
  if (c.category) {
    applied(
      await unwrap(
        api.POST("/api/v1/torrents/category", { body: { hashes, category: c.category.value } }),
      ),
    );
  }
  if (c.autoManagement !== null) {
    applied(
      await unwrap(
        api.POST("/api/v1/torrents/auto-management", {
          body: { hashes, value: c.autoManagement },
        }),
      ),
    );
  }
  if (c.tagsAdd.length > 0) {
    applied(
      await unwrap(
        api.POST("/api/v1/torrents/tags", { body: { hashes, mode: "add", tags: c.tagsAdd } }),
      ),
    );
  }
  if (c.tagsRemove.length > 0) {
    applied(
      await unwrap(
        api.POST("/api/v1/torrents/tags", { body: { hashes, mode: "remove", tags: c.tagsRemove } }),
      ),
    );
  }
  if (c.location !== null) {
    applied(
      await unwrap(api.POST("/api/v1/torrents/location", { body: { hashes, path: c.location } })),
    );
  }
  if (c.downloadPath) {
    applied(
      await unwrap(
        api.POST("/api/v1/torrents/download-path", {
          body: { hashes, path: c.downloadPath.value },
        }),
      ),
    );
  }
}

/**
 * The tab's draft for one torrent: it starts from the torrent's options and
 * follows them while left alone (fields being edited stay as typed).
 */
export function createOptionsForm(torrent: () => TorrentSummary) {
  const source = createMemo(() => optionsDraft(torrent()), undefined, {
    equals: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  });
  const [base, setBase] = createSignal(untrack(source));
  const [draft, setDraft] = createStore<OptionsDraft>(structuredClone(untrack(source)));
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [saved, setSaved] = createSignal(false);
  createEffect(
    on(
      source,
      (next) => {
        setDraft(reconcile(mergeDraft(structuredClone(plain(draft)), base(), next)));
        setBase(next);
      },
      { defer: true },
    ),
  );
  const diff = createMemo(() => optionsDiff(base(), draft));
  const firstError = () => Object.values(diff().errors)[0] ?? null;
  const dirty = () => diff().changed.size > 0;

  const save = async () => {
    const c = diff();
    if (busy() || !dirty() || firstError()) return;
    const hash = torrent().hash;
    // What was sent: fields edited while the save runs stay as typed.
    const sent = structuredClone(plain(draft));
    setBusy(true);
    setError(null);
    let ok = true;
    setSaved(false);
    try {
      await saveChange(hash, c);
      // No toast: it would cover the footer. The footer going is the sign.
      setSaved(true);
    } catch (e) {
      ok = false;
      setError(e instanceof Error ? e.message : "The options could not be saved.");
    }
    // What the daemon holds now: the event stream brings it within a second.
    try {
      const now = optionsDraft(
        await unwrap(api.GET("/api/v1/torrents/{hash}", { params: { path: { hash } } })),
      );
      // Saved: what was sent becomes the daemon's (its units, its text).
      // Failed: what was edited stays, to try again.
      setDraft(reconcile(mergeDraft(structuredClone(plain(draft)), ok ? sent : base(), now)));
      setBase(now);
    } catch {
      // The live row will bring it.
    }
    setBusy(false);
  };

  return {
    draft,
    set: <K extends keyof OptionsDraft>(field: K, value: OptionsDraft[K]) => {
      setError(null);
      setSaved(false);
      setDraft(field, value as never);
    },
    diff,
    changed: (row: OptionsRow) => diff().changed.has(row),
    fieldError: (row: OptionsRow) => diff().errors[row],
    dirty,
    busy,
    /** The last save went through (for screen readers). */
    saved,
    problem: () => error() ?? firstError(),
    save,
    discard: () => {
      setError(null);
      setDraft(reconcile(structuredClone(base())));
    },
  };
}

export type OptionsForm = ReturnType<typeof createOptionsForm>;

/**
 * Leaving the torrent (another torrent, another screen) with the draft
 * unsaved asks first; switching tabs keeps it.
 */
export function OptionsLeaveGuard(props: { form: OptionsForm; hash: string }) {
  const [leaving, setLeaving] = createSignal<(() => void) | null>(null);
  useBeforeLeave((e) => {
    const here = typeof e.to === "string" && e.to.startsWith(`/torrents/${props.hash}`);
    if (props.form.dirty() && !here && !e.defaultPrevented) {
      e.preventDefault();
      setLeaving(() => () => e.retry(true));
    }
  });
  const names = () => props.form.diff().names;
  return (
    <AlertDialog open={leaving() !== null} onOpenChange={(o) => !o && setLeaving(null)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
          <AlertDialogDescription>
            {names().length === 1 ? "1 option is" : `${names().length} options are`} not saved:{" "}
            {names().join(", ")}.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="outline" onClick={() => setLeaving(null)}>
            Stay
          </Button>
          <Button
            variant="destructive"
            onClick={() => {
              const go = leaving();
              setLeaving(null);
              props.form.discard();
              go?.();
            }}
          >
            Leave
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function OptionsTab(props: { torrent: TorrentSummary; form: OptionsForm }) {
  const live = useLive();
  const f = () => props.form;
  const d = () => props.form.draft;
  const id = (k: string) => `opt-${k}`;
  // What Global stands for: the draft's category's limits, else the settings'.
  const inherited = useInherited(() => d().category);
  const categories = createMemo(() => Object.keys(live.state.categories).sort());
  const allTags = createMemo(() =>
    [...new Set([...live.state.tags, ...d().tags])].sort((a, b) => a.localeCompare(b)),
  );
  const [creatingTag, setCreatingTag] = createSignal(false);
  const [creatingCategory, setCreatingCategory] = createSignal(false);
  const dialogs = useTorrentDialogs();

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void f().save();
    }
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2.5 px-4 pt-3 pb-4">
      <TabHeading torrent={props.torrent} />
      <div class="flex min-h-0 flex-1 flex-col overflow-auto pt-1 pr-0.5">
        <OptionHeading>Naming</OptionHeading>
        <OptionRow label="Display name" for={id("name")} changed={f().changed("name")}>
          <UnitInput
            id={id("name")}
            class="h-[30px] w-[240px]"
            align="left"
            inputMode="text"
            value={d().name}
            placeholder="the torrent's own name"
            changed={f().changed("name")}
            onInput={(v) => f().set("name", v)}
          />
        </OptionRow>
        <OptionRow label="Comment" for={id("comment")} changed={f().changed("comment")}>
          <UnitInput
            id={id("comment")}
            class="h-[30px] w-[240px]"
            align="left"
            inputMode="text"
            value={d().comment}
            placeholder="none"
            changed={f().changed("comment")}
            onInput={(v) => f().set("comment", v)}
          />
        </OptionRow>

        <OptionHeading>Speed &amp; connections</OptionHeading>
        <For
          each={
            [
              ["download_limit", "Download limit", "kB/s", "∞"],
              ["upload_limit", "Upload limit", "kB/s", "∞"],
              ["max_connections", "Peer connections", "peers", "global"],
              ["max_uploads", "Upload slots", "slots", "global"],
            ] as const
          }
        >
          {([field, label, unit, empty]) => (
            <OptionRow
              label={label}
              for={id(field)}
              changed={f().changed(field)}
              error={f().fieldError(field)}
            >
              <UnitInput
                id={id(field)}
                class="h-[30px]"
                value={d()[field]}
                unit={unit}
                placeholder={empty}
                inputMode="numeric"
                changed={f().changed(field)}
                invalid={f().fieldError(field) !== undefined}
                onInput={(v) => f().set(field, v)}
              />
            </OptionRow>
          )}
        </For>

        <OptionHeading>Share limits</OptionHeading>
        <ShareFields
          draft={d()}
          set={(k, v) => f().set(k, v as OptionsDraft[typeof k])}
          inherited={inherited()}
          id="opt"
          changed={(r) => f().changed(r)}
          error={(r) => f().fieldError(r)}
        />

        <OptionHeading>Behaviour</OptionHeading>
        <For
          each={
            [
              ["sequential", "Sequential download", null],
              ["first_last", "First and last pieces first", null],
              ["auto_management", "Automatic management", "save path from the category"],
              ["forced", "Force start", "runs whatever the queue"],
            ] as const
          }
        >
          {([field, label, hint]) => (
            <OptionRow
              label={
                <>
                  {label}
                  <Show when={hint}>
                    <span class="ml-1.5 text-subtle">{hint}</span>
                  </Show>
                </>
              }
              for={`${id(field)}-input`}
              changed={f().changed(field)}
            >
              <RowSwitch id={id(field)} checked={d()[field]} onChange={(v) => f().set(field, v)} />
            </OptionRow>
          )}
        </For>

        <OptionHeading>Location</OptionHeading>
        <OptionRow label="Category" changed={f().changed("category")}>
          <DropdownMenu>
            <DropdownMenuTrigger
              as={Button}
              variant="outline"
              size="sm"
              class={cn("w-[150px] justify-between", f().changed("category") && "border-warn")}
              aria-label={`Category: ${d().category || "none"}. Change`}
            >
              <span class="flex min-w-0 items-center gap-1.5">
                <StatusDot class={categoryTone(d().category || null)} />
                <span class="truncate">{d().category || "None"}</span>
              </span>
              <ChevronDown class="text-subtle" />
            </DropdownMenuTrigger>
            <DropdownMenuContent class="min-w-48">
              <DropdownMenuRadioGroup value={d().category} onChange={(v) => f().set("category", v)}>
                <DropdownMenuRadioItem value="" closeOnSelect>
                  No category
                </DropdownMenuRadioItem>
                <For each={categories()}>
                  {(name) => (
                    <DropdownMenuRadioItem value={name} closeOnSelect>
                      {name}
                    </DropdownMenuRadioItem>
                  )}
                </For>
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => setCreatingCategory(true)}>
                New category…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </OptionRow>
        <OptionRow label="Tags" changed={f().changed("tags")}>
          <span class="flex max-w-[240px] flex-wrap items-center justify-end gap-1">
            <For each={d().tags}>
              {(tag) => (
                <Badge class="gap-1 pr-0.5">
                  {tag}
                  <button
                    type="button"
                    class="flex size-3.5 items-center justify-center rounded-sm text-subtle hover:text-foreground"
                    aria-label={`Remove tag ${tag}`}
                    onClick={() =>
                      f().set(
                        "tags",
                        d().tags.filter((t) => t !== tag),
                      )
                    }
                  >
                    <X size={10} />
                  </button>
                </Badge>
              )}
            </For>
            <DropdownMenu>
              <DropdownMenuTrigger
                as={Button}
                variant="outline"
                size="icon-sm"
                class="size-5"
                aria-label="Add tags"
              >
                <Plus />
              </DropdownMenuTrigger>
              <DropdownMenuContent class="min-w-44">
                <For each={allTags()}>
                  {(tag) => (
                    <DropdownMenuCheckboxItem
                      checked={d().tags.includes(tag)}
                      closeOnSelect={false}
                      onChange={(on) =>
                        f().set("tags", on ? [...d().tags, tag] : d().tags.filter((t) => t !== tag))
                      }
                    >
                      {tag}
                    </DropdownMenuCheckboxItem>
                  )}
                </For>
                <Show when={allTags().length > 0}>
                  <DropdownMenuSeparator />
                </Show>
                <DropdownMenuItem onSelect={() => setCreatingTag(true)}>New tag…</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </span>
        </OptionRow>
        <OptionRow
          label="Save path"
          for={id("save_path")}
          changed={f().changed("save_path")}
          error={f().fieldError("save_path")}
        >
          <UnitInput
            id={id("save_path")}
            class="h-[30px] w-[240px]"
            align="left"
            inputMode="text"
            value={d().auto_management ? props.torrent.save_path : d().save_path}
            disabled={d().auto_management}
            changed={f().changed("save_path")}
            invalid={f().fieldError("save_path") !== undefined}
            onInput={(v) => f().set("save_path", v)}
            trailing={
              <FolderPicker
                inline
                what="save path"
                value={d().save_path}
                disabled={d().auto_management}
                onPick={(p) => f().set("save_path", p)}
              />
            }
          />
        </OptionRow>
        <p class="m-0 -mt-0.5 text-right text-sm text-subtle">
          <Show
            when={d().auto_management}
            fallback={f().changed("save_path") ? "Saving moves the content there. " : null}
          >
            The path follows the category while automatic management is on.{" "}
          </Show>
          <button
            type="button"
            class="text-muted-foreground underline hover:text-foreground"
            onClick={() => dialogs.move([props.torrent.hash])}
          >
            Move content…
          </button>
        </p>
        <Show when={!props.torrent.complete || props.torrent.download_path !== null}>
          <OptionRow
            label="Download path"
            for={id("download_path")}
            changed={f().changed("download_path")}
            error={f().fieldError("download_path")}
          >
            <UnitInput
              id={id("download_path")}
              class="h-[30px] w-[240px]"
              align="left"
              inputMode="text"
              value={d().download_path}
              placeholder="none: in the save path"
              changed={f().changed("download_path")}
              invalid={f().fieldError("download_path") !== undefined}
              onInput={(v) => f().set("download_path", v)}
              trailing={
                <FolderPicker
                  inline
                  what="download path"
                  value={d().download_path}
                  onPick={(p) => f().set("download_path", p)}
                />
              }
            />
          </OptionRow>
        </Show>
      </div>
      <span role="status" class="sr-only">
        {f().saved() && !f().dirty() ? "Options saved" : ""}
      </span>
      <Show when={f().dirty() || f().problem()}>
        <div
          role="region"
          aria-label="Unsaved changes"
          class="flex flex-none items-center gap-2 border-t border-divider pt-2.5"
        >
          <StatusDot class={f().problem() ? "bg-danger" : "bg-warn"} />
          <span
            class={cn("min-w-0 flex-1 truncate text-sm", f().problem() && "text-danger")}
            title={f().problem() ?? f().diff().names.join(" · ")}
          >
            {f().problem() ??
              (f().diff().names.length === 1
                ? "1 unsaved change"
                : `${f().diff().names.length} unsaved changes`)}
          </span>
          <Button variant="outline" size="sm" onClick={() => f().discard()}>
            Discard
          </Button>
          <Button
            size="sm"
            disabled={f().busy() || Object.keys(f().diff().errors).length > 0 || !f().dirty()}
            onClick={() => void f().save()}
          >
            {f().busy() ? "Saving…" : "Save"}
          </Button>
        </div>
      </Show>
      <PromptDialog
        open={creatingTag()}
        title="New tag"
        label="Tag"
        action="Add"
        onClose={() => setCreatingTag(false)}
        onSubmit={(tag) => {
          if (!d().tags.includes(tag)) f().set("tags", [...d().tags, tag]);
        }}
      />
      <PromptDialog
        open={creatingCategory()}
        title="New category"
        label="Name"
        action="Choose"
        onClose={() => setCreatingCategory(false)}
        onSubmit={(name) => f().set("category", name)}
      />
    </div>
  );
}
