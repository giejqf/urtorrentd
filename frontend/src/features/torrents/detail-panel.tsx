// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The design's right panel (AGENTS.md 6.3): one torrent under a header of
// actions, in tabs (`?tab=`, kept while another torrent is picked). The
// Overview has its state, properties, pieces, transfer and trackers; Files,
// Peers, Trackers, History and Options are in `detail/`. The summary comes
// from the live store; each tab fetches what it shows while it shows it.

import { useSearchParams } from "@solidjs/router";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
import ChevronDown from "lucide-solid/icons/chevron-down";
import Ellipsis from "lucide-solid/icons/ellipsis";
import Play from "lucide-solid/icons/play";
import Plus from "lucide-solid/icons/plus";
import RotateCw from "lucide-solid/icons/rotate-cw";
import Square from "lucide-solid/icons/square";
import { createMemo, createSignal, For, type JSX, Match, Show, Switch } from "solid-js";

import { api, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { PromptDialog } from "~/components/prompt-dialog";
import { StatusDot } from "~/components/status-dot";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "~/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useLive } from "~/features/shell/live";
import {
  dash,
  formatBytes,
  formatCount,
  formatDateTime,
  formatDuration,
  formatFullDateTime,
  formatLimit,
  formatRatio,
} from "~/lib/format";
import { categoryTone, errorKindLabel, stateLook, toneBg, trackerHost } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { actions, copy, isRunning } from "./actions";
import { FilesTab } from "./detail/files-tab";
import { HistoryTab } from "./detail/history-tab";
import { createOptionsForm, OptionsLeaveGuard, OptionsTab } from "./detail/options-tab";
import { progressLine, trackerTone } from "./detail/parts";
import { PeersTab } from "./detail/peers-tab";
import { TrackersTab } from "./detail/trackers-tab";
import { PieceHashesDialog } from "./piece-hashes-dialog";
import { PiecesChart } from "./pieces-chart";
import { useTorrentDialogs } from "./torrent-dialogs";

type TorrentSummary = Schemas["TorrentSummary"];

function IconAction(props: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: JSX.Element;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        as={Button}
        variant="ghost"
        size="icon"
        aria-label={props.label}
        disabled={props.disabled}
        onClick={() => props.onClick()}
      >
        {props.children}
      </TooltipTrigger>
      <TooltipContent>{props.label}</TooltipContent>
    </Tooltip>
  );
}

function Prop(props: { label: string; children: JSX.Element; class?: string }) {
  return (
    <div class="grid min-h-7 grid-cols-[104px_minmax(0,1fr)] items-center gap-x-3 text-sm">
      <dt class="text-subtle">{props.label}</dt>
      <dd class={cn("m-0 flex min-w-0 items-center gap-1.5", props.class)}>{props.children}</dd>
    </div>
  );
}

function Stat(props: { label: string; children: JSX.Element }) {
  return (
    <div class="flex flex-col gap-0.5">
      <dt class="text-xs text-subtle">{props.label}</dt>
      <dd class="m-0 mono text-base">{props.children}</dd>
    </div>
  );
}

function ratioLimit(r: Schemas["RatioLimit"]): string {
  switch (r.mode) {
    case "global":
      return "global";
    case "unlimited":
      return "∞";
    case "limit":
      return r.value.toFixed(1);
  }
}

function CategoryMenu(props: { torrent: TorrentSummary }) {
  const live = useLive();
  const [creating, setCreating] = createSignal(false);
  const names = createMemo(() => Object.keys(live.state.categories).sort());
  const set = (c: string | null) => void actions.category([props.torrent.hash], c);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          as="button"
          class="-ml-1.5 flex h-6 min-w-0 items-center gap-1.5 rounded-md px-1.5 hover:bg-accent"
          aria-label={`Category: ${props.torrent.category ?? "none"}. Change`}
        >
          <StatusDot class={categoryTone(props.torrent.category)} />
          <span class="truncate">{props.torrent.category ?? "None"}</span>
          <ChevronDown size={12} class="flex-none text-subtle" />
        </DropdownMenuTrigger>
        <DropdownMenuContent class="min-w-48">
          <DropdownMenuRadioGroup
            value={props.torrent.category ?? ""}
            onChange={(v) => set(v === "" ? null : v)}
          >
            <DropdownMenuRadioItem value="">No category</DropdownMenuRadioItem>
            <For each={names()}>
              {(name) => <DropdownMenuRadioItem value={name}>{name}</DropdownMenuRadioItem>}
            </For>
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setCreating(true)}>New category…</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PromptDialog
        open={creating()}
        title="New category"
        label="Name"
        action="Create and set"
        onClose={() => setCreating(false)}
        onSubmit={(name) => set(name)}
      />
    </>
  );
}

