// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Engine, as the design has it: the machine (`GET /app/system`),
// what is saved and waits for a restart, each tuning setting as it runs
// (`GET /app` → `running`) beside its saved value, and restarting now or
// once the torrents are idle. Edits are a draft saved with one
// `PATCH /settings`; they apply at the next start.

import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { createMemo, For, type JSX, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { StatusDot } from "~/components/status-dot";
import { Button } from "~/components/ui/button";
import { dash, formatBytes, formatCount, formatDateTime } from "~/lib/format";
import { cn } from "~/lib/utils";

import { useAppInfo } from "./app-info";
import { ChangeDot, InfoBox, RowSwitch, SettingsGroup, Tag, UnitInput } from "./controls";
import {
  type EngineCount,
  type EngineDraft,
  engineDiff,
  engineDraft,
  type EngineField,
  type EngineSwitch,
  pendingChanges,
  revertPatch,
} from "./engine-form";
import { createSettingsForm, SettingsPage, WithSettings } from "./form";
import { askRestart } from "./restart";

/** The machine the daemon runs on (`GET /app/system`), read every half minute. */
export function useSystemInfo() {
  return createQuery(() => ({
    queryKey: keys.system(),
    queryFn: () => unwrap(api.GET("/api/v1/app/system")),
    refetchInterval: 30_000,
  }));
}

const onOff = (b: boolean) => (b ? "on" : "off");

interface Row {
  label: string;
  description: string;
  tag?: string;
}

const COUNTS: Record<EngineCount, Row & { unit: string }> = {
  hash_threads: {
    label: "Hashing threads",
    unit: "threads",
    description:
      "SHA-1 workers for checking and verifying pieces. More than half your CPU threads rarely helps; the disk usually bounds it.",
  },
  max_checking: {
    label: "Torrents checked at once",
    unit: "torrents",
    description:
      "Rechecks and new additions with existing data. Each one streams a whole torrent from disk.",
  },
  max_open_files: {
    label: "Content files kept open",
    unit: "files",
    description:
      "A cache of file handles, reopened on demand. Raise it for torrents with thousands of small files; stay under the process limit above.",
  },
  max_concurrent_announces: {
    label: "Tracker requests in flight",
    unit: "requests",
    description:
      "Announces and scrapes running at the same time. Spreads the start-up burst when you have hundreds of torrents.",
  },
};

const SWITCHES: Record<EngineSwitch, Row> = {
  disk_thread: {
    label: "Disk I/O on its own thread",
    tag: "io_uring",
    description:
      "Keeps peer traffic responsive during heavy checking or moving. Off keeps disk work on the network ring and saves the hops between threads.",
  },
  piece_extent_affinity: {
    label: "Piece extent affinity",
    description:
      "Prefer finishing 4 MiB extents already started: larger sequential writes, kinder to spinning disks and SMR.",
  },
  zero_copy_send: {
    label: "Zero-copy sends",
    description:
      "Piece payloads go to the socket without a copy through user space, where the kernel can. Off by default: it measured within noise, for a little more system time.",
  },
};

/** One tuning setting: its label, what it runs with now, and what is saved. */
function EngineRow(props: {
  id: string;
  row: Row;
  running: string;
  changed: boolean;
  pending: boolean;
  error?: string;
  note?: string;
  children: JSX.Element;
}) {
  return (
    <div class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-b border-accent px-4 py-3 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_110px_170px]">
      <div class="col-span-2 flex min-w-0 flex-col gap-0.5 sm:col-span-1">
        <span class="flex flex-wrap items-center gap-x-2 gap-y-1">
          <label for={props.id} class="flex items-center text-base font-medium">
            {props.row.label}
            <Show when={props.changed}>
              <ChangeDot />
            </Show>
          </label>
          <Show when={props.row.tag}>
            <Tag>{props.row.tag}</Tag>
          </Show>
          <Show when={props.pending}>
            <Tag tone="warn" title="Saved; the engine runs the old value until it restarts">
              after restart
            </Tag>
          </Show>
        </span>
        <span class="text-sm text-subtle">{props.row.description}</span>
        <Show when={props.note}>
          <span class="text-sm text-warn">{props.note}</span>
        </Show>
        <Show when={props.error}>
          <span class="text-sm text-danger" role="alert">
            {props.error}
          </span>
        </Show>
      </div>
      <span class="mono text-sm text-subtle sm:text-right">
        <span class="sm:sr-only">Running: </span>
        {props.running}
      </span>
      <div class="flex justify-end sm:justify-start">{props.children}</div>
    </div>
  );
}

