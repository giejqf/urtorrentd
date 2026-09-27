// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Stats › Peers & geo as designed: where the peers are, on a world map
// drawn from the daemon to each country, now (`/transfer/peers`: the peers
// of the torrents moving data, sampled every 10 s, or all of one torrent's)
// or over a range (`/stats/geo`, `/stats/peers`); the peers with their
// client, progress and connection, to ban or add; traffic by country or
// network; and how peers connect. GeoIP places peers by country and
// network only, never closer (ADR 0005).

import { useSearchParams } from "@solidjs/router";
import { useQueryClient } from "@tanstack/solid-query";
import ChevronDown from "lucide-solid/icons/chevron-down";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { PromptDialog } from "~/components/prompt-dialog";
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
import { Checkbox, CheckboxLabel } from "~/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { useAppInfo } from "~/features/settings/app-info";
import { Segmented } from "~/features/settings/controls";
import { useLive } from "~/features/shell/live";
import { PageHeader } from "~/features/shell/page-header";
import { dash, formatAgo, formatBytes, formatCount, formatPercent, formatRate } from "~/lib/format";
import { cn } from "~/lib/utils";

import { useGeo, useMinuteClock, usePeersNow, usePeerSplit } from "./data";
import { WorldMap } from "./map";
import { Card, CountryCode, Empty, PeerBadge, TorrentPicker } from "./parts";
import {
  countryFlows,
  countryName,
  type Flow,
  historyFlows,
  historySplit,
  liveConnections,
  peerFlows,
  peerIp,
  type Split,
  totals,
} from "./peers-view";
import { LIVE_PRESETS, type RangeParams, rangeOf } from "./range";

type Peer = Schemas["TorrentPeer"];

interface PeersParams extends RangeParams {
  hash?: string;
  by?: string;
  map?: string;
}

const RANGES = [{ value: "live", label: "Live" }, ...LIVE_PRESETS] as const;
const MOST_CURVES = 24;
const MOST_ROWS = 200;

