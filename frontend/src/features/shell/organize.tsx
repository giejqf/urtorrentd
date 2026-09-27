// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The torrent filters' categories and tags, managed where they are listed
// (not designed; the RSS sidebar's pattern): the "+" beside a title makes
// one, and a row's menu edits or removes a category (the Downloads page's
// dialog) or deletes a tag, after a question that says how many torrents
// lose it.

import { createQuery } from "@tanstack/solid-query";
import Folder from "lucide-solid/icons/folder";
import { createSignal, For, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { ConfirmDialog } from "~/components/confirm-dialog";
import { PromptDialog } from "~/components/prompt-dialog";
import { DropdownMenuItem, DropdownMenuSeparator } from "~/components/ui/dropdown-menu";
import { CategoryDialog, type CategoryEditing } from "~/features/settings/categories";
import { formatCount } from "~/lib/format";
import { cn } from "~/lib/utils";

import { FilterItem, MenuRow, Section, SectionAdd } from "./sidebar-items";

interface Listed {
  /** The names, `""` being the torrents without one (categories only). */
  names: readonly string[];
  count: (name: string) => number;
  active: string | undefined;
  onToggle: (name: string) => void;
  /** It is gone: a filter on it is dropped. */
  onGone: (name: string) => void;
}

export function CategorySection(props: Listed) {
  const [editing, setEditing] = createSignal<CategoryEditing | null>(null);
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
    enabled: editing() !== null,
  }));
  return (
    <Section
      title="Categories"
      action={<SectionAdd label="New category" onClick={() => setEditing({ kind: "new" })} />}
    >
      <For each={props.names}>
        {(name) => {
          const label = (
            <>
              <Folder size={13} class="flex-none text-subtle" />
              <span class={cn("truncate", name === "" && "italic")}>
                {name === "" ? "No category" : name}
              </span>
            </>
          );
          return name === "" ? (
            <FilterItem
              label={label}
              count={props.count(name)}
              active={props.active === name}
              onClick={() => props.onToggle(name)}
            />
          ) : (
            <MenuRow
              label={label}
              count={props.count(name)}
              active={props.active === name}
              onSelect={() => props.onToggle(name)}
              menuLabel={`Category ${name}: actions`}
              menu={
                <>
                  <DropdownMenuItem onSelect={() => setEditing({ kind: "edit", name })}>
                    Edit category…
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    class="text-danger"
                    onSelect={() => setEditing({ kind: "edit", name, remove: true })}
                  >
                    Remove category…
                  </DropdownMenuItem>
                </>
              }
            />
          );
        }}
      </For>
      <Show when={props.names.length === 0}>
        <p class="m-0 px-2 py-1 text-sm text-subtle">No category yet.</p>
      </Show>
      <Show when={settings.data}>
        {(s) => (
          <CategoryDialog
            editing={editing()}
            savePath={s().save_path}
            downloadPath={s().download_path}
            count={props.count}
            onClose={() => setEditing(null)}
            onRemoved={props.onGone}
          />
        )}
      </Show>
    </Section>
  );
}

export function TagSection(props: Listed) {
  const [creating, setCreating] = createSignal(false);
  const [deleting, setDeleting] = createSignal<string | null>(null);
  const create = async (tag: string) => {
    try {
      await unwrap(api.POST("/api/v1/tags", { body: { tags: [tag] } }));
      toast.success(`Tag ${tag} created`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The tag could not be created.");
    }
  };
  const remove = async (tag: string) => {
    try {
      await unwrap(api.POST("/api/v1/tags/remove", { body: { tags: [tag] } }));
      toast.success(`Tag ${tag} deleted`);
      props.onGone(tag);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The tag could not be deleted.");
    }
  };
  return (
    <Section title="Tags" action={<SectionAdd label="New tag" onClick={() => setCreating(true)} />}>
      <For each={props.names}>
        {(tag) => (
          <MenuRow
            label={
              <>
                <span class="text-subtle" aria-hidden="true">
                  #
                </span>
                <span class="truncate">{tag}</span>
              </>
            }
            count={props.count(tag)}
            active={props.active === tag}
            onSelect={() => props.onToggle(tag)}
            menuLabel={`Tag ${tag}: actions`}
            menu={
              <DropdownMenuItem class="text-danger" onSelect={() => setDeleting(tag)}>
                Delete tag…
              </DropdownMenuItem>
            }
          />
        )}
      </For>
      <Show when={props.names.length === 0}>
        <p class="m-0 px-2 py-1 text-sm text-subtle">No tag yet.</p>
      </Show>
      <PromptDialog
        open={creating()}
        title="New tag"
        label="Tag"
        action="Create tag"
        onClose={() => setCreating(false)}
        onSubmit={(tag) => void create(tag)}
      />
      <ConfirmDialog
        open={deleting() !== null}
        title={`Delete tag ${deleting() ?? ""}?`}
        description={(() => {
          const n = props.count(deleting() ?? "");
          return n === 0
            ? "No torrent has it."
            : `It comes off the ${n === 1 ? "torrent that has" : `${formatCount(n)} torrents that have`} it.`;
        })()}
        action="Delete tag"
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          const tag = deleting();
          if (tag !== null) void remove(tag);
        }}
      />
    </Section>
  );
}