function Machine(props: { running: Schemas["RestartSettings"] | undefined }) {
  const sys = useSystemInfo();
  const s = () => sys.data;
  return (
    <section aria-label="The machine" class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <InfoBox
        label="CPU"
        value={s() ? `${s()?.cpus} CPU threads` : dash}
        note={s()?.cpu_model ?? "model not known"}
        title={s()?.cpu_model ?? undefined}
      />
      <InfoBox
        label="Kernel"
        value={s()?.kernel ?? dash}
        title={s()?.kernel}
        note={
          s()?.memory != null
            ? `io_uring · ${formatBytes(s()?.memory ?? 0)} memory`
            : "io_uring · memory not known"
        }
      />
      <InfoBox
        label="Open-file limit"
        value={
          s()
            ? s()?.open_files_limit === null
              ? "no limit"
              : `${formatCount(s()?.open_files_limit ?? 0)} (ulimit -n)`
            : dash
        }
        note={
          <>
            {props.running ? `${formatCount(props.running.max_open_files)} kept open` : ""}
            {s()?.open_files != null ? ` · ${formatCount(s()?.open_files ?? 0)} in use` : ""}
          </>
        }
      />
      <Show
        when={s()?.save_path_fs}
        fallback={<InfoBox label="Content on" value={dash} note="the save path cannot be read" />}
      >
        {(fs) => (
          <InfoBox
            label="Content on"
            value={`${fs().mount_point ?? fs().path}${fs().fs_type ? ` · ${fs().fs_type}` : ""}`}
            title={fs().path}
            note={`${formatBytes(fs().total)} · ${formatBytes(fs().free)} free`}
          />
        )}
      </Show>
    </section>
  );
}