function TagsEditor(props: { torrent: TorrentSummary }) {
  const live = useLive();
  const [creating, setCreating] = createSignal(false);
  const all = createMemo(() =>
    [...new Set([...live.state.tags, ...props.torrent.tags])].sort((a, b) => a.localeCompare(b)),
  );
  const toggle = (tag: string, on: boolean) =>
    void actions.tags([props.torrent.hash], on ? "add" : "remove", [tag]);
  return (
    <>
      <div class="flex min-w-0 flex-wrap items-center gap-1.5 py-1">
        <For each={props.torrent.tags}>{(tag) => <Badge>{tag}</Badge>}</For>
        <DropdownMenu>
          <DropdownMenuTrigger as={Button} variant="ghost" size="icon-sm" aria-label="Change tags">
            <Plus />
          </DropdownMenuTrigger>
          <DropdownMenuContent class="min-w-44">
            <For each={all()}>
              {(tag) => (
                <DropdownMenuCheckboxItem
                  checked={props.torrent.tags.includes(tag)}
                  onChange={(on) => toggle(tag, on)}
                  closeOnSelect={false}
                >
                  {tag}
                </DropdownMenuCheckboxItem>
              )}
            </For>
            <Show when={all().length > 0}>
              <DropdownMenuSeparator />
            </Show>
            <DropdownMenuItem onSelect={() => setCreating(true)}>New tag…</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <PromptDialog
        open={creating()}
        title="New tag"
        label="Tag"
        action="Create and add"
        onClose={() => setCreating(false)}
        onSubmit={(tag) => toggle(tag, true)}
      />
    </>
  );
}

function Trackers(props: { torrent: TorrentSummary }) {
  const hash = () => props.torrent.hash;
  const query = createQuery(() => ({
    queryKey: keys.torrentPart(hash(), "trackers"),
    queryFn: () =>
      unwrap(api.GET("/api/v1/torrents/{hash}/trackers", { params: { path: { hash: hash() } } })),
    refetchInterval: 5_000,
  }));
  const client = useQueryClient();
  const sources = () => {
    const d = query.data;
    if (!d) return null;
    const on = (
      [
        ["DHT", d.dht],
        ["PEX", d.pex],
        ["LSD", d.lsd],
      ] as const
    ).filter(([, s]) => s.enabled);
    return { names: on.map(([n]) => n), peers: on.reduce((n, [, s]) => n + s.peers, 0) };
  };
  return (
    <section aria-label="Trackers" class="flex flex-col gap-1">
      <div class="mb-1 flex items-center justify-between">
        <h3 class="m-0 section-label">Trackers</h3>
        <Button
          variant="outline"
          size="sm"
          class="h-6 px-2 text-xs"
          onClick={() => {
            const h = hash();
            void actions
              .reannounce([h])
              .then(() => client.invalidateQueries({ queryKey: keys.torrentPart(h, "trackers") }));
          }}
        >
          Reannounce
        </Button>
      </div>
      <Show when={query.data} fallback={<div class="h-7 animate-pulse rounded-md bg-muted" />}>
        {(d) => (
          <ul class="m-0 flex list-none flex-col p-0">
            <For each={d().trackers}>
              {(t) => (
                <li class="grid min-h-7 grid-cols-[8px_minmax(0,1fr)_76px] items-center gap-2.5 text-sm">
                  <StatusDot class={trackerTone(t.status)} small />
                  <span class="flex min-w-0 flex-col">
                    <span class="truncate mono text-xs">{trackerHost(t.url) ?? "?"}</span>
                    <Show when={t.status === "not_working" && t.message}>
                      <span class="truncate text-xs text-danger">{t.message}</span>
                    </Show>
                  </span>
                  <span class="text-right mono text-xs text-muted-foreground">
                    <Switch fallback={dash}>
                      <Match when={t.updating}>updating</Match>
                      <Match when={t.next_announce_in !== null}>
                        {formatDuration(t.next_announce_in ?? 0)}
                      </Match>
                    </Switch>
                  </span>
                </li>
              )}
            </For>
            <li class="grid min-h-7 grid-cols-[8px_minmax(0,1fr)_76px] items-center gap-2.5 text-sm">
              <StatusDot class="bg-faint" small />
              <span class="truncate text-muted-foreground">
                <Show
                  when={(sources()?.names.length ?? 0) > 0}
                  fallback={
                    props.torrent.private
                      ? "DHT, PEX and LSD are off for private torrents"
                      : "DHT, PEX and LSD are off"
                  }
                >
                  {sources()?.names.join(" · ")}
                </Show>
              </span>
              <span class="text-right mono text-xs text-muted-foreground">
                {formatCount(sources()?.peers ?? 0)} peers
              </span>
            </li>
          </ul>
        )}
      </Show>
    </section>
  );
}

