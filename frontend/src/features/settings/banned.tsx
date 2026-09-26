// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Banned addresses, as the design has it: the list in the
// settings (`banned_ips`, `banned_ip_ranges`) with what it covers, a field
// that bans one or more at once, and the peer log (`GET /log/peers`) of
// every ban and unban, the engine's included, with bans per day. Bans and
// unbans apply at once: each is one `PATCH /settings` over the lists as
// the daemon has them.

import { A } from "@solidjs/router";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { Button } from "~/components/ui/button";
import { formatCount, formatDateTime } from "~/lib/format";
import { cn } from "~/lib/utils";

import { banKind, bansPerDay, coverage, parseBans } from "./bans";
import { Segmented } from "./controls";
import { WithSettings } from "./form";
import { SettingsFrame } from "./frame";

type Filter = "all" | "single" | "blocks";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "single", label: "Addresses" },
  { value: "blocks", label: "Blocks & ranges" },
];

/** Peer-log entries shown at first, and more with each "Show older". */
const LOG_ROWS = 7;
const LOG_MORE = 20;

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

function Kpi(props: { value: JSX.Element; label: string }) {
  return (
    <div class="flex flex-col gap-0.5 rounded-lg border border-divider bg-card px-3.5 py-3">
      <span class="text-xl font-semibold tracking-[-0.02em]">{props.value}</span>
      <span class="text-xs text-subtle">{props.label}</span>
    </div>
  );
}

function Tag(props: { children: JSX.Element }) {
  return (
    <span class="inline-flex h-[18px] items-center rounded border border-border px-1.5 mono text-2xs text-muted-foreground">
      {props.children}
    </span>
  );
}

