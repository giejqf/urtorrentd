// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › About, as the design has it: the daemon (versions, uptime,
// diagnostics to copy, the API reference), this instance (its name, where
// it keeps things, where it listens and how it is seen, GeoIP, statistics,
// the fetched trackers), what waits for a restart, and the danger zone:
// shutting down, deleting every statistic. The name is a draft saved with
// `PATCH /settings`; the rest happens at once.

import { A } from "@solidjs/router";
import { useQueryClient } from "@tanstack/solid-query";
import { createMemo, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { LogoMark } from "~/components/logo";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { useAuth } from "~/features/auth/auth";
import { useLive } from "~/features/shell/live";
import { dash, formatAgo, formatBytes, formatDateTime, formatShortDate } from "~/lib/format";
import { cn } from "~/lib/utils";

import { diagnostics, uptime } from "./about-view";
import { useAppInfo, useStatsInfo, useSystemInfo } from "./app-info";
import { GeoCredit } from "./geoip";
import { SettingRow, SettingsGroup, Tag, UnitInput } from "./controls";
import { pendingChanges } from "./engine-form";
import { createSettingsForm, type FormDiff, SettingsPage, WithSettings } from "./form";

interface AboutDraft {
  instance_name: string;
}

function aboutDiff(saved: Schemas["Settings"], d: AboutDraft): FormDiff<"instance_name"> {
  const name = d.instance_name.trim() === "" ? null : d.instance_name.trim();
  const changed = new Set<"instance_name">();
  const errors: Partial<Record<"instance_name", string>> = {};
  if ([...(name ?? "")].length > 64) {
    errors.instance_name = "At most 64 characters.";
    changed.add("instance_name");
  } else if (name !== saved.instance_name) changed.add("instance_name");
  return {
    patch: changed.has("instance_name") && !errors.instance_name ? { instance_name: name } : {},
    changed,
    names: changed.has("instance_name") && !errors.instance_name ? ["instance_name"] : [],
    errors,
  };
}

/** A fact of this instance: a label and a value. */
function Fact(props: { label: string; children: JSX.Element; title?: string }) {
  return (
    <div class="grid min-h-9 grid-cols-1 items-center gap-x-4 border-b border-accent px-4 py-1.5 text-sm last:border-b-0 sm:grid-cols-[170px_minmax(0,1fr)] sm:py-0">
      <span class="text-subtle">{props.label}</span>
      <span class="flex min-w-0 items-center gap-1.5 mono" title={props.title}>
        {props.children}
      </span>
    </div>
  );
}

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function AboutForm(props: { saved: Schemas["Settings"] }) {
  const app = useAppInfo();
  const sys = useSystemInfo();
  const stats = useStatsInfo();
  const live = useLive();
  const auth = useAuth();
  const client = useQueryClient();
  const [asking, setAsking] = createSignal<"shutdown" | "stats" | null>(null);
  // Uptime and "ago" tick every half minute.
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));
  const clock = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
  onCleanup(() => clearInterval(clock));
  const form = createSettingsForm<AboutDraft, "instance_name">(
    () => props.saved,
    (s) => ({ instance_name: s.instance_name ?? "" }),
    aboutDiff,
  );
  const pending = createMemo(() => {
    const a = app.data;
    return a ? pendingChanges(props.saved, a.running, a.restart_required) : [];
  });
  const transfer = () => live.state.transfer;

  const copyDiagnostics = async () => {
    const a = app.data;
    if (!a) return;
    const states: Partial<Record<Schemas["TorrentState"], number>> = {};
    for (const t of live.torrents()) {
      states[t.state] = (states[t.state] ?? 0) + 1;
    }
    const text = diagnostics({
      app: a,
      system: sys.data ?? null,
      settings: props.saved,
      stats: stats.data ?? null,
      transfer: transfer() ?? null,
      states,
      pending: pending(),
      ui: __UI_VERSION__,
      browser: navigator.userAgent,
      now: now(),
    });
    try {
      await navigator.clipboard.writeText(text);
      toast.success("Diagnostics copied: no addresses, paths, URLs or names");
    } catch {
      toast.error("The browser did not allow copying.");
    }
  };
  const shutdown = async () => {
    setAsking(null);
    try {
      await unwrap(api.POST("/api/v1/app/shutdown"));
      auth.stopped();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The daemon did not stop.");
    }
  };
  const deleteStats = async () => {
    setAsking(null);
    try {
      await unwrap(api.DELETE("/api/v1/stats"));
      toast.success("Every statistic is deleted");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The statistics could not be deleted.");
    }
    await client.invalidateQueries({ queryKey: keys.stats() });
  };

  const geo = () => {
    const g = app.data?.geoip;
    const dbs = [g?.country, g?.asn].filter((d) => d !== null && d !== undefined);
    if (dbs.length === 0) return null;
    const built = dbs.map((d) => d.built).find((b) => b !== null) ?? null;
    return {
      names: dbs.map((d) => d.database_type ?? "not loaded").join(" · "),
      built,
    };
  };

  return (
    <SettingsPage title="About" description="" form={form}>
      <section
        aria-label="urtorrentd"
        class="flex flex-wrap items-center gap-5 rounded-tile border border-divider bg-card p-5"
      >
        <LogoMark class="size-14" />
        <div class="flex min-w-[240px] flex-1 flex-col gap-1">
          <div class="flex items-baseline gap-2.5">
            <span class="text-xl font-semibold tracking-[-0.01em]">urtorrentd</span>
            <span class="mono text-muted-foreground">{app.data?.version ?? ""}</span>
          </div>
          <span class="text-sm text-subtle">
            A BitTorrent daemon on the urtorrent library · {app.data?.library ?? dash} · API{" "}
            {app.data?.api_version ?? dash} · Apache-2.0
          </span>
          <Show when={app.data}>
            {(a) => (
              <span class="mono text-sm text-subtle">
                running {uptime(Math.max(now() - a().started_at, 0))} · since{" "}
                {formatDateTime(a().started_at)} · pid {a().pid}
              </span>
            )}
          </Show>
        </div>
        <div class="flex flex-col gap-1.5">
          <Button variant="outline" onClick={() => void copyDiagnostics()}>
            Copy diagnostics
          </Button>
          <Button
            as="a"
            variant="outline"
            href="/api/v1/openapi.json"
            target="_blank"
            rel="noopener noreferrer"
          >
            API reference
          </Button>
        </div>
      </section>

      <SettingsGroup title="This instance">
        <SettingRow
          label="Instance name"
          for="ab-instance_name"
          description={
            <>
              What clients show for this daemon (<span class="mono">GET /app</span>). Empty = none.
            </>
          }
          changed={form.changed("instance_name")}
          error={form.error("instance_name")}
        >
          <UnitInput
            id="ab-instance_name"
            class="w-[240px]"
            align="left"
            inputMode="text"
            placeholder="none"
            value={form.draft.instance_name}
            changed={form.changed("instance_name")}
            invalid={form.error("instance_name") !== undefined}
            onInput={(v) => form.set("instance_name", v)}
          />
        </SettingRow>
        <Fact label="Data directory" title={app.data?.data_dir}>
          <span class="truncate">{app.data?.data_dir ?? dash}</span>
        </Fact>
        <Fact label="Default save path" title={app.data?.default_save_path}>
          <span class="truncate">{app.data?.default_save_path ?? dash}</span>
        </Fact>
        <Fact label="Listening on">
          <span class="truncate">
            {(app.data?.listen_addresses ?? []).length > 0
              ? (app.data?.listen_addresses ?? [])
                  .map((a) => (a.includes(":") ? `[${a}]` : a) + `:${app.data?.listen_port ?? ""}`)
                  .join(" · ")
              : "nothing: no address is up"}
          </span>
          <Show when={props.saved.listen_interface}>{(i) => <Tag>{i()}</Tag>}</Show>
        </Fact>
        <Fact label="Seen as">
          <span class="truncate">
            {[transfer()?.external_v4, transfer()?.external_v6]
              .filter((a) => a !== null && a !== undefined)
              .join(" · ") || "not known yet"}
          </span>
        </Fact>
        <Fact label="GeoIP">
          <Show when={geo()} fallback="none">
            {(g) => (
              <>
                <span class="truncate">{g().names}</span>
                <Show when={g().built}>
                  {(b) => <span class="font-sans text-subtle">built {formatShortDate(b())}</span>}
                </Show>
                <GeoCredit class="font-sans" />
              </>
            )}
          </Show>
        </Fact>
        <Fact label="Statistics">
          <Show when={stats.data} fallback={stats.isError ? "unavailable" : dash}>
            {(s) => (
              <span class="truncate">
                {s().enabled ? "on" : "off"} · {formatBytes(s().size)}
                {s().oldest_day !== null ? ` · since ${formatShortDate(s().oldest_day)}` : ""}
              </span>
            )}
          </Show>
        </Fact>
        <Fact label="Fetched trackers">
          <Show when={app.data?.fetched_trackers} fallback="none: no list set">
            {(t) => (
              <>
                <span class="truncate">
                  {t().trackers.length} from {host(t().url)}
                </span>
                <span class="font-sans text-subtle">
                  {t().fetching
                    ? "fetching…"
                    : t().error
                      ? "the last fetch failed"
                      : t().fetched !== null
                        ? formatAgo(t().fetched, now())
                        : "not fetched yet"}
                </span>
              </>
            )}
          </Show>
        </Fact>
      </SettingsGroup>

      <Show when={pending().length > 0}>
        <SettingsGroup
          title="Waiting for a restart"
          aside={<span class="mono">GET /app · restart_required</span>}
        >
          <For each={pending()}>
            {(p) => (
              <div class="grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 border-b border-accent px-4 py-1.5 text-sm sm:grid-cols-[170px_minmax(0,1fr)_auto] sm:py-0">
                <span class="mono text-subtle">{p.setting}</span>
                <span class="mono">
                  {p.running} → {p.saved}
                </span>
                <Show when={app.data?.restart_required_since}>
                  {(t) => <Tag tone="warn">since {formatDateTime(t())}</Tag>}
                </Show>
              </div>
            )}
          </For>
          <div class="flex min-h-12 flex-wrap items-center justify-between gap-3 px-4 py-2">
            <span class="text-sm text-subtle">They apply when the daemon starts again.</span>
            <Button as={A} href="/settings/engine" variant="outline" size="sm">
              Open Engine
            </Button>
          </div>
        </SettingsGroup>
      </Show>

      <section aria-label="Danger zone" class="flex flex-col gap-2.5">
        <h2 class="m-0 text-md font-semibold text-danger">Danger zone</h2>
        <div class="flex flex-col rounded-tile border border-danger/30 bg-card">
          <SettingRow
            label="Shut down the daemon"
            description="Graceful: trackers are told, resume data and state are saved, then the process exits. Whether it comes back is up to your service manager."
          >
            <Button
              variant="outline"
              class="border-danger/35 text-danger"
              onClick={() => setAsking("shutdown")}
            >
              Shut down
            </Button>
          </SettingRow>
          <SettingRow
            label="Delete all statistics"
            description="Traffic history, seeding days and the timeline of every torrent, removed ones included. Settings are untouched, and recording goes on."
          >
            <Button
              variant="outline"
              class="border-danger/35 text-danger"
              disabled={stats.data === undefined}
              onClick={() => setAsking("stats")}
            >
              Delete statistics
            </Button>
          </SettingRow>
        </div>
      </section>

      <p class={cn("m-0 flex flex-wrap gap-x-4 text-sm text-subtle")}>
        <span>urtorrentd contributors</span>
        <span aria-hidden="true">·</span>
        <span>Apache-2.0</span>
        <span aria-hidden="true">·</span>
        <span>Web UI {__UI_VERSION__}</span>
      </p>

      <AlertDialog open={asking() !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {asking() === "shutdown" ? "Shut down the daemon?" : "Delete all statistics?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {asking() === "shutdown"
                ? "Every torrent stops until urtorrentd is started again on the machine it runs on. This page cannot start it."
                : "Every torrent's traffic, days and timeline go for good, removed torrents' too. Recording goes on from now."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose as={Button} variant="outline" aria-label="Cancel">
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => void (asking() === "shutdown" ? shutdown() : deleteStats())}
            >
              {asking() === "shutdown" ? "Shut down" : "Delete statistics"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPage>
  );
}

export default function About() {
  return <WithSettings title="About">{(saved) => <AboutForm saved={saved()} />}</WithSettings>;
}
