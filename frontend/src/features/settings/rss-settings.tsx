// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › RSS, as the design has it: how feeds are polled (the `rss_*`
// settings, a draft saved with one `PATCH /settings`) with the next hour of
// refreshes they make, whether download rules run, each rule switched on or
// off at once, and each feed refreshed on demand. The feeds and rules
// themselves are edited on the RSS screen. Feed URLs carry passkeys: only
// hosts are shown (AGENTS.md rule 6).

import { A } from "@solidjs/router";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { StatusDot } from "~/components/status-dot";
import { Button } from "~/components/ui/button";
import { Switch, SwitchControl, SwitchLabel } from "~/components/ui/switch";
import { formatAgo, formatCount } from "~/lib/format";
import { cn } from "~/lib/utils";

import { RowSwitch, SettingRow, SettingsGroup, UnitInput } from "./controls";
import { createSettingsForm, SettingsPage, WithSettings } from "./form";
import {
  intervalSeconds,
  refreshesWithin,
  requestsPerDay,
  type RssDraft,
  rssDiff,
  rssDraft,
  type RssField,
  ruleFilter,
  ruleWith,
} from "./rss-view";

type Feed = Schemas["RssFeed"];
type Rule = Schemas["RssRule"];

const FEEDS = ["rss", "feeds"] as const;
const RULES = ["rss", "rules"] as const;
/** Lanes drawn in the next hour's chart at most. */
const LANES = 10;
const HOUR = 3600;

