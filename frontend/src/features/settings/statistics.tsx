// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Statistics & GeoIP, as the design has it: what the statistics
// database holds (`GET /stats`), recording and how long each resolution is
// kept, with what is on disk against where the draft cuts it, the opt-in
// scrape, the history of removed torrents, and the GeoIP files with how
// much peer traffic they located. Edits are a draft saved with one
// `PATCH /settings`; deleting history happens at once.

import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { FolderPicker } from "~/components/folder-picker";
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
import {
  dash,
  formatBytes,
  formatDate,
  formatDateTime,
  formatPercent,
  formatShortDate,
} from "~/lib/format";
import { cn } from "~/lib/utils";

import { useAppInfo } from "./app-info";
import { InfoBox, RowSwitch, SettingRow, SettingsGroup, Tag, UnitInput } from "./controls";
import { createSettingsForm, SettingsPage, WithSettings } from "./form";
import {
  axis,
  locatedShare,
  parseDays,
  RETENTIONS,
  type StatsDraft,
  statsDiff,
  statsDraft,
  type StatsField,
  tierLabel,
  tiers,
} from "./statistics-form";

/** `GET /stats`: what the statistics database holds (503 while it cannot be opened). */
export function useStatsInfo() {
  return createQuery(() => ({
    queryKey: keys.stats(),
    queryFn: () => unwrap(api.GET("/api/v1/stats")),
    refetchInterval: 60_000,
    retry: false,
  }));
}

function Kpi(props: { value: JSX.Element; unit?: string; label: JSX.Element }) {
  return (
    <div class="flex min-w-0 flex-col gap-0.5 rounded-lg border border-divider bg-card px-3.5 py-3">
      <span class="text-xl font-semibold tracking-[-0.02em]">
        {props.value}
        <Show when={props.unit}>
          <span class="ml-1 text-sm font-medium text-muted-foreground">{props.unit}</span>
        </Show>
      </span>
      <span class="text-xs text-subtle">{props.label}</span>
    </div>
  );
}

/** `38.4 MB` as a value and its unit. */
function splitBytes(n: number): [string, string] {
  const [v, u] = formatBytes(n).split(" ");
  return [v ?? "", u ?? ""];
}

const TIER_FILL = ["fill-brand", "fill-brand/60", "fill-ok"];
const X0 = 120;
const X1 = 728;

function RetentionChart(props: {
  info: Schemas["StatsInfo"];
  keep: Record<(typeof RETENTIONS)[number], number | null>;
}) {
  const now = Math.floor(Date.now() / 1000);
  const shown = createMemo(() => tiers(props.info, props.keep, now));
  const ax = createMemo(() => axis(shown(), X0, X1));
  const label = () =>
    `On disk now, and where retention cuts it: ${shown()
      .map((t) => `${t.name.toLowerCase()}: ${tierLabel(t)}`)
      .join("; ")}`;
  return (
    <svg
      viewBox="0 0 728 112"
      class="block h-auto w-full overflow-visible"
      role="img"
      aria-label={label()}
    >
      <g class="fill-faint mono" font-size="9">
        <For each={ax().ticks}>
          {(t) => (
            <g>
              <line
                x1={ax().x(t.days)}
                x2={ax().x(t.days)}
                y1="14"
                y2="100"
                class="stroke-divider"
              />
              <text x={ax().x(t.days)} y="10" text-anchor="middle">
                {t.label}
              </text>
            </g>
          )}
        </For>
        <text x={X1} y="110" text-anchor="end">
          now
        </text>
      </g>
      <For each={shown()}>
        {(t, i) => {
          const y = () => 20 + i() * 28;
          const x0 = () => (t.have === null ? X1 : ax().x(t.have));
          return (
            <g>
              <text x="0" y={y() + 10} font-size="11" class="fill-foreground-2">
                {t.name}
              </text>
              <rect
                x={Math.min(x0(), t.have === null ? X1 : X1 - 3)}
                y={y()}
                width={Math.max(X1 - x0(), t.have === null ? 0 : 3)}
                height="12"
                rx="3"
                class={TIER_FILL[i()]}
              />
              <Show when={t.keep !== null}>
                <line
                  x1={ax().x(t.keep ?? 0)}
                  x2={ax().x(t.keep ?? 0)}
                  y1={y() - 3}
                  y2={y() + 15}
                  class="stroke-warn"
                  stroke-width="2"
                />
              </Show>
              <text x={X0} y={y() + 23} font-size="9" class="fill-subtle mono">
                {tierLabel(t)}
              </text>
            </g>
          );
        }}
      </For>
    </svg>
  );
}