function exportTorrent(t: TorrentSummary) {
  const a = document.createElement("a");
  a.href = "/api/v1/torrents/{hash}/torrent-file".replace("{hash}", t.hash);
  a.download = `${t.name}.torrent`;
  a.click();
}

/** The header's "more" menu: the actions that do not have a button. */
function MoreMenu(props: { torrent: TorrentSummary; onDelete: () => void }) {
  const dialogs = useTorrentDialogs();
  const h = () => [props.torrent.hash];
  const [hashes, setHashes] = createSignal(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger as={Button} variant="ghost" size="icon" aria-label="More actions">
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent class="min-w-56">
          <DropdownMenuCheckboxItem
            checked={props.torrent.forced}
            onChange={(on) => void actions.forceStart(h(), on)}
          >
            Force start
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={props.torrent.sequential}
            onChange={(on) => void actions.sequential(h(), on)}
          >
            Sequential download
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={props.torrent.first_last_piece_priority}
            onChange={(on) => void actions.firstLast(h(), on)}
          >
            First and last pieces first
          </DropdownMenuCheckboxItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>Queue</DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              <DropdownMenuItem onSelect={() => void actions.queue(h(), "top")}>
                Move to top
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void actions.queue(h(), "up")}>
                Move up
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void actions.queue(h(), "down")}>
                Move down
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void actions.queue(h(), "bottom")}>
                Move to bottom
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void copy(props.torrent.magnet_uri, "Magnet link")}>
            Copy magnet link
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void copy(props.torrent.hash, "Info-hash")}>
            Copy info-hash
          </DropdownMenuItem>
          <Show when={props.torrent.has_metadata}>
            <DropdownMenuItem onSelect={() => exportTorrent(props.torrent)}>
              Export .torrent file
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => setHashes(true)}>Piece hashes…</DropdownMenuItem>
          </Show>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => dialogs.move([props.torrent.hash])}>
            Move content…
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => dialogs.shareLimits([props.torrent.hash])}>
            Share limits…
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem class="text-danger" onSelect={() => props.onDelete()}>
            Remove…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <PieceHashesDialog
        torrent={hashes() ? props.torrent : null}
        onClose={() => setHashes(false)}
      />
    </>
  );
}

const TABS = ["overview", "files", "peers", "trackers", "history", "options"] as const;
type Tab = (typeof TABS)[number];
const TAB_LABELS: Record<Tab, string> = {
  overview: "Overview",
  files: "Files",
  peers: "Peers",
  trackers: "Trackers",
  history: "History",
  options: "Options",
};