function EngineForm(props: { saved: Schemas["Settings"] }) {
  const app = useAppInfo();
  const sys = useSystemInfo();
  const client = useQueryClient();
  const form = createSettingsForm<EngineDraft, EngineField>(
    () => props.saved,
    engineDraft,
    engineDiff,
  );
  const { draft, changed, error, set } = form;
  const running = () => app.data?.running;
  const pending = createMemo(() => {
    const a = app.data;
    return a ? pendingChanges(props.saved, a.running, a.restart_required) : [];
  });
  const isPending = (f: EngineField) => pending().some((p) => p.setting === f);

  const revert = async () => {
    const r = running();
    if (!r) return;
    try {
      const next = await unwrap(api.PATCH("/api/v1/settings", { body: revertPatch(pending(), r) }));
      client.setQueryData(keys.settings(), next);
      await client.invalidateQueries({ queryKey: keys.app() });
      toast.success("Back to the running values");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The settings could not be saved.");
    }
  };
  const whenIdle = async (on: boolean) => {
    try {
      if (on) {
        await unwrap(api.POST("/api/v1/app/restart", { params: { query: { when: "idle" } } }));
      } else {
        await unwrap(api.DELETE("/api/v1/app/restart"));
      }
      await client.invalidateQueries({ queryKey: keys.app() });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The daemon did not answer.");
    }
  };
  const countInput = (f: EngineCount) => (
    <UnitInput
      id={`e-${f}`}
      inputMode="numeric"
      unit={COUNTS[f].unit}
      value={draft[f]}
      changed={changed(f) || isPending(f)}
      invalid={error(f) !== undefined}
      onInput={(v) => set(f, v)}
    />
  );
  const switchInput = (f: EngineSwitch) => (
    <RowSwitch id={`e-${f}`} checked={draft[f]} onChange={(v) => set(f, v)} />
  );
  const tooManyFiles = () => {
    const limit = sys.data?.open_files_limit;
    const n = Number(draft.max_open_files);
    return limit != null && Number.isFinite(n) && n > limit
      ? `More than the process may open (${formatCount(limit)}): raise its limit first.`
      : undefined;
  };

  return (
    <SettingsPage
      title="Engine"
      description="Tuning for the torrent engine. Everything here is read once, at start: saved values sit beside the running ones until you restart."
      form={form}
    >
      <Machine running={running()} />

      <Show when={pending().length > 0}>
        <section
          aria-label="Waiting for a restart"
          class="flex flex-wrap items-center gap-3 rounded-tile border border-warn/35 bg-card px-4 py-3"
        >
          <StatusDot class="bg-warn" />
          <div class="flex min-w-[240px] flex-1 flex-col gap-0.5">
            <span class="font-medium">Saved, waiting for a restart</span>
            <span class="text-sm text-subtle">
              <Show when={app.data?.restart_required_since}>
                {(t) => <>Changed {formatDateTime(t())} · </>}
              </Show>
              <For each={pending()}>
                {(p, i) => (
                  <>
                    {i() > 0 ? " · " : ""}
                    <span class="mono">{p.setting}</span> {p.running} → {p.saved}
                  </>
                )}
              </For>
              . The daemon keeps running on the old values until then.
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={() => void revert()}>
            Revert to running
          </Button>
          <Button size="sm" onClick={() => askRestart()}>
            Restart now
          </Button>
        </section>
      </Show>

      <section aria-label="Tuning" class="flex flex-col gap-2.5">
        <div
          aria-hidden="true"
          class="hidden grid-cols-[minmax(0,1fr)_110px_170px] gap-x-4 px-4 text-sm text-subtle sm:grid"
        >
          <span>Setting</span>
          <span class="text-right">Running</span>
          <span>Saved</span>
        </div>
        <div class="flex flex-col rounded-tile border border-divider bg-card">
          <EngineRow
            id="e-hash_threads"
            row={COUNTS.hash_threads}
            running={running() ? String(running()?.hash_threads) : dash}
            changed={changed("hash_threads")}
            pending={isPending("hash_threads")}
            error={error("hash_threads")}
          >
            {countInput("hash_threads")}
          </EngineRow>
          <EngineRow
            id="e-disk_thread-input"
            row={SWITCHES.disk_thread}
            running={running() ? onOff(running()?.disk_thread ?? false) : dash}
            changed={changed("disk_thread")}
            pending={isPending("disk_thread")}
          >
            {switchInput("disk_thread")}
          </EngineRow>
          <EngineRow
            id="e-max_checking"
            row={COUNTS.max_checking}
            running={running() ? String(running()?.max_checking) : dash}
            changed={changed("max_checking")}
            pending={isPending("max_checking")}
            error={error("max_checking")}
          >
            {countInput("max_checking")}
          </EngineRow>
          <EngineRow
            id="e-max_open_files"
            row={COUNTS.max_open_files}
            running={running() ? String(running()?.max_open_files) : dash}
            changed={changed("max_open_files")}
            pending={isPending("max_open_files")}
            error={error("max_open_files")}
            note={tooManyFiles()}
          >
            {countInput("max_open_files")}
          </EngineRow>
          <EngineRow
            id="e-max_concurrent_announces"
            row={COUNTS.max_concurrent_announces}
            running={running() ? String(running()?.max_concurrent_announces) : dash}
            changed={changed("max_concurrent_announces")}
            pending={isPending("max_concurrent_announces")}
            error={error("max_concurrent_announces")}
          >
            {countInput("max_concurrent_announces")}
          </EngineRow>
          <EngineRow
            id="e-piece_extent_affinity-input"
            row={SWITCHES.piece_extent_affinity}
            running={running() ? onOff(running()?.piece_extent_affinity ?? false) : dash}
            changed={changed("piece_extent_affinity")}
            pending={isPending("piece_extent_affinity")}
          >
            {switchInput("piece_extent_affinity")}
          </EngineRow>
          <EngineRow
            id="e-zero_copy_send-input"
            row={SWITCHES.zero_copy_send}
            running={running() ? onOff(running()?.zero_copy_send ?? false) : dash}
            changed={changed("zero_copy_send")}
            pending={isPending("zero_copy_send")}
          >
            {switchInput("zero_copy_send")}
          </EngineRow>
        </div>
      </section>

      <SettingsGroup title="Restarting">
        <div class="flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-2 border-b border-accent px-4 py-3">
          <div class="flex min-w-[240px] flex-1 basis-0 flex-col gap-0.5">
            <span class="text-base font-medium">Graceful restart</span>
            <span class="text-sm text-subtle">
              Trackers are told and resume data is saved, then urtorrentd starts again in its own
              process: no service manager needed. Torrents pause for a few seconds, and everyone
              signs in again.
            </span>
          </div>
          <Button variant="outline" onClick={() => askRestart()}>
            Shut down and restart
          </Button>
        </div>
        <div class="flex min-h-14 flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-3">
          <div class="flex min-w-[240px] flex-1 basis-0 flex-col gap-0.5">
            <span class="text-base font-medium">Or wait for a quiet moment</span>
            <span
              class={cn("text-sm", app.data?.restart_waiting ? "text-warn" : "text-subtle")}
              role={app.data?.restart_waiting ? "status" : undefined}
            >
              {app.data?.restart_waiting
                ? "Waiting: the daemon restarts as soon as no torrent is checking, moving or receiving data."
                : "Restart once no torrent is checking, moving or receiving data: for a box that is mid-download now."}
            </span>
          </div>
          <Show
            when={app.data?.restart_waiting}
            fallback={
              <Button variant="outline" onClick={() => void whenIdle(true)}>
                Restart when idle
              </Button>
            }
          >
            <Button variant="outline" onClick={() => void whenIdle(false)}>
              Call off
            </Button>
          </Show>
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}

export default function Engine() {
  return <WithSettings title="Engine">{(saved) => <EngineForm saved={saved()} />}</WithSettings>;
}