function BannedPage(props: { saved: Schemas["Settings"] }) {
  const client = useQueryClient();
  const [text, setText] = createSignal("");
  const [problem, setProblem] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [filter, setFilter] = createSignal<Filter>("all");
  const [shown, setShown] = createSignal(LOG_ROWS);
  const log = createQuery(() => ({
    queryKey: keys.peerLog(),
    queryFn: () => unwrap(api.GET("/api/v1/log/peers")),
    refetchInterval: 10_000,
  }));

  const ips = () => props.saved.banned_ips;
  const ranges = () => props.saved.banned_ip_ranges;
  const entries = createMemo(() => [
    ...ips().map((a) => ({ addr: a, kind: banKind(a) })),
    ...ranges().map((a) => ({ addr: a, kind: banKind(a) })),
  ]);
  const listed = () =>
    entries().filter(
      (e) => filter() === "all" || (filter() === "single") === (e.kind === "single"),
    );
  const covered = createMemo(() => coverage(ips(), ranges()));
  const newestFirst = createMemo(() => [...(log.data ?? [])].reverse());
  const engineBans = () => (log.data ?? []).filter((e) => e.banned && e.source === "engine");
  const days = createMemo(() => bansPerDay(log.data ?? [], new Date()));
  const byYou = () => days().reduce((n, d) => n + d.settings, 0);
  const byEngine = () => days().reduce((n, d) => n + d.engine, 0);
  const tallest = () => Math.max(1, ...days().map((d) => d.engine + d.settings));

  /** Change the lists as the daemon has them now, not as this page last saw them. */
  const change = async (
    edit: (s: Schemas["Settings"]) => { banned_ips: string[]; banned_ip_ranges: string[] },
    done: string,
  ) => {
    setBusy(true);
    try {
      const now = await unwrap(api.GET("/api/v1/settings"));
      const next = await unwrap(api.PATCH("/api/v1/settings", { body: edit(now) }));
      client.setQueryData(keys.settings(), next);
      void client.invalidateQueries({ queryKey: keys.peerLog() });
      toast.success(done);
      return true;
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The list could not be changed.");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const ban = async () => {
    const parsed = parseBans(text());
    if (parsed.bad.length > 0) {
      setProblem(`Not an address, block or range: ${parsed.bad.join(", ")}`);
      return;
    }
    const n = parsed.ips.length + parsed.ranges.length;
    if (n === 0) return;
    const ok = await change(
      (s) => ({
        banned_ips: [...s.banned_ips, ...parsed.ips.filter((ip) => !s.banned_ips.includes(ip))],
        banned_ip_ranges: [
          ...s.banned_ip_ranges,
          ...parsed.ranges.filter((r) => !s.banned_ip_ranges.includes(r)),
        ],
      }),
      n === 1 ? "Banned" : `${formatCount(n)} banned`,
    );
    if (ok) setText("");
  };
  const unban = (addr: string) =>
    void change(
      (s) => ({
        banned_ips: s.banned_ips.filter((a) => a !== addr),
        banned_ip_ranges: s.banned_ip_ranges.filter((a) => a !== addr),
      }),
      `${addr} unbanned`,
    );
  const banEverywhere = (ip: string) =>
    void change(
      (s) => ({
        banned_ips: s.banned_ips.includes(ip) ? s.banned_ips : [...s.banned_ips, ip],
        banned_ip_ranges: s.banned_ip_ranges,
      }),
      `${ip} banned on every torrent`,
    );

  return (
    <SettingsFrame
      title="Banned addresses"
      description="Peers never connected to, on any torrent. Bans you add here last until you lift them; the engine's own last as long as their torrent runs."
      saved
    >
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Kpi value={formatCount(entries().length)} label="entries in your list" />
        <Kpi
          value={compact.format(covered().v4)}
          label={
            covered().v6Entries > 0
              ? `IPv4 addresses covered, and ${formatCount(covered().v6Entries)} IPv6 ${covered().v6Entries === 1 ? "entry" : "entries"}`
              : "IPv4 addresses covered"
          }
        />
        <Kpi value={formatCount(engineBans().length)} label="engine bans in the peer log" />
      </div>

      <section
        aria-label="Ban addresses"
        class="flex flex-col gap-2.5 rounded-tile border border-divider bg-card px-4 py-3.5"
      >
        <form
          class="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void ban();
          }}
        >
          <div
            class={cn(
              "flex h-8 min-w-0 flex-1 items-center overflow-hidden rounded-md border bg-background focus-within:shadow-focus",
              problem() ? "border-danger" : "border-border focus-within:border-ring",
            )}
          >
            <input
              aria-label="Addresses to ban"
              class="h-full w-full min-w-0 bg-transparent px-2.5 mono text-sm text-foreground outline-none placeholder:text-subtle"
              placeholder="203.0.113.7 · 10.0.0.0/8 · fd00::/8 · 1.2.3.0-1.2.4.255, one or more"
              value={text()}
              spellcheck={false}
              aria-invalid={problem() ? "true" : undefined}
              onInput={(e) => {
                setText(e.currentTarget.value);
                setProblem(null);
              }}
            />
          </div>
          <Button type="submit" size="sm" class="h-8" disabled={busy() || text().trim() === ""}>
            Ban
          </Button>
        </form>
        <Show when={problem()}>
          <p class="m-0 text-sm text-danger" role="alert">
            {problem()}
          </p>
        </Show>
        <p class="m-0 text-sm text-subtle">
          Single addresses go to <span class="mono">banned_ips</span>, blocks and ranges to{" "}
          <span class="mono">banned_ip_ranges</span>. A port is ignored. Peers already connected
          from them are dropped at once.
        </p>
      </section>

      <section aria-label="Your list" class="flex flex-col gap-2.5">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h2 class="m-0 text-md font-semibold">Your list</h2>
          <Segmented label="Show" options={FILTERS} value={filter()} onChange={setFilter} />
        </div>
        <div class="flex flex-col rounded-tile border border-divider bg-card">
          <Show
            when={listed().length > 0}
            fallback={
              <p class="m-0 px-4 py-3 text-sm text-subtle">
                {entries().length === 0 ? "Nobody is banned." : "Nothing of this kind."}
              </p>
            }
          >
            <table class="w-full table-fixed border-collapse text-sm">
              <colgroup>
                <col />
                <col class="w-[82px]" />
                <col class="w-[92px]" />
              </colgroup>
              <thead>
                <tr class="h-7 border-b border-accent text-xs text-subtle">
                  <th class="pl-4 text-left font-normal">Address</th>
                  <th class="px-1.5 text-left font-normal">Kind</th>
                  <th class="pr-4">
                    <span class="sr-only">Unban</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                <For each={listed()}>
                  {(e) => (
                    <tr class="h-10 border-b border-accent last:border-b-0">
                      <td class="truncate pl-4 mono">{e.addr}</td>
                      <td class="px-1.5">
                        <Tag>{e.kind}</Tag>
                      </td>
                      <td class="pr-4 text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          class="text-muted-foreground"
                          aria-label={`Unban ${e.addr}`}
                          disabled={busy()}
                          onClick={() => unban(e.addr)}
                        >
                          Unban
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

      <section aria-label="Peer log" class="flex flex-col gap-2.5">
        <div class="flex flex-wrap items-baseline justify-between gap-x-4">
          <h2 class="m-0 text-md font-semibold">Peer log</h2>
          <span class="text-sm text-subtle">
            Every ban and unban, the engine's included · <span class="mono">GET /log/peers</span>
          </span>
        </div>
        <div class="flex flex-col rounded-tile border border-divider bg-card">
          <div class="flex flex-col gap-2 border-b border-accent px-4 pt-3.5 pb-2.5">
            <div class="flex flex-wrap items-center justify-between gap-x-4 text-sm text-subtle">
              <span>Bans per day, last 30 days (since the daemon started)</span>
              <span>
                <span class="mono">{formatCount(byEngine())}</span> by the engine ·{" "}
                <span class="mono">{formatCount(byYou())}</span> by you
              </span>
            </div>
            <svg
              viewBox="0 0 728 48"
              class="block h-12 w-full"
              preserveAspectRatio="none"
              role="img"
              aria-label={`${formatCount(byEngine() + byYou())} ${byEngine() + byYou() === 1 ? "ban" : "bans"} in the last 30 days`}
            >
              <line x1="0" x2="728" y1="40" y2="40" class="stroke-border" />
              <For each={days()}>
                {(d, i) => {
                  const n = d.engine + d.settings;
                  const h = n === 0 ? 1 : Math.max(3, (n / tallest()) * 36);
                  return (
                    <rect
                      x={i() * 24.4}
                      y={40 - h}
                      width="20"
                      height={h}
                      rx="2"
                      class={n === 0 ? "fill-divider" : "fill-danger"}
                    />
                  );
                }}
              </For>
            </svg>
            <div class="flex justify-between mono text-2xs text-subtle" aria-hidden="true">
              <span>
                {days()[0]?.day.toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </span>
              <span>today</span>
            </div>
          </div>
          <Show
            when={newestFirst().length > 0}
            fallback={
              <p class="m-0 px-4 py-3 text-sm text-subtle">No ban since the daemon started.</p>
            }
          >
            <ul class="m-0 list-none p-0">
              <For each={newestFirst().slice(0, shown())}>
                {(e) => {
                  const listedNow = () => ips().includes(e.ip);
                  return (
                    <li class="grid h-9 grid-cols-[104px_18px_minmax(0,1fr)_120px] items-center gap-2.5 border-b border-accent px-4 text-sm last:border-b-0">
                      <span class="mono text-subtle">{formatDateTime(e.time)}</span>
                      <span
                        class={cn(
                          "inline-flex size-[18px] items-center justify-center rounded-full mono text-xs font-bold text-background",
                          e.banned ? "bg-danger" : "bg-faint",
                        )}
                        aria-label={`${e.banned ? "banned" : "unbanned"} by ${e.source === "engine" ? "the engine" : "the settings"}`}
                        role="img"
                      >
                        {e.banned ? "×" : "−"}
                      </span>
                      <span class="truncate">
                        <span class="mono">{e.ip}</span>{" "}
                        <span class="text-subtle">— {e.reason}</span>
                      </span>
                      <span class="text-right">
                        <Show
                          when={listedNow()}
                          fallback={
                            <Show when={e.banned && e.source === "engine"}>
                              <Button
                                variant="ghost"
                                size="sm"
                                class="text-muted-foreground"
                                disabled={busy()}
                                aria-label={`Ban ${e.ip} on every torrent`}
                                onClick={() => banEverywhere(e.ip)}
                              >
                                Ban everywhere
                              </Button>
                            </Show>
                          }
                        >
                          <Button
                            variant="ghost"
                            size="sm"
                            class="text-muted-foreground"
                            disabled={busy()}
                            aria-label={`Unban ${e.ip}`}
                            onClick={() => unban(e.ip)}
                          >
                            Unban
                          </Button>
                        </Show>
                      </span>
                    </li>
                  );
                }}
              </For>
            </ul>
            <Show when={newestFirst().length > shown()}>
              <div class="flex justify-center border-t border-accent p-2">
                <Button variant="outline" size="sm" onClick={() => setShown((n) => n + LOG_MORE)}>
                  Show older
                </Button>
              </div>
            </Show>
          </Show>
        </div>
      </section>

      <p class="m-0 text-sm text-subtle">
        Bans for failed API logins are separate: see{" "}
        <A href="/settings/security" class="text-muted-foreground underline">
          Security & API
        </A>
        .
      </p>
    </SettingsFrame>
  );
}

export default function Banned() {
  return (
    <WithSettings title="Banned addresses">
      {(saved) => <BannedPage saved={saved()} />}
    </WithSettings>
  );
}