function GeoBox(props: { kind: string; db: Schemas["GeoDatabaseInfo"] | null; note: JSX.Element }) {
  const now = Math.floor(Date.now() / 1000);
  return (
    <Show
      when={props.db}
      fallback={<InfoBox label={`${props.kind} · none`} value="no database" note={props.note} />}
    >
      {(db) => (
        <Show
          when={db().database_type !== null}
          fallback={
            <InfoBox
              tone="danger"
              label={`${props.kind} · not loaded`}
              value={db().error ?? "cannot be read"}
              title={db().error ?? undefined}
              note="Fix the file, or choose another."
            />
          }
        >
          <InfoBox
            tone="ok"
            label={
              <span class="flex w-full items-center justify-between gap-2">
                {props.kind} · loaded <Tag tone="ok">{db().database_type}</Tag>
              </span>
            }
            value={
              db().built !== null
                ? `built ${formatDate(db().built)} · ${Math.max(Math.floor((now - (db().built ?? now)) / 86_400), 0)} days old`
                : dash
            }
            note={
              <>
                re-read when the file changes · read {formatDateTime(db().loaded)}
                <Show when={db().error}>
                  <span class="block text-danger">
                    The last reload failed ({db().error}); the one read before stays.
                  </span>
                </Show>
              </>
            }
          />
        </Show>
      )}
    </Show>
  );
}

