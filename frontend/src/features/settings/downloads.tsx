// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Downloads, as the design has it: where content goes (save and
// download paths, the incomplete-file suffix, automatic management) with a
// picture of the path a new torrent takes, the categories' paths, what
// happens when a torrent is added, file name patterns to skip, `.torrent`
// exports, and the trackers added to new public torrents. Edits are a draft
// saved with one `PATCH /settings`; categories are changed at once through
// `/categories`, and the tracker list is fetched on demand.

import { useQueryClient } from "@tanstack/solid-query";
import { createMemo, createSignal, onCleanup, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { FolderPicker } from "~/components/folder-picker";
import { StatusDot } from "~/components/status-dot";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useLive } from "~/features/shell/live";
import { formatAgo, formatCount } from "~/lib/format";

import { useAppInfo } from "./app-info";
import { CategoryPaths } from "./categories";
import { ChipList, RowSwitch, Segmented, SettingRow, SettingsGroup, UnitInput } from "./controls";
import {
  type DownloadsDraft,
  diff,
  type DraftField,
  draftOf,
  pathProblem,
  patternProblem,
  trackerProblem,
} from "./downloads-form";
import { createSettingsForm, SettingsPage, WithSettings } from "./form";
import { PathFlow } from "./path-flow";
import { contentIn } from "./paths";

const LAYOUTS: { value: Schemas["ContentLayout"]; label: string }[] = [
  { value: "original", label: "Original" },
  { value: "subfolder", label: "Subfolder" },
  { value: "no_subfolder", label: "No subfolder" },
];

const STOPS: { value: Schemas["StopCondition"]; label: string }[] = [
  { value: "none", label: "None" },
  { value: "metadata_received", label: "Metadata received" },
  { value: "files_checked", label: "Files checked" },
];

type Optional =
  | "download_path"
  | "incomplete_file_suffix"
  | "export_dir"
  | "export_dir_finished"
  | "add_trackers_url";