function host(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

const feedName = (f: Feed) => f.name ?? f.title ?? host(f.url);

function Kpi(props: { value: string; label: string }) {
  return (
    <div class="flex flex-col gap-0.5 rounded-lg border border-divider bg-card px-3.5 py-3">
      <span class="text-xl font-semibold tracking-[-0.02em]">{props.value}</span>
      <span class="text-xs text-subtle">{props.label}</span>
    </div>
  );
}

/** The next hour of refreshes, one lane per feed. */
function NextHour(props: { feeds: Feed[]; every: number; enabled: boolean; now: number }) {
  const X0 = 136;
  const W = 592;
  const x = (t: number) => X0 + ((t - props.now) / HOUR) * W;
  const lanes = () => props.feeds.slice(0, LANES);
  const clock = (t: number) =>
    new Date(t * 1000).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  const height = () => 16 + lanes().length * 16;
  return (
    <section
      aria-label="The next hour of polling"
      class="flex flex-col gap-2 border-t border-accent px-4 pt-3.5 pb-4"
    >
      <div class="flex flex-wrap items-center justify-between gap-x-4 text-sm text-subtle">
        <span>
          The next hour of polling: one tick per refresh; feeds with their own interval lighter
        </span>
        <span class="mono">now {clock(props.now)}</span>
      </div>
      <Show
        when={props.enabled}
        fallback={
          <p class="m-0 text-sm text-subtle">
            Off: feeds refresh only when you ask, and rules run on what arrives.
          </p>
        }
      >
        <Show
          when={lanes().length > 0}
          fallback={<p class="m-0 text-sm text-subtle">No feed yet.</p>}
        >
          <svg
            viewBox={`0 0 728 ${height()}`}
            class="block w-full overflow-visible"
            style={{ height: `${height()}px` }}
            role="img"
            aria-label={`${formatCount(
              lanes().reduce(
                (n, f) => n + refreshesWithin(f, props.every, props.now, HOUR).length,
                0,
              ),
            )} refreshes in the next hour`}
          >
            <For each={[0, 15, 30, 45, 60]}>
              {(m) => (
                <g>
                  <line
                    x1={X0 + (m / 60) * W}
                    x2={X0 + (m / 60) * W}
                    y1="12"
                    y2={height()}
                    class="stroke-divider"
                  />
                  <text
                    x={X0 + (m / 60) * W}
                    y="8"
                    text-anchor="middle"
                    class="fill-subtle mono text-[9px]"
                  >
                    {m === 0 ? clock(props.now) : m === 60 ? clock(props.now + HOUR) : `+${m} min`}
                  </text>
                </g>
              )}
            </For>
            <For each={lanes()}>
              {(f, i) => (
                <g>
                  <text x="0" y={24 + i() * 16} class="fill-muted-foreground text-[11px]">
                    {feedName(f).length > 18 ? `${feedName(f).slice(0, 17)}…` : feedName(f)}
                  </text>
                  <For each={refreshesWithin(f, props.every, props.now, HOUR)}>
                    {(t) => (
                      <rect
                        x={x(t)}
                        y={16 + i() * 16}
                        width="3"
                        height="10"
                        rx="1"
                        class={
                          f.error !== null
                            ? "fill-danger"
                            : f.refresh_interval !== null
                              ? "fill-brand/60"
                              : "fill-brand"
                        }
                      />
                    )}
                  </For>
                </g>
              )}
            </For>
          </svg>
          <Show when={props.feeds.length > LANES}>
            <p class="m-0 text-sm text-subtle">
              {formatCount(props.feeds.length - LANES)} more feeds not drawn.
            </p>
          </Show>
        </Show>
      </Show>
    </section>
  );
}

function RssForm(props: { saved: Schemas["Settings"] }) {
  const client = useQueryClient();
  const form = createSettingsForm<RssDraft, RssField>(() => props.saved, rssDraft, rssDiff);
  const { draft, changed, error, set } = form;
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));
  const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 30_000);
  onCleanup(() => clearInterval(timer));
  // Followed every second while a refresh runs or was just asked for.
  const [asked, setAsked] = createSignal(0);
  const feeds = createQuery(() => ({
    queryKey: FEEDS,
    queryFn: () => unwrap(api.GET("/api/v1/rss/feeds")),
    refetchInterval: (q) =>
      q.state.data?.some((f) => f.loading) || Date.now() - asked() < 10_000 ? 1000 : 15_000,
  }));
  const rules = createQuery(() => ({
    queryKey: RULES,
    queryFn: () => unwrap(api.GET("/api/v1/rss/rules")),
  }));
  const feedList = createMemo(() => feeds.data ?? []);
  const ruleList = createMemo(() => rules.data ?? []);
  /** The draft's interval where valid, else the saved one. */
  const every = () =>
    intervalSeconds(draft.rss_refresh_interval) ?? props.saved.rss_refresh_interval;
  const failing = () => feedList().filter((f) => f.error !== null).length;
  const recentRules = () =>
    ruleList().filter((r) => r.last_match !== null && r.last_match >= now() - 30 * 86_400).length;
  const feedNames = (ids: number[]) =>
    ids.length === 0
      ? "no feed"
      : ids
          .map((id) => {
            const f = feedList().find((x) => x.id === id);
            return f ? feedName(f) : `feed ${id}`;
          })
          .join(", ");

  const switchRule = async (r: Rule, enabled: boolean) => {
    try {
      await unwrap(
        api.PUT("/api/v1/rss/rules/{name}", {
          params: { path: { name: r.name } },
          body: ruleWith(r, enabled),
        }),
      );
      void client.invalidateQueries({ queryKey: RULES });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The rule could not be switched.");
    }
  };
  const refresh = async (f: Feed) => {
    try {
      await unwrap(api.POST("/api/v1/rss/feeds/{id}/refresh", { params: { path: { id: f.id } } }));
      setAsked(Date.now());
      void client.invalidateQueries({ queryKey: FEEDS });
      toast.success(`Refreshing ${feedName(f)}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The feed could not be refreshed.");
    }
  };

  const flagRow = (
    field: "rss_enabled" | "rss_auto_download" | "rss_download_repacks",
    label: string,
    description: string,
  ) => (
    <SettingRow
      label={label}
      for={`r-${field}-input`}
      description={description}
      changed={changed(field)}
    >
      <RowSwitch id={`r-${field}`} checked={draft[field]} onChange={(v) => set(field, v)} />
    </SettingRow>
  );
  const numberRow = (
    field: "rss_refresh_interval" | "rss_fetch_delay" | "rss_max_articles",
    label: string,
    unit: string,
    description: string,
  ) => (
    <SettingRow
      label={label}
      for={`r-${field}`}
      description={description}
      changed={changed(field)}
      error={error(field)}
    >
      <UnitInput
        id={`r-${field}`}
        value={draft[field]}
        onInput={(v) => set(field, v)}
        unit={unit}
        inputMode="decimal"
        changed={changed(field)}
        invalid={error(field) !== undefined}
      />
    </SettingRow>
  );

  return (
    <SettingsPage
      title="RSS"
      description="How feeds are polled and how download rules run. The feeds and rules themselves live under RSS in the sidebar."
      form={form}
      action={
        <Button as={A} href="/rss" variant="outline">
          Open RSS
        </Button>
      }
    >
      <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi
          value={formatCount(feedList().length)}
          label={failing() > 0 ? `feeds · ${formatCount(failing())} failing` : "feeds"}
        />
        <Kpi
          value={formatCount(ruleList().length)}
          label={`download rules · ${formatCount(ruleList().filter((r) => r.enabled).length)} on`}
        />
        <Kpi
          value={draft.rss_enabled ? formatCount(requestsPerDay(feedList(), every())) : "0"}
          label="requests a day at this pace"
        />
        <Kpi value={formatCount(recentRules())} label="rules that took something, 30 days" />
      </div>

      <SettingsGroup title="Polling">
        {flagRow(
          "rss_enabled",
          "Refresh feeds automatically",
          "Off, feeds refresh only when you ask. Rules still run on whatever arrives.",
        )}
        {numberRow(
          "rss_refresh_interval",
          "Refresh interval",
          "min",
          "For feeds without their own interval. At least 1 minute.",
        )}
        {numberRow(
          "rss_fetch_delay",
          "Delay between requests to one host",
          "s",
          "Keeps a tracker that serves several of your feeds from rate-limiting you. At most 3600 s.",
        )}
        {numberRow(
          "rss_max_articles",
          "Articles kept per feed",
          "articles",
          "The newest. 1 to 5000.",
        )}
        <NextHour feeds={feedList()} every={every()} enabled={draft.rss_enabled} now={now()} />
      </SettingsGroup>

      <SettingsGroup title="Download rules">
        {flagRow(
          "rss_auto_download",
          "Run rules on new articles",
          "Each rule adds what its filters match, with its own add options.",
        )}
        {flagRow(
          "rss_download_repacks",
          "Take REPACK / PROPER releases again",
          "A smart filter that already took an episode takes its repack once more.",
        )}
        <section aria-label="Rules" class="flex flex-col border-t border-accent">
          <Show
            when={ruleList().length > 0}
            fallback={<p class="m-0 px-4 py-3 text-sm text-subtle">No rule yet.</p>}
          >
            <table class="w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col class="w-[52px]" />
                <col />
                <col class="w-[150px]" />
                <col class="w-[110px]" />
              </colgroup>
              <thead>
                <tr class="h-7 border-b border-accent text-xs text-subtle">
                  <th>
                    <span class="sr-only">On</span>
                  </th>
                  <th class="px-1.5 text-left font-normal">Rule</th>
                  <th class="px-1.5 text-left font-normal">Feeds</th>
                  <th class="pr-4 text-right font-normal">Last match</th>
                </tr>
              </thead>
              <tbody>
                <For each={ruleList()}>
                  {(r) => (
                    <tr class="h-11 border-b border-accent last:border-b-0">
                      <td class="pl-4">
                        <Switch
                          class="flex items-center"
                          checked={r.enabled}
                          onChange={(v) => void switchRule(r, v)}
                        >
                          <SwitchLabel class="sr-only">{r.name} on</SwitchLabel>
                          <SwitchControl />
                        </Switch>
                      </td>
                      <td class="px-1.5">
                        <span class="flex min-w-0 flex-col gap-0.5">
                          <span
                            class={cn(
                              "truncate font-medium",
                              !r.enabled && "text-muted-foreground",
                            )}
                          >
                            {r.name}
                          </span>
                          <span class="truncate mono text-xs text-subtle">{ruleFilter(r)}</span>
                        </span>
                      </td>
                      <td class="truncate px-1.5 text-subtle">{feedNames(r.feeds)}</td>
                      <td class="pr-4 text-right mono text-muted-foreground">
                        {r.last_match === null ? "never" : formatAgo(r.last_match, now())}
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </section>
      </SettingsGroup>

      <section aria-label="Feeds" class="flex flex-col gap-2.5">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4">
          <h2 class="m-0 text-md font-semibold">Feeds</h2>
          <span class="text-sm text-subtle">
            A feed's own interval wins over the global one ·{" "}
            <span class="mono">GET /rss/feeds</span>
          </span>
        </div>
        <div class="flex flex-col rounded-tile border border-divider bg-card">
          <Show
            when={feedList().length > 0}
            fallback={<p class="m-0 px-4 py-3 text-sm text-subtle">No feed yet.</p>}
          >
            <table class="w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col class="w-[28px]" />
                <col />
                <col class="w-[128px]" />
                <col class="w-[112px]" />
                <col class="w-[68px]" />
                <col class="w-[84px]" />
              </colgroup>
              <thead>
                <tr class="h-7 border-b border-accent text-xs text-subtle">
                  <th>
                    <span class="sr-only">Standing</span>
                  </th>
                  <th class="px-1.5 text-left font-normal">Feed</th>
                  <th class="px-1.5 text-left font-normal">Interval</th>
                  <th class="px-1.5 text-left font-normal">Last refresh</th>
                  <th class="px-1.5 text-right font-normal">Articles</th>
                  <th>
                    <span class="sr-only">Refresh</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={feedList()}>
                  {(f) => (
                    <tr class="h-10 border-b border-accent last:border-b-0">
                      <td class="pl-4">
                        <StatusDot
                          class={
                            f.error !== null
                              ? "bg-danger"
                              : f.last_refresh === null
                                ? "bg-faint"
                                : "bg-ok"
                          }
                        />
                      </td>
                      <td class="px-1.5">
                        <span class="flex min-w-0 flex-col gap-px">
                          <span class="truncate font-medium">{feedName(f)}</span>
                          <span class="truncate text-xs text-subtle">
                            {[f.folder, host(f.url), f.error].filter((x) => x !== null).join(" · ")}
                          </span>
                        </span>
                      </td>
                      <td
                        class={cn(
                          "px-1.5 mono whitespace-nowrap",
                          f.refresh_interval === null && "text-subtle",
                        )}
                      >
                        {Math.round((f.refresh_interval ?? every()) / 60)} min
                        {f.refresh_interval === null ? " (global)" : ""}
                      </td>
                      <td class="px-1.5 mono text-subtle">
                        {f.loading
                          ? "refreshing…"
                          : f.last_refresh === null
                            ? "never"
                            : `${f.error !== null ? "failed " : ""}${formatAgo(f.last_refresh, now())}`}
                      </td>
                      <td class="px-1.5 text-right mono text-muted-foreground">
                        {formatCount(f.articles)}
                      </td>
                      <td class="pr-2 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          class="text-muted-foreground"
                          disabled={f.loading}
                          aria-label={`Refresh ${feedName(f)}`}
                          onClick={() => void refresh(f)}
                        >
                          Refresh
                        </Button>
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </div>
      </section>
    </SettingsPage>
  );
}

export default function RssSettings() {
  return <WithSettings title="RSS">{(saved) => <RssForm saved={saved()} />}</WithSettings>;
}