function StatisticsForm(props: { saved: Schemas["Settings"] }) {
  const client = useQueryClient();
  const app = useAppInfo();
  const info = useStatsInfo();
  const [asking, setAsking] = createSignal(false);
  const form = createSettingsForm<StatsDraft, StatsField>(() => props.saved, statsDraft, statsDiff);
  const { draft, changed, error, set } = form;
  const geoOn = () => app.data?.geoip.country?.database_type != null;
  const geo = createQuery(() => ({
    queryKey: keys.geoStats("country"),
    queryFn: () =>
      unwrap(api.GET("/api/v1/stats/geo", { params: { query: { dim: "country", limit: 250 } } })),
    enabled: info.data?.enabled === true,
    refetchInterval: 60_000,
    retry: false,
  }));
  const share = () => (geo.data ? locatedShare(geo.data.rows, "country") : null);
  /** Retention as the draft has it (what does not parse draws as saved). */
  const keep = createMemo(() => {
    const out = {} as Record<(typeof RETENTIONS)[number], number | null>;
    for (const f of RETENTIONS) {
      const v = parseDays(draft[f]);
      out[f] = v === undefined ? props.saved[f] : v;
    }
    return out;
  });
  const deleteRemoved = async () => {
    setAsking(false);
    try {
      await unwrap(api.DELETE("/api/v1/stats/removed"));
      toast.success("The history of removed torrents is deleted");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The history could not be deleted.");
    }
    await client.invalidateQueries({ queryKey: keys.stats() });
  };

  const retentionRow = (f: (typeof RETENTIONS)[number], label: string, description?: string) => (
    <SettingRow
      label={label}
      for={`st-${f}`}
      description={description}
      changed={changed(f)}
      error={error(f)}
    >
      <UnitInput
        id={`st-${f}`}
        unit="days"
        placeholder="∞"
        value={draft[f]}
        changed={changed(f)}
        invalid={error(f) !== undefined}
        onInput={(v) => set(f, v)}
      />
    </SettingRow>
  );

  const pathRow = (
    f: "geoip_database" | "geoip_asn_database",
    label: string,
    description: JSX.Element,
  ) => (
    <SettingRow
      label={label}
      for={`st-${f}`}
      description={description}
      changed={changed(f)}
      error={error(f)}
    >
      <UnitInput
        id={`st-${f}`}
        class="w-full max-w-[340px] sm:w-[320px]"
        align="left"
        inputMode="text"
        placeholder="none"
        value={draft[f]}
        changed={changed(f)}
        invalid={error(f) !== undefined}
        onInput={(v) => set(f, v)}
        trailing={
          <FolderPicker
            inline
            pickFile=".mmdb"
            what={label.toLowerCase()}
            value={draft[f]}
            onPick={(p) => set(f, p)}
          />
        }
      />
    </SettingRow>
  );

  return (
    <SettingsPage
      title="Statistics & GeoIP"
      description="What the daemon records about traffic and torrents, how long it keeps it, and the databases that put peers on the map."
      form={form}
    >
      <Show
        when={info.data}
        fallback={
          <p
            class={cn("m-0 text-sm", info.isError ? "text-danger" : "text-subtle")}
            role={info.isError ? "alert" : undefined}
          >
            {info.isError
              ? `Statistics are unavailable: ${info.error instanceof ApiError ? info.error.message : "the daemon did not answer"}.`
              : "Reading the statistics…"}
          </p>
        }
      >
        {(i) => (
          <section aria-label="What is recorded" class="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              value={splitBytes(i().size)[0]}
              unit={splitBytes(i().size)[1]}
              label="statistics database"
            />
            <Kpi
              value={String(i().torrents)}
              label={`torrents with history · ${i().removed} removed`}
            />
            <Kpi value={formatShortDate(i().oldest_day)} label="oldest day kept" />
            <Kpi
              value={share() !== null ? formatPercent(share() ?? 0) : dash}
              label={
                !geoOn()
                  ? "of peer traffic located: no GeoIP database"
                  : share() === null
                    ? "of peer traffic located: none in the last day"
                    : "of peer traffic located, last day"
              }
            />
          </section>
        )}
      </Show>

      <SettingsGroup title="Statistics">
        <SettingRow
          label="Record statistics"
          for="st-stats_enabled-input"
          description="Traffic per torrent and for the session, each torrent's seeding days, the timeline. Off: nothing new is recorded; what exists stays."
          changed={changed("stats_enabled")}
        >
          <RowSwitch
            id="st-stats_enabled"
            checked={draft.stats_enabled}
            onChange={(v) => set("stats_enabled", v)}
          />
        </SettingRow>
        {retentionRow(
          "stats_minute_retention",
          "Keep per-minute buckets for",
          "The finest resolution: what the live transfer chart reads. Empty = forever.",
        )}
        {retentionRow("stats_hour_retention", "Keep per-hour buckets for")}
        {retentionRow(
          "stats_day_retention",
          "Keep days, the timeline and recording periods for",
          "Also the history of removed torrents.",
        )}
        <Show when={info.data}>
          {(i) => (
            <div class="flex flex-col gap-2 border-b border-accent px-4 pt-3.5 pb-4">
              <div class="flex items-center justify-between gap-4">
                <span class="text-sm text-subtle">
                  What is on disk right now, by resolution, and where each retention cuts it
                </span>
                <span class="mono text-sm text-subtle">log scale</span>
              </div>
              <RetentionChart info={i()} keep={keep()} />
            </div>
          )}
        </Show>
        <SettingRow
          label="Scrape trackers for completed downloads"
          for="st-scrape-input"
          description="Adds the swarm's total completed count to each torrent's days. At least every 30 min. Off by default: announces already report seeds and leechers."
          changed={changed("scrape") || changed("stats_scrape_interval")}
          error={error("stats_scrape_interval")}
        >
          <div class="flex items-center gap-3">
            <UnitInput
              id="st-stats_scrape_interval"
              label="Scrape every"
              class="w-[130px]"
              unit="min"
              value={draft.stats_scrape_interval}
              muted={!draft.scrape}
              changed={changed("stats_scrape_interval")}
              invalid={error("stats_scrape_interval") !== undefined}
              onInput={(v) => {
                set("stats_scrape_interval", v);
                set("scrape", true);
              }}
            />
            <RowSwitch id="st-scrape" checked={draft.scrape} onChange={(v) => set("scrape", v)} />
          </div>
        </SettingRow>
        <SettingRow
          label="History of removed torrents"
          description={
            info.data
              ? info.data.removed === 0
                ? "No removed torrent has history on file."
                : `${info.data.removed} removed ${info.data.removed === 1 ? "torrent still has" : "torrents still have"} days and traffic on file, until the days' retention.`
              : "Days and traffic of torrents no longer in the session."
          }
        >
          <Button
            variant="outline"
            size="sm"
            class="text-danger"
            disabled={(info.data?.removed ?? 0) === 0}
            onClick={() => setAsking(true)}
          >
            Delete all
          </Button>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title="GeoIP"
        aside={
          <>
            MaxMind DB files. Never downloaded by the daemon: point it at files{" "}
            <span class="mono">geoipupdate</span> keeps fresh.
          </>
        }
      >
        {pathRow(
          "geoip_database",
          "Country database",
          <>
            GeoLite2-Country, DB-IP Country Lite or IPinfo Lite. Gives peers a flag and{" "}
            <span class="mono">/stats/geo</span> its countries.
          </>,
        )}
        {pathRow(
          "geoip_asn_database",
          "ASN database",
          "GeoLite2-ASN or DB-IP ASN Lite. IPinfo Lite already includes ASNs.",
        )}
        <div class="grid grid-cols-1 gap-2.5 px-4 pt-3.5 pb-4 sm:grid-cols-2">
          <GeoBox
            kind="Country"
            db={app.data?.geoip.country ?? null}
            note="Peers show no country."
          />
          <GeoBox kind="ASN" db={app.data?.geoip.asn ?? null} note="Peers show no network." />
        </div>
      </SettingsGroup>

      <AlertDialog open={asking()} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete the history of removed torrents?</AlertDialogTitle>
            <AlertDialogDescription>
              Their days, traffic and timeline go for good. Torrents still in the session keep
              theirs.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose as={Button} variant="outline" aria-label="Cancel">
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" onClick={() => void deleteRemoved()}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPage>
  );
}

export default function Statistics() {
  return (
    <WithSettings title="Statistics & GeoIP">
      {(saved) => <StatisticsForm saved={saved()} />}
    </WithSettings>
  );
}
