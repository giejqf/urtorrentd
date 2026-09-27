// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Peers tab: the torrent's connected peers, fastest first, with where
// they are (GeoIP), their client and how they are connected, what flows
// each way and how much of the torrent they have; a peer's address to copy
// or ban (every torrent, after a question); peers to add by hand; the swarm
// as the trackers report it.

import { A } from "@solidjs/router";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
import Ellipsis from "lucide-solid/icons/ellipsis";
import { createMemo, createSignal, For, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { ConfirmDialog } from "~/components/confirm-dialog";
import { PromptDialog } from "~/components/prompt-dialog";
import { StatusDot } from "~/components/status-dot";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { CountryCode, PeerBadge } from "~/features/stats/parts";
import { peerIp } from "~/features/stats/peers-view";
import { dash, formatCount, formatDuration, formatPercent, formatRate } from "~/lib/format";
import { cn } from "~/lib/utils";

import { copy } from "../actions";
import { TabHeading } from "./parts";

type TorrentSummary = Schemas["TorrentSummary"];
type Peer = Schemas["PeerInfo"];

/** Rows drawn at most; the slowest of a larger swarm are counted, not listed. */
const MOST = 200;

function Count(props: { tone: string; children: string }) {
  return (
    <Badge variant="pill" class="h-5 text-xs">
      <StatusDot class={props.tone} />
      {props.children}
    </Badge>
  );
}

function Rate(props: { value: number; tone: string }) {
  return (
    <span
      class={cn(
        "text-right mono text-xs leading-tight",
        props.value > 0 ? props.tone : "text-faint",
      )}
    >
      {props.value > 0 ? formatRate(props.value) : dash}
    </span>
  );
}

export function PeersTab(props: { torrent: TorrentSummary }) {
  const hash = () => props.torrent.hash;
  const peers = createQuery(() => ({
    queryKey: keys.torrentPart(hash(), "peers"),
    queryFn: () =>
      unwrap(api.GET("/api/v1/torrents/{hash}/peers", { params: { path: { hash: hash() } } })),
    refetchInterval: 2_000,
  }));
  // Peers known beyond those connected (waiting to be dialled).
  const detail = createQuery(() => ({
    queryKey: keys.torrentPart(hash(), "detail"),
    queryFn: () =>
      unwrap(api.GET("/api/v1/torrents/{hash}", { params: { path: { hash: hash() } } })),
    refetchInterval: 5_000,
  }));
  const [adding, setAdding] = createSignal(false);
  const client = useQueryClient();
  const all = () => peers.data ?? [];
  const sorted = createMemo(() =>
    [...all()].sort(
      (a, b) =>
        b.download_rate + b.upload_rate - (a.download_rate + a.upload_rate) ||
        b.progress - a.progress ||
        a.address.localeCompare(b.address),
    ),
  );
  // Rows by address: a poll brings new objects, and a row stays the same element.
  const byAddress = createMemo(() => new Map(sorted().map((p) => [p.address, p])));
  const count = (f: (p: Peer) => boolean) => all().filter(f).length;
  const summary = () => {
    const n = all().length;
    const known = detail.data?.known_peers;
    const parts = [`${formatCount(n)} connected`];
    if (known !== undefined && known > n) parts.push(`${formatCount(known)} known`);
    parts.push(n > MOST ? `the ${MOST} fastest shown` : "fastest first");
    return parts.join(" · ");
  };
  const swarm = () => {
    const t = props.torrent;
    if (t.swarm_seeds === null && t.swarm_leechers === null) return "swarm not reported";
    return `swarm ${formatCount(t.swarm_seeds ?? 0)} seeds · ${formatCount(t.swarm_leechers ?? 0)} leechers`;
  };
  const add = async (text: string) => {
    const addresses = text.split(/[\s,]+/).filter((x) => x !== "");
    if (addresses.length === 0) return;
    try {
      await unwrap(
        api.POST("/api/v1/torrents/peers", { body: { hashes: [hash()], peers: addresses } }),
      );
      toast.success(
        `Asked to connect to ${addresses.length} ${addresses.length === 1 ? "peer" : "peers"}`,
      );
    } catch (e) {
      toast.error(`Add peers: ${e instanceof ApiError ? e.message : "failed"}`);
    }
  };
  const [banning, setBanning] = createSignal<string | null>(null);
  const ban = async (ip: string) => {
    try {
      await unwrap(api.POST("/api/v1/transfer/bans", { body: { peers: [ip] } }));
      toast.success(`Banned ${ip}`);
      void client.invalidateQueries({ queryKey: keys.torrentPart(hash(), "peers") });
    } catch (e) {
      toast.error(`Ban: ${e instanceof ApiError ? e.message : "failed"}`);
    }
  };
  const cols = "grid-cols-[26px_minmax(0,1fr)_58px_58px_44px_24px]";

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2.5 px-4 pt-3 pb-4">
      <TabHeading torrent={props.torrent} />
      <div class="flex flex-none items-center gap-1.5 pt-1">
        <span class="flex-1 truncate mono text-xs text-subtle">{summary()}</span>
        <Button variant="outline" size="xs" onClick={() => setAdding(true)}>
          Add peers
        </Button>
        <Button as={A} href={`/stats/peers?hash=${hash()}`} variant="outline" size="xs">
          Map
        </Button>
      </div>
      <div class="flex flex-none flex-wrap gap-1.5">
        <Count tone="bg-brand">{`${formatCount(count((p) => p.download_rate > 0))} sending`}</Count>
        <Count tone="bg-upload">{`${formatCount(count((p) => p.upload_rate > 0))} receiving`}</Count>
        <Count tone="bg-ok">{`${formatCount(count((p) => p.encrypted))} encrypted`}</Count>
      </div>
      <div class="flex min-h-0 flex-1 flex-col overflow-auto border-t border-divider">
        <div
          class={cn(
            "sticky top-0 z-10 grid h-[26px] flex-none items-center gap-2 bg-card text-xs text-subtle",
            cols,
          )}
          aria-hidden="true"
        >
          <span />
          <span>Peer · client</span>
          <span class="text-right">Down</span>
          <span class="text-right">Up</span>
          <span class="text-right">Have</span>
          <span />
        </div>
        <Show
          when={sorted().length > 0}
          fallback={
            <p class="m-0 py-6 text-center text-sm text-subtle">
              <Show when={!peers.isPending} fallback="Reading the peers…">
                {peers.isError ? "The peers could not be read." : "No peer is connected."}
              </Show>
            </p>
          }
        >
          <ul class="m-0 list-none p-0" aria-label="Peers">
            <For
              each={sorted()
                .slice(0, MOST)
                .map((p) => p.address)}
            >
              {(address) => (
                <Show when={byAddress().get(address)}>
                  {(p) => (
                    <li
                      class={cn(
                        "grid h-9 items-center gap-2 border-b border-row-divider text-sm last:border-b-0",
                        cols,
                      )}
                    >
                      <CountryCode code={p().country} />
                      <span class="flex min-w-0 flex-col leading-tight">
                        <span class="truncate mono">{p().address}</span>
                        <span class="flex min-w-0 items-center gap-1 text-2xs text-subtle">
                          <span class="truncate">{p().client ?? "unknown client"}</span>
                          <Show when={p().encrypted}>
                            <PeerBadge on title="Encrypted">
                              E
                            </PeerBadge>
                          </Show>
                          <PeerBadge on title={p().transport === "utp" ? "µTP" : "TCP"}>
                            {p().transport === "utp" ? "µTP" : "TCP"}
                          </PeerBadge>
                          <Show when={p().incoming}>
                            <PeerBadge on title="They connected to us">
                              IN
                            </PeerBadge>
                          </Show>
                        </span>
                      </span>
                      <Rate value={p().download_rate} tone="text-brand" />
                      <Rate value={p().upload_rate} tone="text-upload" />
                      <span
                        class="flex flex-col items-end gap-[3px]"
                        title={`connected for ${formatDuration(p().connected_for)}`}
                      >
                        <span class="mono text-2xs text-muted-foreground">
                          {formatPercent(p().progress)}
                        </span>
                        <span class="block h-1 w-10 overflow-hidden rounded-full bg-border">
                          <span
                            class={cn(
                              "block h-full",
                              p().is_seed ? "bg-ok" : "bg-muted-foreground",
                            )}
                            style={{ width: `${p().progress * 100}%` }}
                          />
                        </span>
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          as="button"
                          aria-label={`Peer ${p().address}: actions`}
                          class="flex size-6 items-center justify-center rounded-md text-subtle hover:bg-accent hover:text-foreground"
                        >
                          <Ellipsis size={14} />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent class="min-w-44">
                          <DropdownMenuItem onSelect={() => void copy(p().address, "Peer address")}>
                            Copy address
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            class="text-danger"
                            onSelect={() => setBanning(peerIp(p().address))}
                          >
                            Ban this address…
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </li>
                  )}
                </Show>
              )}
            </For>
          </ul>
        </Show>
      </div>
      <div class="flex flex-none items-center justify-between gap-3 border-t border-divider pt-2 mono text-xs text-subtle">
        <span class="truncate">{swarm()}</span>
        <span class="flex-none">
          next announce{" "}
          {props.torrent.next_announce_in === null
            ? dash
            : formatDuration(props.torrent.next_announce_in)}
        </span>
      </div>
      <ConfirmDialog
        open={banning() !== null}
        title={`Ban ${banning() ?? ""}?`}
        description="Its connections close, on every torrent, and it cannot connect again. Bans are kept in Settings › Banned addresses."
        action="Ban"
        onClose={() => setBanning(null)}
        onConfirm={() => {
          const ip = banning();
          if (ip !== null) void ban(ip);
        }}
      />
      <PromptDialog
        open={adding()}
        title="Add peers"
        label="Addresses (ip:port, [ipv6]:port)"
        action="Add"
        onClose={() => setAdding(false)}
        onSubmit={(text) => void add(text)}
      />
    </div>
  );
}