function DownloadsForm(props: { saved: Schemas["Settings"] }) {
  const live = useLive();
  const app = useAppInfo();
  const client = useQueryClient();
  const form = createSettingsForm<DownloadsDraft, DraftField>(() => props.saved, draftOf, diff);
  const { draft, changed, error, set } = form;

  /** A switch and its text: typing a value turns the switch on. */
  const optionalText = (field: Optional, v: string) => {
    set(field, v);
    if (v.trim() !== "") set(`${field}_on`, true);
  };
  const flagRow = (
    field:
      | "auto_management"
      | "category_paths_in_manual_mode"
      | "add_stopped"
      | "add_to_top_of_queue"
      | "merge_trackers"
      | "preallocate"
      | "recheck_on_completion",
    label: string,
    description?: string,
  ) => (
    <SettingRow
      label={label}
      for={`dl-${field}-input`}
      description={description}
      changed={changed(field)}
    >
      <RowSwitch id={`dl-${field}`} checked={draft[field]} onChange={(v) => set(field, v)} />
    </SettingRow>
  );
  /** A row whose value can be off: a path or text field, then its switch. */
  const optionalRow = (
    field: Optional,
    label: string,
    description: string | undefined,
    fieldLabel: string,
    opts: { width: string; placeholder?: string; browse?: string; url?: boolean },
  ) => (
    <SettingRow
      label={label}
      for={`dl-${field}-switch-input`}
      description={description}
      changed={changed(field)}
      error={error(field)}
    >
      <div class="flex items-center gap-3">
        <UnitInput
          id={`dl-${field}`}
          label={fieldLabel}
          class={opts.width}
          align="left"
          inputMode={opts.url ? "url" : "text"}
          placeholder={opts.placeholder}
          value={draft[field]}
          muted={!draft[`${field}_on`]}
          changed={changed(field)}
          invalid={error(field) !== undefined}
          onInput={(v) => optionalText(field, v)}
          trailing={
            opts.browse === undefined ? undefined : (
              <FolderPicker
                inline
                value={draft[field] === "" ? draft.save_path : draft[field]}
                what={opts.browse}
                onPick={(p) => optionalText(field, p)}
              />
            )
          }
        />
        <RowSwitch
          id={`dl-${field}-switch`}
          checked={draft[`${field}_on`]}
          onChange={(v) => set(`${field}_on`, v)}
        />
      </div>
    </SettingRow>
  );

  // What the flow shows: the draft, where it is valid.
  const stagingPath = () =>
    draft.download_path_on && pathProblem(draft.download_path.trim()) === null
      ? draft.download_path.trim()
      : null;
  const staged = createMemo(() => {
    const p = stagingPath();
    return p === null ? { count: 0, bytes: 0 } : contentIn(live.torrents(), p);
  });
  const free = () => {
    const bytes = live.state.transfer?.free_space;
    return bytes === null || bytes === undefined ? null : { path: props.saved.save_path, bytes };
  };

  // The fetched tracker list is the daemon's, for the saved URL.
  const fetched = () => app.data?.fetched_trackers ?? null;
  const [now, setNow] = createSignal(Date.now() / 1000);
  const timer = setInterval(() => setNow(Date.now() / 1000), 15_000);
  onCleanup(() => clearInterval(timer));
  const urlUnsaved = () => changed("add_trackers_url");
  const fetchNow = async () => {
    try {
      await unwrap(api.POST("/api/v1/app/fetched-trackers/refresh"));
      await client.invalidateQueries({ queryKey: keys.app() });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The tracker list was not fetched.");
    }
  };

  return (
    <SettingsPage
      title="Downloads"
      description="Where content lands, how new torrents are added, and what happens to their files."
      form={form}
    >
      <SettingsGroup title="Locations">
        <SettingRow
          label="Save path"
          for="dl-save_path"
          description="Where new torrents are saved. An absolute path on the daemon's machine."
          changed={changed("save_path")}
          error={error("save_path")}
        >
          <UnitInput
            id="dl-save_path"
            class="w-[300px]"
            align="left"
            inputMode="text"
            value={draft.save_path}
            changed={changed("save_path")}
            invalid={error("save_path") !== undefined}
            onInput={(v) => set("save_path", v)}
            trailing={
              <FolderPicker
                inline
                value={draft.save_path}
                what="save path"
                onPick={(p) => set("save_path", p)}
              />
            }
          />
        </SettingRow>
        {optionalRow(
          "download_path",
          "Keep incomplete downloads elsewhere",
          "Content lives here until it completes, then moves to its save path.",
          "Download path",
          { width: "w-[254px]", placeholder: "/path", browse: "download path" },
        )}
        {optionalRow(
          "incomplete_file_suffix",
          "Mark incomplete files",
          "Appended to every file that is not complete yet; removed when it is. Changing it renames the files of every torrent.",
          "Incomplete file suffix",
          { width: "w-[120px]" },
        )}
        {flagRow(
          "auto_management",
          "Automatic management for new torrents",
          "The save path follows the category; changing a category's path moves its torrents.",
        )}
        {flagRow(
          "category_paths_in_manual_mode",
          "Category paths in manual mode",
          "A manually managed torrent added with a category and no path of its own still goes to the category's path.",
        )}
        <PathFlow
          savePath={draft.save_path.trim()}
          downloadPath={stagingPath()}
          suffix={draft.incomplete_file_suffix_on ? draft.incomplete_file_suffix : null}
          autoManagement={draft.auto_management}
          manualCategoryPaths={draft.category_paths_in_manual_mode}
          stopCondition={draft.stop_condition}
          addStopped={draft.add_stopped}
          recheck={draft.recheck_on_completion}
          free={free()}
          staged={staged()}
        />
      </SettingsGroup>

      <section aria-label="Category paths" class="flex flex-col gap-2.5">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4">
          <h2 class="m-0 text-md font-semibold">Category paths</h2>
          <span class="text-sm text-subtle">
            Relative paths resolve under the save path · <span class="mono">/categories</span>
          </span>
        </div>
        <CategoryPaths savePath={props.saved.save_path} downloadPath={props.saved.download_path} />
      </section>

      <SettingsGroup title="When a torrent is added">
        <SettingRow
          label="Content layout"
          description="Original keeps the torrent's own folder; Subfolder always wraps files in one; No subfolder flattens."
          changed={changed("content_layout")}
        >
          <Segmented
            label="Content layout"
            options={LAYOUTS}
            value={draft.content_layout}
            onChange={(v) => set("content_layout", v)}
          />
        </SettingRow>
        <SettingRow
          label="Stop condition"
          description="Stop the torrent once its metadata arrives or once its files are checked, to pick files before anything downloads."
          changed={changed("stop_condition")}
        >
          <Select<Schemas["StopCondition"]>
            options={STOPS.map((s) => s.value)}
            value={draft.stop_condition}
            onChange={(v) => v !== null && set("stop_condition", v)}
            itemComponent={(p) => (
              <SelectItem item={p.item}>
                {STOPS.find((s) => s.value === p.item.rawValue)?.label}
              </SelectItem>
            )}
          >
            <SelectTrigger
              aria-label="Stop condition"
              class="h-8 w-auto min-w-[170px] rounded-md px-2.5 text-sm"
            >
              <SelectValue<Schemas["StopCondition"]>>
                {(s) => STOPS.find((x) => x.value === s.selectedOption())?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </SettingRow>
        {flagRow("add_stopped", "Add stopped", "New torrents wait until you start them.")}
        {flagRow("add_to_top_of_queue", "Add to the top of the queue")}
        {flagRow(
          "merge_trackers",
          "Merge trackers into duplicates",
          "Adding a torrent that is already here merges its trackers and web seeds into it instead of failing. Never for private torrents.",
        )}
        {flagRow(
          "preallocate",
          "Preallocate files",
          "Create content files at full size up front: less fragmentation, a moment longer to add.",
        )}
        {flagRow(
          "recheck_on_completion",
          "Recheck on completion",
          "Verify the data again after the download finishes and any move.",
        )}
      </SettingsGroup>

      <SettingsGroup title="Files">
        <SettingRow
          label="Skip files named"
          for="dl-excluded_file_names"
          class="items-start"
          description={
            <>
              Matched on add against each file's name and its folders; <span class="mono">*</span>{" "}
              and <span class="mono">?</span> wildcards, case ignored. Skipped files get priority 0.
            </>
          }
          changed={changed("excluded_file_names")}
          error={error("excluded_file_names")}
        >
          <ChipList
            id="dl-excluded_file_names"
            what="pattern"
            layout="wrap"
            placeholder="add pattern…"
            values={draft.excluded_file_names}
            problem={patternProblem}
            onChange={(v) => set("excluded_file_names", v)}
          />
        </SettingRow>
        {optionalRow(
          "export_dir",
          "Export .torrent files of added torrents",
          "A copy of every torrent's metadata, written as it is added.",
          "Folder for added torrents",
          { width: "w-[254px]", placeholder: "/path", browse: "folder for added torrents" },
        )}
        {optionalRow(
          "export_dir_finished",
          "Export .torrent files of finished torrents",
          undefined,
          "Folder for finished torrents",
          { width: "w-[254px]", placeholder: "/path", browse: "folder for finished torrents" },
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Trackers added to new torrents"
        aside="Public torrents only, never private ones"
      >
        <SettingRow
          label="Your own list"
          for="dl-add_trackers"
          class="items-start"
          description="Added to every new public torrent."
          changed={changed("add_trackers")}
        >
          <ChipList
            id="dl-add_trackers"
            what="tracker"
            layout="stack"
            placeholder="udp://tracker.example.org:6969/announce"
            values={draft.add_trackers}
            problem={trackerProblem}
            onChange={(v) => set("add_trackers", v)}
          />
        </SettingRow>
        <SettingRow
          label="Fetch a list from a URL"
          for="dl-add_trackers_url-switch-input"
          class="items-start"
          description="A text file with one tracker per line, fetched at start and every 24 hours."
          changed={changed("add_trackers_url")}
          error={error("add_trackers_url")}
        >
          <div class="flex flex-col items-end gap-1.5">
            <div class="flex items-center gap-3">
              <UnitInput
                id="dl-add_trackers_url"
                label="Tracker list URL"
                class="w-[300px]"
                align="left"
                inputMode="url"
                placeholder="https://example.org/trackers.txt"
                value={draft.add_trackers_url}
                muted={!draft.add_trackers_url_on}
                changed={changed("add_trackers_url")}
                invalid={error("add_trackers_url") !== undefined}
                onInput={(v) => optionalText("add_trackers_url", v)}
              />
              <RowSwitch
                id="dl-add_trackers_url-switch"
                checked={draft.add_trackers_url_on}
                onChange={(v) => set("add_trackers_url_on", v)}
              />
            </div>
            <Show when={fetched()}>
              {(f) => (
                <span class="flex items-center gap-2 text-sm text-subtle" role="status">
                  <StatusDot
                    class={
                      f().error !== null ? "bg-danger" : f().fetched === null ? "bg-warn" : "bg-ok"
                    }
                  />
                  <Show when={!f().fetching} fallback={<span>Fetching…</span>}>
                    <Show
                      when={f().error === null}
                      fallback={<span class="text-danger">Last fetch failed: {f().error}</span>}
                    >
                      <span>
                        {f().fetched === null
                          ? "Not fetched yet"
                          : `${formatCount(f().trackers.length)} ${f().trackers.length === 1 ? "tracker" : "trackers"} · fetched ${formatAgo(f().fetched, now())}`}
                      </span>
                    </Show>
                  </Show>
                  <Button
                    variant="outline"
                    size="sm"
                    class="h-[22px] px-2 text-xs"
                    disabled={f().fetching || urlUnsaved()}
                    title={urlUnsaved() ? "Save the new URL first" : undefined}
                    onClick={() => void fetchNow()}
                  >
                    Fetch now
                  </Button>
                </span>
              )}
            </Show>
          </div>
        </SettingRow>
      </SettingsGroup>
    </SettingsPage>
  );
}

export default function Downloads() {
  return (
    <WithSettings title="Downloads">{(saved) => <DownloadsForm saved={saved()} />}</WithSettings>
  );
}
