// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Speed, as the design has it: the global limits, the
// alternative limits and their schedule, the connection budget. Edits are a
// draft saved with one `PATCH /settings`; whether the alternative limits
// are in force is live state, switched at once (`PUT /transfer/alt-speed`).
// What the page says about now (rates, peers, the next switch) is the
// daemon's.

import { createMemo, createSignal, type JSX, onCleanup, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useLive } from "~/features/shell/live";
import { formatCount, formatRate } from "~/lib/format";

import { useAppInfo } from "./app-info";
import { Chips, RowSwitch, SettingRow, SettingsGroup, UnitInput } from "./controls";
import { createSettingsForm, SettingsPage, WithSettings } from "./form";
import {
  clock,
  DAY_LABELS,
  hoursPerWeek,
  minutes,
  nextSwitch,
  WEEKDAYS,
  type Window,
  zonedNow,
} from "./schedule";
import { type DraftField, diff, draftOf, type SpeedDraft } from "./speed-form";
import { WeekGlance } from "./week-glance";

const DAY_OPTIONS = WEEKDAYS.map((d) => ({ value: d, label: DAY_LABELS[d] }));
const SYSTEM_ZONE = "\u0000system";

function zones(): string[] {
  try {
    return Intl.supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

function SpeedForm(props: { saved: Schemas["Settings"] }) {
  const live = useLive();
  const app = useAppInfo();
  const form = createSettingsForm<SpeedDraft, DraftField>(() => props.saved, draftOf, diff);
  const { draft, changed, error, set } = form;
  // The clock the schedule runs on: its own zone, else the daemon's.
  const [tick, setTick] = createSignal(Date.now());
  const timer = setInterval(() => setTick(Date.now()), 30_000);
  onCleanup(() => clearInterval(timer));
  const zone = () => draft.time_zone ?? app.data?.time_zone ?? undefined;
  const now = createMemo(() => {
    try {
      return zonedNow(new Date(tick()), zone());
    } catch {
      return null;
    }
  });
  const window = createMemo<Window | null>(() => {
    const from = minutes(draft.from);
    const to = minutes(draft.to);
    return from === null || to === null || from === to ? null : { from, to, days: draft.days };
  });

  const transfer = () => live.state.transfer;
  const altOn = () => transfer()?.alt_speed_enabled ?? props.saved.alt_speed_enabled;
  /** What the daemon will do: the saved schedule, not the draft. */
  const altStatus = () => {
    const saved = props.saved.alt_speed_schedule;
    const from = saved ? minutes(saved.from) : null;
    const to = saved ? minutes(saved.to) : null;
    const w = saved && from !== null && to !== null ? { from, to, days: saved.days ?? [] } : null;
    let n: { day: number; minute: number } | null;
    try {
      n = zonedNow(new Date(tick()), saved?.time_zone ?? app.data?.time_zone ?? undefined);
    } catch {
      n = null;
    }
    if (!w || !n) return altOn() ? "On until switched off." : "Off: only switched by hand.";
    const next = nextSwitch(w, n.day, n.minute);
    if (!next) return altOn() ? "On." : "Off.";
    const when = `${next.day === n.day ? "" : `${DAY_LABELS[WEEKDAYS[next.day] ?? "mon"]} `}${clock(next.minute)}`;
    return next.opens
      ? `${altOn() ? "On (by hand)" : "Off"}: the schedule turns them on at ${when}.`
      : `${altOn() ? "On" : "Off (by hand)"}: the schedule turns them off at ${when}.`;
  };
  const switchAlt = async (enabled: boolean) => {
    try {
      await unwrap(api.PUT("/api/v1/transfer/alt-speed", { body: { enabled } }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The alternative limits did not switch.");
    }
  };

  const zoneOptions = createMemo(() => {
    const all = zones();
    const current = draft.time_zone;
    return [SYSTEM_ZONE, ...(current && !all.includes(current) ? [current] : []), ...all];
  });
  const zoneLabel = (v: string) =>
    v === SYSTEM_ZONE ? `Daemon's (${app.data?.time_zone ?? "system"})` : v;

  const limitRow = (
    field: "download_limit" | "upload_limit" | "alt_download_limit" | "alt_upload_limit",
    label: string,
    description?: JSX.Element,
  ) => (
    <SettingRow
      label={label}
      for={`speed-${field}`}
      description={description}
      changed={changed(field)}
      error={error(field)}
    >
      <UnitInput
        id={`speed-${field}`}
        value={draft[field]}
        onInput={(v) => set(field, v)}
        unit="kB/s"
        placeholder="∞"
        changed={changed(field)}
        invalid={error(field) !== undefined}
      />
    </SettingRow>
  );
  const countRow = (
    field:
      "max_connections" | "max_connections_per_torrent" | "max_uploads" | "max_uploads_per_torrent",
    label: string,
    unit: string,
    description: JSX.Element,
    placeholder?: string,
  ) => (
    <SettingRow
      label={label}
      for={`speed-${field}`}
      description={description}
      changed={changed(field)}
      error={error(field)}
    >
      <UnitInput
        id={`speed-${field}`}
        value={draft[field]}
        onInput={(v) => set(field, v)}
        unit={unit}
        placeholder={placeholder}
        inputMode="numeric"
        changed={changed(field)}
        invalid={error(field) !== undefined}
      />
    </SettingRow>
  );

  return (
    <SettingsPage
      title="Speed"
      description="Global rate limits, the alternative limits and when they switch on. Limits apply as soon as they are saved; 0 or empty means unlimited."
      form={form}
    >
      <SettingsGroup title="Global limits">
        {limitRow(
          "download_limit",
          "Download limit",
          altOn()
            ? "Not in force now: the alternative limits are."
            : `Applies to every torrent together; per-torrent limits sit inside it. Downloading at ${formatRate(transfer()?.download_rate ?? 0)} now.`,
        )}
        {limitRow(
          "upload_limit",
          "Upload limit",
          altOn()
            ? "Not in force now: the alternative limits are."
            : `Uploading at ${formatRate(transfer()?.upload_rate ?? 0)} now against this cap.`,
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Alternative limits"
        aside={
          <>
            Also switched by the schedule and <span class="mono">PUT /transfer/alt-speed</span>
          </>
        }
      >
        <SettingRow
          label="Alternative limits are in force"
          for="speed-alt-input"
          description={altStatus()}
        >
          <RowSwitch id="speed-alt" checked={altOn()} onChange={(v) => void switchAlt(v)} />
        </SettingRow>
        {limitRow("alt_download_limit", "Alternative download limit")}
        {limitRow("alt_upload_limit", "Alternative upload limit")}
      </SettingsGroup>

      <SettingsGroup title="Schedule">
        <SettingRow
          label="Switch to alternative limits on a schedule"
          for="speed-schedule-input"
          description="One window a day; a window ending before it starts runs into the next day."
          changed={changed("schedule")}
        >
          <RowSwitch
            id="speed-schedule"
            checked={draft.schedule}
            onChange={(v) => set("schedule", v)}
          />
        </SettingRow>
        <Show when={draft.schedule}>
          <SettingRow
            label="Window"
            for="speed-from"
            description="In the daemon's time zone unless one is set."
            changed={changed("from") || changed("to") || changed("time_zone")}
            error={error("from") ?? error("to")}
          >
            <div class="flex flex-wrap items-center gap-2">
              <UnitInput
                id="speed-from"
                class="w-[90px]"
                align="center"
                inputMode="numeric"
                value={draft.from}
                onInput={(v) => set("from", v)}
                changed={changed("from")}
                invalid={error("from") !== undefined}
              />
              <span class="text-sm text-subtle">to</span>
              <UnitInput
                id="speed-to"
                label="Window ends at"
                class="w-[90px]"
                align="center"
                inputMode="numeric"
                value={draft.to}
                onInput={(v) => set("to", v)}
                changed={changed("to")}
                invalid={error("to") !== undefined}
              />
              <Select<string>
                modal
                options={zoneOptions()}
                value={draft.time_zone ?? SYSTEM_ZONE}
                onChange={(v) => v !== null && set("time_zone", v === SYSTEM_ZONE ? null : v)}
                itemComponent={(p) => (
                  <SelectItem item={p.item}>{zoneLabel(p.item.rawValue)}</SelectItem>
                )}
              >
                <SelectTrigger
                  aria-label="Time zone"
                  class="h-8 w-auto min-w-[150px] rounded-md px-2.5 text-sm"
                >
                  <SelectValue<string>>{(s) => zoneLabel(s.selectedOption())}</SelectValue>
                </SelectTrigger>
                <SelectContent />
              </Select>
            </div>
          </SettingRow>
          <SettingRow
            label="Days"
            description="The days a window starts on. None selected = every day."
            changed={changed("days")}
          >
            <Chips
              label="Days"
              options={DAY_OPTIONS}
              selected={draft.days}
              onChange={(days) => set("days", days)}
            />
          </SettingRow>
          <Show when={window()}>
            {(w) => (
              <div class="flex flex-col gap-2 border-t border-accent px-4 pt-3.5 pb-4">
                <div class="flex items-center justify-between gap-4">
                  <span class="text-sm text-subtle">
                    Week at a glance: filled hours run at the alternative limits
                  </span>
                  <span class="mono text-sm text-subtle">
                    {formatCount(Math.round(hoursPerWeek(w()) * 10) / 10)} h / week
                  </span>
                </div>
                <WeekGlance window={w()} hours={hoursPerWeek(w())} now={now()} />
              </div>
            )}
          </Show>
        </Show>
      </SettingsGroup>

      <SettingsGroup title="Connection budget">
        {countRow(
          "max_connections",
          "Peer connections",
          "peers",
          `Across all torrents · ${formatCount(transfer()?.peers ?? 0)} connected now.`,
        )}
        {countRow(
          "max_connections_per_torrent",
          "Peer connections per torrent",
          "peers",
          "The default for torrents without their own cap.",
        )}
        {countRow("max_uploads", "Upload slots", "slots", "Across all torrents.")}
        {countRow(
          "max_uploads_per_torrent",
          "Upload slots per torrent",
          "slots",
          "For new torrents. Empty = only the global budget.",
          "global",
        )}
      </SettingsGroup>
    </SettingsPage>
  );
}

export default function Speed() {
  return <WithSettings title="Speed">{(saved) => <SpeedForm saved={saved()} />}</WithSettings>;
}
