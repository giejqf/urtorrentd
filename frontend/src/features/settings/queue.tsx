// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Queue & share limits, as the design has it: how many torrents
// run at once, with the queue as it stands against the page's limits (slots
// held, torrents waiting, the order changed by dragging), and the default
// share limits with the seeding torrents closest to one. Edits are a draft
// saved with one `PATCH /settings`; queue moves happen at once.

import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { useLive } from "~/features/shell/live";
import { formatCount, formatDuration } from "~/lib/format";
import { cn } from "~/lib/utils";

import { RowSwitch, Segmented, SettingRow, SettingsGroup, UnitInput, UnitSelect } from "./controls";
import { createSettingsForm, SettingsPage, WithSettings } from "./form";
import {
  diff,
  type DraftField,
  draftOf,
  parseRatio,
  parseTime,
  type QueueDraft,
  type TimeUnit,
} from "./queue-form";
import { QueueList } from "./queue-list";
import { type QueueEntry, queueNow } from "./queue-now";
import { parseCount } from "./speed-form";
import { closeness, effectiveLimits, type LimitKind, outlook } from "./share";

type Row = Schemas["TorrentSummary"];

const UNITS: { value: TimeUnit; label: string }[] = [
  { value: "minutes", label: "min" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
];

const ACTIONS: { value: Schemas["ShareLimitAction"]; label: string; danger?: boolean }[] = [
  { value: "stop", label: "Stop" },
  { value: "remove", label: "Remove" },
  { value: "remove_with_files", label: "Remove with files", danger: true },
];

const ACTION_WORDS: Record<Schemas["ShareLimitAction"], string> = {
  stop: "stop",
  remove: "remove",
  remove_with_files: "remove with files",
};

/** Seeding torrents shown against the limits at most. */
const SEED_ROWS = 8;
/** Slot boxes drawn at most. */
const MAX_BOXES = 40;

const tag =
  "inline-flex h-[18px] items-center rounded border border-border px-1.5 mono text-2xs text-muted-foreground";

/** A long time, roughly: `14 d`, `5 h`, `12 min`. */
function rough(seconds: number): string {
  if (seconds >= 86_400) return `${Math.floor(seconds / 86_400)} d`;
  if (seconds >= 3600) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 60)} min`;
}

function Slots(props: {
  title: string;
  holders: QueueEntry<Row>[];
  capacity: number | null;
  waiting: number;
  released: number;
}) {
  const used = () => props.holders.length;
  const free = () => (props.capacity === null ? 0 : Math.max(0, props.capacity - used()));
  const shown = () => props.holders.slice(0, MAX_BOXES);
  const summary = () => {
    const parts = [
      props.capacity === null
        ? `${formatCount(used())} used · no limit`
        : `${formatCount(used())} of ${formatCount(props.capacity)} used`,
    ];
    const slow = props.holders.filter((h) => h.slow).length;
    if (slow > 0) parts.push(`${formatCount(slow)} slow`);
    if (props.released > 0) parts.push(`${formatCount(props.released)} slow, released`);
    if (props.capacity !== null && used() > props.capacity) {
      parts.push(`${formatCount(used() - props.capacity)} over`);
    }
    if (props.waiting > 0) parts.push(`${formatCount(props.waiting)} waiting`);
    return parts.join(" · ");
  };
  return (
    <div class="flex min-w-0 flex-col gap-1.5">
      <div class="flex justify-between gap-3 text-sm">
        <span>{props.title}</span>
        <span class="mono text-subtle">{summary()}</span>
      </div>
      <div class="flex flex-wrap gap-1" aria-hidden="true">
        <For each={shown()}>
          {(h, i) => (
            <span
              class={cn(
                "h-2.5 w-[34px] rounded-[3px]",
                h.slow ? "bg-warn" : h.kind === "download" ? "bg-brand" : "bg-ok",
                props.capacity !== null && i() >= props.capacity && "ring-1 ring-danger",
              )}
            />
          )}
        </For>
        <For each={Array.from({ length: Math.min(free(), MAX_BOXES - shown().length) })}>
          {() => (
            <span class="h-2.5 w-[34px] rounded-[3px] border border-border-strong bg-divider" />
          )}
        </For>
      </div>
    </div>
  );
}

function Legend(props: { class: string; label: string }) {
  return (
    <span class="flex items-center gap-1.5">
      <span class={cn("h-1.5 w-3.5 rounded-[3px]", props.class)} />
      {props.label}
    </span>
  );
}

function QueueForm(props: { saved: Schemas["Settings"] }) {
  const live = useLive();
  const form = createSettingsForm<QueueDraft, DraftField>(() => props.saved, draftOf, diff);
  const { draft, changed, error, set } = form;
  const [now, setNow] = createSignal(Date.now() / 1000);
  const timer = setInterval(() => setNow(Date.now() / 1000), 15_000);
  onCleanup(() => clearInterval(timer));

  const countRow = (
    field: "max_active_downloads" | "max_active_uploads" | "max_active_torrents",
    label: string,
    description: string,
  ) => (
    <SettingRow
      label={label}
      for={`q-${field}`}
      description={description}
      changed={changed(field)}
      error={error(field)}
    >
      <UnitInput
        id={`q-${field}`}
        value={draft[field]}
        onInput={(v) => set(field, v)}
        unit="torrents"
        placeholder="∞"
        inputMode="numeric"
        muted={!draft.queueing_enabled}
        changed={changed(field)}
        invalid={error(field) !== undefined}
      />
    </SettingRow>
  );
  const timeRow = (
    field: "max_seeding_time" | "max_inactive_seeding_time",
    label: string,
    description: string,
  ) => (
    <SettingRow
      label={label}
      for={`q-${field}`}
      description={description}
      changed={changed(field)}
      error={error(field)}
    >
      <UnitInput
        id={`q-${field}`}
        value={draft[field]}
        onInput={(v) => set(field, v)}
        placeholder="∞"
        changed={changed(field)}
        invalid={error(field) !== undefined}
        trailing={
          <UnitSelect
            label={`${label} unit`}
            options={UNITS}
            value={draft[`${field}_unit`]}
            onChange={(u) => set(`${field}_unit`, u)}
          />
        }
      />
    </SettingRow>
  );

  // The draft's limits, where they are valid; the saved ones otherwise.
  const limit = (field: "max_active_downloads" | "max_active_uploads" | "max_active_torrents") => {
    if (!draft.queueing_enabled) return null;
    const v = parseCount(draft[field], true);
    return v === undefined ? props.saved[field] : v;
  };
  const queue = createMemo(() => queueNow(live.torrents(), draft.count_slow_torrents));
  const active = () => queue().downloads.length + queue().uploads.length;
  const released = (kind: "download" | "upload") =>
    queue().entries.filter((e) => e.slow && e.holds === null && !e.waiting && e.kind === kind)
      .length;

  const place = async (hash: string, position: number) => {
    try {
      await unwrap(
        api.PUT("/api/v1/torrents/{hash}/queue-position", {
          params: { path: { hash } },
          body: { position },
        }),
      );
      return true;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The torrent did not move.");
      return false;
    }
  };
  const holding = (e: QueueEntry<Row>): { text: string; tone: "plain" | "warn" | "wait" } => {
    const slot = e.kind === "download" ? "download slot" : "upload slot";
    if (e.waiting)
      return { text: `waiting for ${e.kind === "download" ? "a" : "an"} ${slot}`, tone: "wait" };
    if (e.holds === null) return { text: "slot released (slow)", tone: "wait" };
    if (e.row.forced) return { text: `${slot} · forced`, tone: "plain" };
    if (e.slow) {
      const quiet =
        e.row.download_rate === 0 && e.row.upload_rate === 0 && e.row.last_activity !== null
          ? `no data for ${formatDuration(now() - e.row.last_activity)}`
          : "slow";
      return { text: `${slot} · ${quiet}`, tone: "warn" };
    }
    return { text: slot, tone: "plain" };
  };

  // Share limits: the draft's, where valid.
  const globals = () => {
    const ratio = parseRatio(draft.max_ratio);
    const seeding = parseTime(draft.max_seeding_time, draft.max_seeding_time_unit);
    const inactive = parseTime(
      draft.max_inactive_seeding_time,
      draft.max_inactive_seeding_time_unit,
    );
    return {
      ratio: ratio === undefined ? props.saved.max_ratio : ratio,
      seeding: seeding === undefined ? props.saved.max_seeding_time : seeding,
      inactive: inactive === undefined ? props.saved.max_inactive_seeding_time : inactive,
      action: draft.share_limit_action,
    };
  };
  const seeds = createMemo(() => {
    const g = globals();
    const t = now();
    return live
      .torrents()
      .filter((r) => r.state === "seeding")
      .map((r) => {
        const cat = r.category === null ? undefined : live.state.categories[r.category];
        const limits = effectiveLimits(r.share_limits, cat?.share_limits, g);
        const o = outlook(r, limits, t);
        return { row: r, limits, o, key: closeness(o) };
      })
      .sort((a, b) => a.key - b.key);
  });
  const nextText = (s: ReturnType<typeof seeds>[number]) => {
    const action = ACTION_WORDS[s.limits.action];
    if (s.o.reached) return `${s.o.reached} reached → ${action}`;
    const n = s.o.next;
    if (n) {
      const what: Record<LimitKind, string> = {
        ratio: "ratio at this rate",
        "seeding time": "seeding time",
        "inactive time": "inactive time",
      };
      return `${what[n.kind]} in ~${formatDuration(n.in)} → ${action}`;
    }
    return s.o.limited ? "not uploading now" : "no limits";
  };

  return (
    <SettingsPage
      title="Queue & share limits"
      description="How many torrents run at once, and when a finished torrent has seeded enough."
      form={form}
    >
      <SettingsGroup title="Queue">
        <SettingRow
          label="Limit how many torrents are active at once"
          for="q-queueing_enabled-input"
          description="Others wait in queue order. Force-started torrents run whatever the limits, and take a slot."
          changed={changed("queueing_enabled")}
        >
          <RowSwitch
            id="q-queueing_enabled"
            checked={draft.queueing_enabled}
            onChange={(v) => set("queueing_enabled", v)}
          />
        </SettingRow>
        {countRow(
          "max_active_downloads",
          "Active downloads",
          "Downloading torrents running at once. Empty = unlimited.",
        )}
        {countRow(
          "max_active_uploads",
          "Active uploads",
          "Seeding torrents running at once. Empty = unlimited.",
        )}
        {countRow(
          "max_active_torrents",
          "Active torrents in total",
          "A cap over both. Empty = unlimited.",
        )}
        <SettingRow
          label="Count slow torrents"
          for="q-count_slow_torrents-input"
          description="A torrent under 2 KiB/s both ways for 60 s still holds its slot. Off, its slot goes to the next in the queue."
          changed={changed("count_slow_torrents")}
        >
          <RowSwitch
            id="q-count_slow_torrents"
            checked={draft.count_slow_torrents}
            onChange={(v) => set("count_slow_torrents", v)}
          />
        </SettingRow>

        <section
          aria-label="The queue right now"
          class="flex flex-col gap-3 border-t border-accent px-4 pt-3.5 pb-1.5"
        >
          <div class="flex flex-wrap items-center justify-between gap-x-4">
            <span class="text-sm text-subtle">The queue right now, with these limits</span>
            <span class="mono text-sm text-subtle">
              {draft.queueing_enabled
                ? `${formatCount(active())} / ${limit("max_active_torrents") === null ? "∞" : formatCount(limit("max_active_torrents") ?? 0)} active`
                : "queueing off: every started torrent runs"}
            </span>
          </div>
          <div class="grid grid-cols-1 gap-6 sm:grid-cols-2">
            <Slots
              title="Download slots"
              holders={queue().downloads}
              capacity={limit("max_active_downloads")}
              waiting={queue().waiting.download}
              released={released("download")}
            />
            <Slots
              title="Upload slots"
              holders={queue().uploads}
              capacity={limit("max_active_uploads")}
              waiting={queue().waiting.upload}
              released={released("upload")}
            />
          </div>
          <div class="flex flex-wrap gap-3 text-xs text-muted-foreground">
            <Legend class="bg-brand" label="downloading" />
            <Legend class="bg-ok" label="seeding" />
            <Show when={draft.count_slow_torrents}>
              <Legend class="bg-warn" label="slow, still counted" />
            </Show>
            <Legend class="border border-border-strong bg-divider" label="free" />
          </div>
        </section>
        <div class="flex flex-col pt-2 pb-1">
          <Show
            when={queue().entries.length > 0}
            fallback={
              <p class="m-0 px-4 pb-3 text-sm text-subtle">Nothing is running or waiting.</p>
            }
          >
            <QueueList entries={queue().entries} holding={holding} onPlace={place} />
          </Show>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title="Share limits"
        aside="Defaults: a category or a torrent can set its own, or none"
      >
        <SettingRow
          label="Ratio"
          for="q-max_ratio"
          description="Uploaded ÷ downloaded. Empty = no ratio limit."
          changed={changed("max_ratio")}
          error={error("max_ratio")}
        >
          <UnitInput
            id="q-max_ratio"
            value={draft.max_ratio}
            onInput={(v) => set("max_ratio", v)}
            unit="×"
            placeholder="∞"
            changed={changed("max_ratio")}
            invalid={error("max_ratio") !== undefined}
          />
        </SettingRow>
        {timeRow(
          "max_seeding_time",
          "Seeding time",
          "Total time seeding since the torrent completed. Empty = no limit.",
        )}
        {timeRow(
          "max_inactive_seeding_time",
          "Inactive seeding time",
          "Seeding without moving any data. Catches torrents nobody wants any more.",
        )}
        <SettingRow
          label="When a limit is reached"
          description="Whichever limit comes first. Remove keeps the files on disk; Remove with files deletes them."
          changed={changed("share_limit_action")}
        >
          <Segmented
            label="When a limit is reached"
            options={ACTIONS}
            value={draft.share_limit_action}
            onChange={(v) => set("share_limit_action", v)}
          />
        </SettingRow>

        <section
          aria-label="Seeding torrents against these limits"
          class="flex flex-col border-t border-accent pt-3.5 pb-1"
        >
          <div class="flex flex-wrap items-center justify-between gap-x-4 px-4 pb-2">
            <span class="text-sm text-subtle">
              Seeding torrents against these limits, closest first
            </span>
            <span class="text-sm leading-6 text-subtle">
              Limits of their own show as <span class={cn(tag, "align-middle")}>own</span>, their
              category's as <span class={cn(tag, "align-middle")}>category</span>
            </span>
          </div>
          <Show
            when={seeds().length > 0}
            fallback={<p class="m-0 px-4 pb-3 text-sm text-subtle">No torrent is seeding.</p>}
          >
            <table class="w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col />
                <col class="w-[136px]" />
                <col class="w-[136px]" />
                <col class="w-[244px]" />
              </colgroup>
              <thead>
                <tr class="h-[26px] border-b border-accent text-xs text-subtle">
                  <th class="pl-4 text-left font-normal">Torrent</th>
                  <th class="px-1.5 text-left font-normal">Ratio</th>
                  <th class="px-1.5 text-left font-normal">Seeding time</th>
                  <th class="pr-4 pl-1.5 text-left font-normal">Next</th>
                </tr>
              </thead>
              <tbody>
                <For each={seeds().slice(0, SEED_ROWS)}>
                  {(s) => {
                    const urgent = () =>
                      s.o.reached !== null || (s.o.next !== null && s.o.next.in < 86_400);
                    const bar = (share: number | null) => (
                      <div class="h-[5px] overflow-hidden rounded-full bg-divider">
                        <div
                          class={cn("h-full", (share ?? 0) >= 0.85 ? "bg-warn" : "bg-ok")}
                          style={{ width: `${Math.round((share ?? 0) * 100)}%` }}
                        />
                      </div>
                    );
                    return (
                      <tr class="h-10 border-b border-accent last:border-b-0">
                        <td class="pl-4">
                          <span class="flex min-w-0 items-center gap-2">
                            <span class="truncate">{s.row.name}</span>
                            <Show when={s.limits.own || s.limits.category}>
                              <span
                                class={cn(tag, "flex-none")}
                                title={s.limits.own ? "Its own limits" : "Its category's limits"}
                              >
                                {s.limits.own ? "own" : "category"}
                              </span>
                            </Show>
                          </span>
                        </td>
                        <td class="px-1.5">
                          <div class="flex flex-col gap-[3px]">
                            {bar(s.o.ratioShare)}
                            <span class="mono text-2xs text-subtle">
                              {s.row.ratio === null ? "—" : s.row.ratio.toFixed(2)} /{" "}
                              {s.limits.ratio === null ? "∞" : s.limits.ratio.toFixed(1)}
                            </span>
                          </div>
                        </td>
                        <td class="px-1.5">
                          <div class="flex flex-col gap-[3px]">
                            {bar(s.o.seedingShare)}
                            <span class="mono text-2xs text-subtle">
                              {rough(s.row.seeding_time)} /{" "}
                              {s.limits.seeding === null ? "∞" : rough(s.limits.seeding)}
                            </span>
                          </div>
                        </td>
                        <td
                          class={cn("truncate pr-4 pl-1.5", urgent() ? "text-warn" : "text-subtle")}
                          title={nextText(s)}
                        >
                          {nextText(s)}
                        </td>
                      </tr>
                    );
                  }}
                </For>
              </tbody>
            </table>
            <Show when={seeds().length > SEED_ROWS}>
              <p class="m-0 border-t border-accent px-4 py-2 text-sm text-subtle">
                {formatCount(seeds().length - SEED_ROWS)} more seeding, further from a limit.
              </p>
            </Show>
          </Show>
        </section>
      </SettingsGroup>
    </SettingsPage>
  );
}

export default function Queue() {
  return (
    <WithSettings title="Queue & share limits">
      {(saved) => <QueueForm saved={saved()} />}
    </WithSettings>
  );
}
