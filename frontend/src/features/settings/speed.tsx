// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Speed, as the design has it: the global limits, the
// alternative limits and their schedule, the connection budget. Edits are a
// draft saved with one `PATCH /settings`; whether the alternative limits
// are in force is live state, switched at once (`PUT /transfer/alt-speed`).
// What the page says about now (rates, peers, the next switch) is the
// daemon's.

import { useBeforeLeave } from "@solidjs/router";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
import {
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch, SwitchControl } from "~/components/ui/switch";
import { useLive } from "~/features/shell/live";
import { formatCount, formatRate } from "~/lib/format";

import { useAppInfo } from "./app-info";
import { Chips, SaveBar, SettingRow, SettingsGroup, UnitInput } from "./controls";
import { SettingsFrame } from "./frame";
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

// A switch named by its row's label: Kobalte's input id is `<id>-input`.
function Toggle(props: { id: string; checked: boolean; onChange: (on: boolean) => void }) {
  return (
    <Switch id={props.id} checked={props.checked} onChange={props.onChange}>
      <SwitchControl />
    </Switch>
  );
}

function Loading() {
  return (
    <div class="h-40 animate-pulse rounded-tile bg-muted" role="status" aria-label="Loading" />
  );
}

function SpeedForm(props: { saved: Schemas["Settings"] }) {
  const live = useLive();
  const app = useAppInfo();
  const client = useQueryClient();
  // Starts from the saved settings; the effect below follows later ones.
  const [draft, setDraft] = createStore<SpeedDraft>(untrack(() => draftOf(props.saved)));
  const [busy, setBusy] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);
  const [leaving, setLeaving] = createSignal<(() => void) | null>(null);

  // A save (or another client) brings new settings: start over from them.
  createEffect(
    on(
      () => props.saved,
      (s) => setDraft(reconcile(draftOf(s))),
      { defer: true },
    ),
  );

  const d = createMemo(() => diff(props.saved, draft));
  const changed = (f: DraftField) => d().changed.has(f);
  const error = (f: DraftField) => d().errors[f];
  const firstError = () => Object.values(d().errors)[0] ?? null;
  const dirty = () => d().changed.size > 0;
  const set = <K extends DraftField>(f: K, v: SpeedDraft[K]) => {
    setSaveError(null);
    setDraft(f, v);
  };

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

  const save = async () => {
    if (busy() || !dirty()) return;
    if (firstError()) return;
    setBusy(true);
    try {
      const next = await unwrap(api.PATCH("/api/v1/settings", { body: d().patch }));
      client.setQueryData(keys.settings(), next);
      void client.invalidateQueries({ queryKey: keys.app() });
      toast.success("Saved");
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : "The settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const discard = () => {
    setSaveError(null);
    setDraft(reconcile(draftOf(props.saved)));
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void save();
    }
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));
  useBeforeLeave((e) => {
    if (dirty() && !e.defaultPrevented) {
      e.preventDefault();
      setLeaving(() => () => e.retry(true));
    }
  });

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
    <SettingsFrame
      title="Speed"
      description="Global rate limits, the alternative limits and when they switch on. Limits apply as soon as they are saved; 0 or empty means unlimited."
      overlay={
        <SaveBar
          names={d().names}
          error={saveError() ?? firstError()}
          busy={busy()}
          onDiscard={discard}
          onSave={() => void save()}
        />
      }
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
          <Toggle id="speed-alt" checked={altOn()} onChange={(v) => void switchAlt(v)} />
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
          <Toggle
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

      <AlertDialog open={leaving() !== null} onOpenChange={(o) => !o && setLeaving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              {d().names.length === 1 ? "1 change is" : `${d().names.length} changes are`} not
              saved: {d().names.join(", ")}.
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
                discard();
                go?.();
              }}
            >
              Leave
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsFrame>
  );
}

export default function Speed() {
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
  }));
  return (
    <Show
      when={settings.data}
      fallback={
        <SettingsFrame title="Speed">
          <Show when={settings.isError} fallback={<Loading />}>
            <p class="m-0 text-danger" role="alert">
              {settings.error instanceof ApiError
                ? settings.error.message
                : "The settings could not be read."}
            </p>
          </Show>
        </SettingsFrame>
      }
    >
      {(s) => <SpeedForm saved={s()} />}
    </Show>
  );
}