function Overview(props: { torrent: TorrentSummary }) {
  const t = () => props.torrent;
  const look = () => stateLook(t());
  const flags = () =>
    [
      t().private && "private",
      t().forced && "forced",
      t().sequential && "sequential",
      t().first_last_piece_priority && "first & last pieces",
      t().auto_management && "automatic management",
    ].filter((f): f is string => typeof f === "string");
  return (
    <div class="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4">
      <div class="flex flex-col gap-2.5">
        <h2 class="m-0 text-md leading-[1.3] font-semibold [overflow-wrap:anywhere]">{t().name}</h2>
        <div class="flex items-center gap-2">
          <Badge variant="pill">
            <StatusDot class={toneBg[look().tone]} />
            {look().label}
          </Badge>
          <span class="mono text-sm text-muted-foreground">{progressLine(t())}</span>
        </div>
        <div
          class="h-1 overflow-hidden rounded-full bg-divider"
          role="progressbar"
          aria-label="Progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.floor(t().progress * 100)}
        >
          <div
            class={cn("h-full", t().complete ? "bg-ok" : "bg-brand")}
            style={{ width: `${Math.floor(t().progress * 1000) / 10}%` }}
          />
        </div>
        <Show when={t().state === "error"}>
          <div
            role="alert"
            class="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-foreground-2"
          >
            <span class="font-medium text-danger">{errorKindLabel(t().error_kind)}</span>
            <Show when={t().error}>: {t().error}</Show>
            <Show when={t().error_kind === "content_missing" || t().error_kind === "io"}>
              <span class="block text-muted-foreground">
                Start or recheck it once the files are back.
              </span>
            </Show>
          </div>
        </Show>
      </div>

      <section aria-label="Properties" class="flex flex-col">
        <h3 class="m-0 mb-1.5 section-label">Properties</h3>
        <dl class="m-0">
          <Prop label="Category">
            <CategoryMenu torrent={t()} />
          </Prop>
          <Prop label="Tags">
            <TagsEditor torrent={t()} />
          </Prop>
          <Prop label="Save path" class="block">
            <span class="block truncate mono text-xs" title={t().save_path}>
              {t().save_path}
            </span>
          </Prop>
          <Prop label="Tracker" class="block">
            <span class="block truncate mono text-xs">
              {trackerHost(t().tracker) ??
                (t().trackers_count === 0 ? "none" : `none of ${t().trackers_count} working`)}
            </span>
          </Prop>
          <Prop label="Limits" class="mono">
            ↓ {formatLimit(t().download_limit)} · ↑ {formatLimit(t().upload_limit)} · ratio{" "}
            {ratioLimit(t().share_limits.ratio)}
          </Prop>
          <Prop label="Added" class="mono">
            <span title={formatFullDateTime(t().added_on)}>{formatDateTime(t().added_on)}</span>
          </Prop>
          <Prop label="Flags" class="flex-wrap py-1">
            <Show when={flags().length > 0} fallback={<span class="text-subtle">{dash}</span>}>
              <For each={flags()}>{(f) => <Badge>{f}</Badge>}</For>
            </Show>
          </Prop>
        </dl>
      </section>

      <PiecesChart torrent={t()} />

      <section aria-label="Transfer" class="flex flex-col gap-2.5">
        <h3 class="m-0 section-label">Transfer</h3>
        <dl class="m-0 grid grid-cols-3 gap-3">
          <Stat label="Downloaded">{formatBytes(t().downloaded)}</Stat>
          <Stat label="Uploaded">{formatBytes(t().uploaded)}</Stat>
          <Stat label="Ratio">{formatRatio(t().ratio)}</Stat>
          <Stat label="Peers">
            {formatCount(t().peers)}{" "}
            <span class="text-subtle">/ {formatCount(t().seeds)} seeds</span>
          </Stat>
          <Stat label="Wasted">{formatBytes(t().wasted)}</Stat>
          <Stat label="Seeding time">{formatDuration(t().seeding_time)}</Stat>
        </dl>
      </section>

      <Trackers torrent={t()} />
    </div>
  );
}