export default function PeersGeo() {
  const [params, setParams] = useSearchParams<PeersParams>();
  const now = useMinuteClock();
  const live = useLive();
  const app = useAppInfo();
  const scope = () => params.hash ?? null;
  const isLive = () => !LIVE_PRESETS.some((p) => p.value === params.range);
  const range = createMemo(() => rangeOf(params, LIVE_PRESETS, "24h", now(), null));
  const span = createMemo(
    () => ({ from: range().from, to: range().to }),
    { from: 0, to: 0 },
    { equals: (a, b) => a.from === b.from && a.to === b.to },
  );
  const dim = (): Schemas["GeoDimension"] => (params.by === "asn" ? "asn" : "country");
  const byPeer = () => isLive() && params.map !== "countries";
  const peersQ = usePeersNow(scope, () => true);
  const countriesQ = useGeo(
    span,
    () => "country",
    scope,
    () => !isLive(),
  );
  const networksQ = useGeo(
    span,
    () => "asn",
    scope,
    () => !isLive() && dim() === "asn",
  );
  const history = () => !isLive();
  const splits = {
    transport: usePeerSplit(span, "transport", scope, history),
    encryption: usePeerSplit(span, "encryption", scope, history),
    direction: usePeerSplit(span, "direction", scope, history),
    source: usePeerSplit(span, "source", scope, history),
  };
  const peers = () => peersQ.data?.peers ?? [];
  const sum = createMemo(() => totals(peers()));
  const liveCountries = createMemo(() => countryFlows(peers()));
  const pastCountries = createMemo(() => historyFlows(countriesQ.data?.rows ?? []));
  const flows = createMemo<Flow[]>(() =>
    isLive() ? (byPeer() ? peerFlows(peers()) : liveCountries().flows) : pastCountries().flows,
  );
  const geoip = () => app.data?.geoip;
  const located = () => geoip()?.country?.loaded != null;
  const here = () => {
    const h = peersQ.data?.here;
    return h?.country
      ? {
          country: h.country,
          label: `${app.data?.instance_name ?? "urtorrentd"} · ${countryName(h.country)}`,
        }
      : null;
  };
  const torrentOptions = createMemo(() =>
    live
      .torrents()
      .filter((t) => t.peers > 0 || t.hash === scope())
      .sort((a, b) => b.peers - a.peers)
      .map((t) => ({
        hash: t.hash,
        name: t.name,
        meta: `${t.peers} ${t.peers === 1 ? "peer" : "peers"}`,
      })),
  );
  const connected = () => {
    const h = scope();
    return h ? (live.state.torrents[h]?.peers ?? 0) : (live.state.transfer?.peers ?? 0);
  };
  const scopeName = () => {
    const h = scope();
    return h ? (live.state.torrents[h]?.name ?? h.slice(0, 12)) : "All torrents";
  };
  const shownCurves = () => Math.min(MOST_CURVES, flows().length);
  return (
    <div class="flex min-w-0 flex-1 flex-col">
      <PageHeader
        title="Peers & geo"
        count={<span class="mono text-xs text-subtle">{formatCount(connected())} connected</span>}
      >
        <TorrentPicker
          options={torrentOptions()}
          value={scope()}
          onChange={(h) => setParams({ hash: h ?? undefined })}
        />
        <Segmented
          label="Range"
          options={RANGES}
          value={isLive() ? "live" : (range().preset ?? "24h")}
          onChange={(v) =>
            setParams({ range: v === "live" ? undefined : v, from: undefined, to: undefined })
          }
        />
        <DropdownMenu>
          <DropdownMenuTrigger as={Button} variant="outline" size="sm" aria-label="Places by">
            {dim() === "asn" ? "Network" : "Country"}
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup
              value={dim()}
              onChange={(v) => setParams({ by: v === "asn" ? "asn" : undefined })}
            >
              <DropdownMenuRadioItem closeOnSelect value="country">
                Country
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem closeOnSelect value="asn">
                Network (AS)
              </DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </PageHeader>
      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        {/* A phone leaves the map out: its overlays do not fit. */}
        <section
          aria-label="Map"
          class="relative flex min-h-[300px] flex-col justify-center overflow-hidden rounded-xl border border-divider bg-card p-4 max-sm:hidden"
        >
          <WorldMap
            label={
              isLive()
                ? `Peers now by country: ${formatRate(sum().down)} coming in, ${formatRate(sum().up)} going out`
                : `Peer traffic by country, ${range().words}`
            }
            home={here()}
            flows={flows()}
            most={MOST_CURVES}
            spread={byPeer()}
          />
          <div class="absolute top-4 left-4 flex flex-col gap-2">
            <Overlay
              head={isLive() ? "Inbound · download" : `Inbound · ${range().words}`}
              big={
                <span class="text-brand">
                  ↓{" "}
                  {isLive()
                    ? formatRate(sum().down)
                    : formatBytes(pastCountries().flows.reduce((n, f) => n + f.down, 0))}
                </span>
              }
              sub={
                isLive()
                  ? `${formatCount(sum().sending)} peers sending`
                  : `from ${pastCountries().flows.filter((f) => f.down > 0).length} countries`
              }
            />
            <Overlay
              head={isLive() ? "Outbound · upload" : `Outbound · ${range().words}`}
              big={
                <span class="text-upload">
                  ↑{" "}
                  {isLive()
                    ? formatRate(sum().up)
                    : formatBytes(pastCountries().flows.reduce((n, f) => n + f.up, 0))}
                </span>
              }
              sub={
                isLive()
                  ? `${formatCount(sum().receiving)} peers receiving`
                  : `to ${pastCountries().flows.filter((f) => f.up > 0).length} countries`
              }
            />
          </div>
          <div class="absolute top-4 right-4">
            <Overlay
              right
              head={`${scopeName()}${flows().length > 0 ? ` · top ${shownCurves()} by ${isLive() ? "rate" : "traffic"}` : ""}`}
              big={
                <>
                  {formatCount(
                    isLive()
                      ? peers().length
                      : pastCountries().flows.reduce((n, f) => n + f.peers, 0),
                  )}{" "}
                  <span class="text-xs font-normal text-muted-foreground">
                    {isLive() ? "peers" : "peers at most"} ·{" "}
                    {formatCount(isLive() ? sum().countries : pastCountries().flows.length)}{" "}
                    countries
                  </span>
                </>
              }
              sub={
                isLive()
                  ? scope()
                    ? `connected now${(isLive() ? liveCountries().unlocated : 0) > 0 ? ` · ${liveCountries().unlocated} not located` : ""}`
                    : `of ${formatCount(sum().torrents)} torrents moving data · sampled ${formatAgo(peersQ.data?.sampled ?? null, Date.now() / 1000)}`
                  : pastCountries().unlocated > 0
                    ? `${formatBytes(pastCountries().unlocated)} not located`
                    : "every peer located"
              }
            />
          </div>
          <div class="absolute bottom-4 left-4 flex flex-wrap items-center gap-3.5 rounded-lg border border-divider bg-card/90 px-3 py-1.5 text-xs text-muted-foreground">
            <span class="flex items-center gap-1.5">
              <span class="h-0.5 w-5 bg-brand" aria-hidden="true" />
              Data flowing to us
            </span>
            <span class="flex items-center gap-1.5">
              <span class="h-0.5 w-5 bg-upload" aria-hidden="true" />
              Data flowing out
            </span>
            <span>Width = {isLive() ? "current rate" : "traffic"}</span>
            <span class="text-subtle">
              {located()
                ? `${geoip()?.country?.database_type ?? "GeoIP"} · read ${formatAgo(geoip()?.country?.loaded ?? null, Date.now() / 1000)}`
                : "No GeoIP database"}
            </span>
            <Show when={located() && !here()}>
              <span class="text-subtle">· where this daemon is: not known yet</span>
            </Show>
          </div>
          <Show when={isLive()}>
            <div class="absolute right-4 bottom-4">
              <Segmented
                label="Curves"
                options={[
                  { value: "countries", label: "Countries" },
                  { value: "peers", label: "Peers" },
                ]}
                value={byPeer() ? "peers" : "countries"}
                onChange={(v) => setParams({ map: v === "peers" ? undefined : v })}
              />
            </div>
          </Show>
          <Show when={app.data && !located()}>
            <p class="absolute inset-x-0 top-1/2 m-0 -translate-y-1/2 text-center text-sm text-muted-foreground">
              Without a GeoIP database peers cannot be placed: Settings › Statistics &amp; GeoIP.
            </p>
          </Show>
        </section>
        <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_372px]">
          <Show
            when={isLive()}
            fallback={
              <PlacesTable
                rows={(dim() === "asn" ? networksQ.data?.rows : countriesQ.data?.rows) ?? []}
                dim={dim()}
                words={range().words}
              />
            }
          >
            <PeersTable peers={peers()} scope={scope()} sampled={peersQ.data?.sampled ?? null} />
          </Show>
          <div class="flex min-w-0 flex-col gap-4">
            <ByPlace
              dim={dim()}
              live={isLive()}
              peers={peers()}
              rows={(dim() === "asn" ? networksQ.data?.rows : countriesQ.data?.rows) ?? []}
            />
            <ConnectionsCard
              live={isLive()}
              count={peers().length}
              words={range().words}
              split={
                isLive()
                  ? liveConnections(peers())
                  : {
                      transport: historySplit(splits.transport.data),
                      encryption: historySplit(splits.encryption.data),
                      direction: historySplit(splits.direction.data),
                      source: historySplit(splits.source.data),
                    }
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function Overlay(props: { head: string; big: JSX.Element; sub: string; right?: boolean }) {
  return (
    <div
      class={cn(
        "flex max-w-[320px] flex-col gap-0.5 rounded-lg border border-divider bg-card/90 px-3 py-2 text-xs text-muted-foreground",
        props.right && "items-end text-right",
      )}
    >
      <span class="section-label">{props.head}</span>
      <span class="mono text-base font-semibold text-foreground">{props.big}</span>
      <span class="truncate">{props.sub}</span>
    </div>
  );
}

function PeersTable(props: {
  peers: readonly Peer[];
  scope: string | null;
  sampled: number | null;
}) {
  const live = useLive();
  const client = useQueryClient();
  const [chosen, setChosen] = createSignal<ReadonlySet<string>>(new Set());
  const [banning, setBanning] = createSignal(false);
  const [adding, setAdding] = createSignal(false);
  const sorted = createMemo(() =>
    [...props.peers].sort(
      (a, b) =>
        b.download_rate + b.upload_rate - (a.download_rate + a.upload_rate) ||
        b.downloaded + b.uploaded - (a.downloaded + a.uploaded),
    ),
  );
  const key = (p: Peer) => `${p.hash}-${p.address}`;
  // Rows by key: a poll brings new objects, and a row stays the same element.
  const byKey = createMemo(() => new Map(sorted().map((p) => [key(p), p])));
  const toBan = () => [
    ...new Set(props.peers.filter((p) => chosen().has(key(p))).map((p) => peerIp(p.address))),
  ];
  const ban = async () => {
    try {
      await unwrap(api.POST("/api/v1/transfer/bans", { body: { peers: toBan() } }));
      toast.success(`Banned ${toBan().length} ${toBan().length === 1 ? "address" : "addresses"}`);
      setChosen(new Set<string>());
      void client.invalidateQueries({
        queryKey: keys.statsReport("peers-now", { hash: props.scope ?? "" }),
      });
    } catch (e) {
      toast.error(`Ban: ${e instanceof ApiError ? e.message : "failed"}`);
    }
    setBanning(false);
  };
  const add = async (text: string) => {
    const hash = props.scope;
    const addresses = text.split(/[\s,]+/).filter((x) => x !== "");
    if (!hash || addresses.length === 0) return;
    try {
      await unwrap(
        api.POST("/api/v1/torrents/peers", { body: { hashes: [hash], peers: addresses } }),
      );
      toast.success(
        `Asked to connect to ${addresses.length} ${addresses.length === 1 ? "peer" : "peers"}`,
      );
    } catch (e) {
      toast.error(`Add peers: ${e instanceof ApiError ? e.message : "failed"}`);
    }
  };
  const cols = "grid-cols-[16px_24px_minmax(0,1.1fr)_minmax(0,1.2fr)_64px_72px_68px_68px_104px]";
  return (
    <section
      aria-label="Connected peers"
      class="flex min-w-0 flex-col overflow-hidden rounded-xl border border-divider bg-card"
    >
      <div class="flex h-10 flex-none items-center gap-2.5 border-b border-divider px-3.5">
        <h2 class="m-0 text-base font-semibold">Connected peers</h2>
        <span class="mono text-xs text-subtle">
          sorted by rate
          {props.scope ? "" : " · torrents moving data"}
        </span>
        <span class="flex-1" />
        <Show when={props.scope}>
          <Button
            variant="outline"
            size="sm"
            class="h-6 px-2 text-xs"
            onClick={() => setAdding(true)}
          >
            Add peers
          </Button>
        </Show>
        <Button
          variant="outline"
          size="sm"
          class="h-6 px-2 text-xs"
          disabled={toBan().length === 0}
          onClick={() => setBanning(true)}
        >
          Ban selected
        </Button>
      </div>
      <div class="overflow-x-auto">
        <div class="min-w-[740px]">
          <div
            class={cn(
              "grid h-7 items-center gap-2.5 border-b border-divider px-3.5 text-[11px] font-medium text-subtle",
              cols,
            )}
          >
            <span />
            <span />
            <span>Address</span>
            <span>Client</span>
            <span class="text-right">Have</span>
            <span>Conn</span>
            <span class="text-right">Down</span>
            <span class="text-right">Up</span>
            <span class="text-right">Total ↓ / ↑</span>
          </div>
          <Show
            when={sorted().length > 0}
            fallback={
              <Empty>
                {props.sampled === null
                  ? "The first sample of peers comes within 10 seconds."
                  : props.scope
                    ? "No peer is connected to this torrent."
                    : "No torrent is moving data: its peers show here when one does."}
              </Empty>
            }
          >
            <ul class="m-0 max-h-[520px] list-none overflow-auto p-0" aria-label="Peers">
              <For each={sorted().slice(0, MOST_ROWS).map(key)}>
                {(k) => (
                  <Show when={byKey().get(k)}>
                    {(peer) => {
                      const p = peer;
                      return (
                        <li
                          class={cn(
                            "grid min-h-[34px] items-center gap-2.5 border-b border-row-divider px-3.5 py-1 text-sm",
                            cols,
                          )}
                        >
                          <Checkbox
                            checked={chosen().has(key(p()))}
                            onChange={(on) => {
                              const next = new Set(chosen());
                              if (on) next.add(key(p()));
                              else next.delete(key(p()));
                              setChosen(next);
                            }}
                          >
                            <CheckboxLabel class="sr-only">Select {p().address}</CheckboxLabel>
                          </Checkbox>
                          <CountryCode code={p().country} />
                          <span class="flex min-w-0 flex-col leading-tight">
                            <span class="truncate mono">{p().address}</span>
                            <span class="truncate text-[10px] text-subtle">
                              {countryName(p().country)}
                              {p().as_org ? ` · ${p().as_org}` : ""}
                            </span>
                          </span>
                          <span class="truncate">
                            {p().client ?? "unknown client"}
                            <span class="text-xs text-muted-foreground">
                              {" "}
                              · {live.state.torrents[p().hash]?.name ?? p().hash.slice(0, 12)}
                            </span>
                          </span>
                          <span class="flex items-center justify-end gap-1.5">
                            <span class="block h-1 w-7 overflow-hidden rounded-full bg-border">
                              <span
                                class={cn(
                                  "block h-full",
                                  p().is_seed ? "bg-ok" : "bg-muted-foreground",
                                )}
                                style={{ width: `${p().progress * 100}%` }}
                              />
                            </span>
                            <span class="mono text-xs text-muted-foreground">
                              {formatPercent(p().progress)}
                            </span>
                          </span>
                          <span class="flex gap-[3px]">
                            <PeerBadge on title={p().transport === "utp" ? "µTP" : "TCP"}>
                              {p().transport === "utp" ? "µTP" : "TCP"}
                            </PeerBadge>
                            <PeerBadge
                              on={p().encrypted}
                              title={p().encrypted ? "Encrypted" : "Not encrypted"}
                            >
                              E
                            </PeerBadge>
                            <PeerBadge
                              on={p().incoming}
                              title={p().incoming ? "They connected to us" : "We connected to them"}
                            >
                              IN
                            </PeerBadge>
                          </span>
                          <span
                            class={cn(
                              "text-right mono",
                              p().download_rate > 0 ? "text-brand" : "text-faint",
                            )}
                          >
                            {p().download_rate > 0 ? formatRate(p().download_rate) : dash}
                          </span>
                          <span
                            class={cn(
                              "text-right mono",
                              p().upload_rate > 0 ? "text-upload" : "text-faint",
                            )}
                          >
                            {p().upload_rate > 0 ? formatRate(p().upload_rate) : dash}
                          </span>
                          <span class="text-right mono text-xs text-muted-foreground">
                            {formatBytes(p().downloaded)} / {formatBytes(p().uploaded)}
                          </span>
                        </li>
                      );
                    }}
                  </Show>
                )}
              </For>
            </ul>
            <Show when={sorted().length > MOST_ROWS}>
              <p class="m-0 px-3.5 py-2 text-xs text-subtle">
                The {MOST_ROWS} fastest of {formatCount(sorted().length)}.
              </p>
            </Show>
          </Show>
        </div>
      </div>
      <AlertDialog open={banning()} onOpenChange={(o) => !o && setBanning(false)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Ban {toBan().length} {toBan().length === 1 ? "address" : "addresses"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              Their connections close and they cannot connect again: {toBan().join(", ")}. Bans are
              kept in Settings › Banned addresses.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose as={Button} variant="outline">
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" onClick={() => void ban()}>
              Ban
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <PromptDialog
        open={adding()}
        title="Add peers"
        label="Addresses (ip:port, several apart by spaces)"
        action="Add"
        onClose={() => setAdding(false)}
        onSubmit={(v) => void add(v)}
      />
    </section>
  );
}

function PlacesTable(props: {
  rows: readonly Schemas["GeoRow"][];
  dim: Schemas["GeoDimension"];
  words: string;
}) {
  const total = () => props.rows.reduce((n, r) => n + r.downloaded + r.uploaded, 0);
  const name = (r: Schemas["GeoRow"]) =>
    props.dim === "asn"
      ? r.asn === null
        ? "Not located"
        : `AS${r.asn}${r.as_org ? ` · ${r.as_org}` : ""}`
      : countryName(r.country);
  return (
    <Card
      title={props.dim === "asn" ? "Networks" : "Countries"}
      sub={`Peer traffic, ${props.words}`}
      flush
    >
      <Show
        when={props.rows.length > 0}
        fallback={<Empty>No peer traffic was recorded in this range.</Empty>}
      >
        <table class="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr class="h-7 border-y border-divider text-left text-[11px] font-medium text-subtle">
              <th class="pl-4 font-medium">{props.dim === "asn" ? "Network" : "Country"}</th>
              <th class="w-[90px] text-right font-medium">Peers at most</th>
              <th class="w-[96px] text-right font-medium">Down</th>
              <th class="w-[96px] text-right font-medium">Up</th>
              <th class="w-[80px] pr-4 text-right font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            <For each={props.rows}>
              {(r) => (
                <tr class="h-9 border-b border-row-divider">
                  <td class="truncate pl-4">
                    <span class="flex items-center gap-2">
                      <Show when={props.dim === "country"}>
                        <CountryCode code={r.country} />
                      </Show>
                      <span class="truncate">{name(r)}</span>
                    </span>
                  </td>
                  <td class="text-right mono text-muted-foreground">{formatCount(r.peers_max)}</td>
                  <td class="text-right mono text-brand">{formatBytes(r.downloaded)}</td>
                  <td class="text-right mono text-upload">{formatBytes(r.uploaded)}</td>
                  <td class="pr-4 text-right mono text-muted-foreground">
                    {total() > 0 ? formatPercent((r.downloaded + r.uploaded) / total()) : dash}
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </Card>
  );
}

function ByPlace(props: {
  dim: Schemas["GeoDimension"];
  live: boolean;
  peers: readonly Peer[];
  rows: readonly Schemas["GeoRow"][];
}) {
  const lines = createMemo(() => {
    if (!props.live) {
      const rows = [...props.rows].sort(
        (a, b) => b.downloaded + b.uploaded - (a.downloaded + a.uploaded),
      );
      return rows.slice(0, 7).map((r) => ({
        key: `${r.country}-${r.asn}`,
        code: r.country,
        name:
          props.dim === "asn"
            ? r.asn === null
              ? "Not located"
              : (r.as_org ?? `AS${r.asn}`)
            : countryName(r.country),
        down: r.downloaded,
        up: r.uploaded,
      }));
    }
    const by = new Map<
      string,
      { key: string; code: string | null; name: string; down: number; up: number }
    >();
    for (const p of props.peers) {
      const k = props.dim === "asn" ? String(p.asn ?? "") : (p.country ?? "");
      const l = by.get(k) ?? {
        key: k,
        code: p.country,
        name:
          props.dim === "asn"
            ? p.asn === null
              ? "Not located"
              : (p.as_org ?? `AS${p.asn}`)
            : countryName(p.country),
        down: 0,
        up: 0,
      };
      l.down += p.download_rate;
      l.up += p.upload_rate;
      by.set(k, l);
    }
    return [...by.values()].sort((a, b) => b.down + b.up - (a.down + a.up)).slice(0, 7);
  });
  const most = () => Math.max(1, ...lines().map((l) => l.down + l.up));
  const fmt = (v: number) => (props.live ? formatRate(v) : formatBytes(v));
  return (
    <Card
      title={props.dim === "asn" ? "By network" : "By country"}
      actions={<span class="mono text-xs text-subtle">{props.live ? "rate now" : "traffic"}</span>}
    >
      <Show
        when={lines().length > 0}
        fallback={<p class="m-0 text-sm text-subtle">No peer traffic.</p>}
      >
        <ul class="m-0 flex list-none flex-col gap-1 p-0">
          <For each={lines()}>
            {(l) => (
              <li
                class="grid h-7 grid-cols-[26px_minmax(0,1fr)_96px_92px] items-center gap-2.5 text-sm"
                title={`${l.name}: ↓ ${fmt(l.down)} · ↑ ${fmt(l.up)}`}
              >
                <CountryCode code={props.dim === "asn" ? null : l.code} />
                <span class="truncate">{l.name}</span>
                <span class="flex h-2 gap-0.5 overflow-hidden rounded-xs bg-accent">
                  <span class="h-full bg-brand" style={{ width: `${(l.down / most()) * 100}%` }} />
                  <span class="h-full bg-upload" style={{ width: `${(l.up / most()) * 100}%` }} />
                </span>
                <span class="text-right mono text-xs text-muted-foreground">
                  {fmt(l.down + l.up)}
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
    </Card>
  );
}

function ConnectionsCard(props: {
  live: boolean;
  count: number;
  words: string;
  split: { transport: Split[]; encryption: Split[]; direction: Split[]; source: Split[] };
}) {
  const row = (label: string, parts: Split[], colors: [string, string]) => (
    <div class="flex flex-col gap-1">
      <div class="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span class="mono">
          {parts.length === 0
            ? dash
            : parts
                .filter((p) => p.share > 0)
                .map((p) => `${formatPercent(p.share)} ${p.label}`)
                .join(" · ")}
        </span>
      </div>
      <div class="flex h-2 gap-0.5 overflow-hidden rounded-xs bg-accent">
        <For each={parts.slice(0, 2)}>
          {(p, i) => (
            <span
              class={cn("h-full", colors[i()] ?? "bg-border")}
              style={{ width: `${p.share * 100}%` }}
            />
          )}
        </For>
      </div>
    </div>
  );
  return (
    <Card
      title="Connections"
      actions={
        <span class="mono text-xs text-subtle">
          {props.live ? `${formatCount(props.count)} peers` : `share of traffic, ${props.words}`}
        </span>
      }
    >
      <div class="flex flex-col gap-2">
        {row("Transport", props.split.transport, ["bg-muted-foreground", "bg-border-strong"])}
        {row("Encryption", props.split.encryption, ["bg-ok", "bg-border-strong"])}
        {row("Direction", props.split.direction, ["bg-cat-2", "bg-border-strong"])}
        <div class="flex justify-between gap-2 border-t border-divider pt-1.5 text-xs text-muted-foreground">
          <span>Found via</span>
          <span class="truncate mono">
            {props.split.source.length === 0
              ? dash
              : props.split.source
                  .slice(0, 4)
                  .map((s) => `${s.label} ${formatPercent(s.share)}`)
                  .join(" · ")}
          </span>
        </div>
      </div>
    </Card>
  );
}