/** The tabs of one torrent; the Options draft lives here, so it outlasts a switch of tab. */
function TorrentTabs(props: { torrent: TorrentSummary; tab: Tab; onTab: (tab: Tab) => void }) {
  const form = createOptionsForm(() => props.torrent);
  return (
    <Tabs
      value={props.tab}
      onChange={(v) => props.onTab(v as Tab)}
      class="flex min-h-0 flex-1 flex-col"
    >
      <TabsList
        class="h-9 flex-none items-end gap-0.5 px-2"
        aria-label={`Details of ${props.torrent.name}`}
      >
        <For each={TABS}>
          {(tab) => (
            <TabsTrigger
              value={tab}
              class="-mb-px h-[34px] rounded-t-md border-b-2 border-transparent px-2.5 text-sm data-[selected]:border-foreground"
            >
              {TAB_LABELS[tab]}
              <Show when={tab === "options" && form.dirty()}>
                <span class="size-1.5 rounded-full bg-warn" aria-label="unsaved changes" />
              </Show>
            </TabsTrigger>
          )}
        </For>
      </TabsList>
      <TabsContent value="overview" class="mt-0 flex min-h-0 flex-1 flex-col">
        <Overview torrent={props.torrent} />
      </TabsContent>
      <TabsContent value="files" class="mt-0 flex min-h-0 flex-1 flex-col">
        <FilesTab torrent={props.torrent} />
      </TabsContent>
      <TabsContent value="peers" class="mt-0 flex min-h-0 flex-1 flex-col">
        <PeersTab torrent={props.torrent} />
      </TabsContent>
      <TabsContent value="trackers" class="mt-0 flex min-h-0 flex-1 flex-col">
        <TrackersTab torrent={props.torrent} />
      </TabsContent>
      <TabsContent value="history" class="mt-0 flex min-h-0 flex-1 flex-col">
        <HistoryTab torrent={props.torrent} />
      </TabsContent>
      <TabsContent value="options" class="mt-0 flex min-h-0 flex-1 flex-col">
        <OptionsTab torrent={props.torrent} form={form} />
      </TabsContent>
      <OptionsLeaveGuard form={form} hash={props.torrent.hash} />
    </Tabs>
  );
}

export function DetailPanel(props: {
  torrent: TorrentSummary;
  onDelete: (hashes: readonly string[]) => void;
  class?: string;
}) {
  const [params, setParams] = useSearchParams<{ tab?: string }>();
  const tab = (): Tab => TABS.find((x) => x === params.tab) ?? "overview";
  const t = () => props.torrent;
  const running = () => isRunning(t());

  return (
    <section
      aria-label={`Details of ${t().name}`}
      class={cn("flex min-h-0 flex-col bg-card", props.class)}
    >
      <div class="flex h-12 flex-none items-center gap-1 border-b border-divider pr-3 pl-4">
        <span class="truncate text-sm text-subtle">
          {t().category ?? "No category"}
          <span class="mx-1" aria-hidden="true">
            ›
          </span>
          <span class="mono">{t().hash.slice(0, 8)}</span>
        </span>
        <div class="flex-1" />
        <IconAction
          label="Start"
          disabled={running()}
          onClick={() => void actions.start([t().hash])}
        >
          <Play class="fill-current" />
        </IconAction>
        <IconAction
          label="Stop"
          disabled={!running()}
          onClick={() => void actions.stop([t().hash])}
        >
          <Square class="fill-current" />
        </IconAction>
        <IconAction label="Recheck" onClick={() => void actions.recheck([t().hash])}>
          <RotateCw />
        </IconAction>
        <MoreMenu torrent={t()} onDelete={() => props.onDelete([t().hash])} />
      </div>
      {/* One torrent's tabs at a time: a draft never follows another torrent. */}
      <Show when={t().hash} keyed>
        <TorrentTabs
          torrent={props.torrent}
          tab={tab()}
          onTab={(v) => setParams({ tab: v === "overview" ? undefined : v }, { scroll: false })}
        />
      </Show>
    </section>
  );
}
