// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The design's left panel (AGENTS.md 6.3): instance menu and connection,
// search, navigation, the torrent filters with their counts (categories and
// tags are managed there too, organize.tsx), and the session's transfer
// state.

import { A, useLocation, useSearchParams } from "@solidjs/router";
import ChartLine from "lucide-solid/icons/chart-line";
import ChevronDown from "lucide-solid/icons/chevron-down";
import LogOut from "lucide-solid/icons/log-out";
import PanelsTopLeft from "lucide-solid/icons/panels-top-left";
import Power from "lucide-solid/icons/power";
import Rss from "lucide-solid/icons/rss";
import Search from "lucide-solid/icons/search";
import Settings from "lucide-solid/icons/settings";
import SunMoon from "lucide-solid/icons/sun-moon";
import TextAlignStart from "lucide-solid/icons/text-align-start";
import {
  type Component,
  createMemo,
  createSignal,
  For,
  lazy,
  Match,
  Show,
  Suspense,
  Switch,
} from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, unwrap } from "~/api/client";
import { Kbd } from "~/components/kbd";
import { LogoMark } from "~/components/logo";
import { StatusDot } from "~/components/status-dot";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "~/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "~/components/ui/tooltip";
import { useAuth } from "~/features/auth/auth";
import {
  countAll,
  NO_TRACKER,
  type StatusFilter,
  STATUS_FILTERS,
  TRACKER_DOWN,
  trackerLabel,
} from "~/features/torrents/view";
import { formatCount, formatBytes, formatRate } from "~/lib/format";
import { isThemeChoice, setThemeChoice, THEME_CHOICES, themeChoice } from "~/lib/theme";
import { cn } from "~/lib/utils";

import { useLive } from "./live";
import { useShell } from "./protected";
import { CategorySection, TagSection } from "./organize";
import { FilterItem, Section } from "./sidebar-items";

export const STATUS_LABELS: Record<StatusFilter, string> = {
  all: "All",
  downloading: "Downloading",
  seeding: "Seeding",
  completed: "Completed",
  stopped: "Stopped",
  running: "Running",
  active: "Active",
  inactive: "Inactive",
  stalled: "Stalled or idle",
  stalled_seeding: "Idle",
  stalled_downloading: "Stalled",
  checking: "Checking",
  moving: "Moving",
  errored: "Errored",
  queued: "Queued",
};

export const STATUS_DOTS: Record<StatusFilter, string> = {
  all: "bg-foreground",
  downloading: "bg-brand",
  seeding: "bg-ok",
  completed: "bg-ok",
  stopped: "bg-subtle",
  running: "bg-foreground",
  active: "bg-foreground",
  inactive: "bg-subtle",
  stalled: "bg-muted-foreground",
  stalled_seeding: "bg-ok/45",
  stalled_downloading: "bg-muted-foreground",
  checking: "bg-warn",
  moving: "bg-warn",
  errored: "bg-danger",
  queued: "bg-muted-foreground",
};

/** The torrent list's filters, as they travel in the URL. */
export interface FilterParams {
  status?: string;
  category?: string;
  tag?: string;
  tracker?: string;
  q?: string;
  [key: string]: string | undefined;
}

const isMac = () => /Mac|iPhone|iPad/.test(navigator.platform);

// The Stats, RSS and Log screens' own sections and footers, loaded with them.
const StatsSidebar = lazy(() => import("~/features/stats/sidebar"));
const RssSidebar = lazy(() => import("~/features/rss/sidebar"));
const LogSidebar = lazy(() => import("~/features/log/sidebar"));

function NavItem(props: {
  href: string;
  icon: Component<{ size?: number }>;
  label: string;
  onNavigate?: () => void;
}) {
  const location = useLocation();
  const active = () => location.pathname.startsWith(props.href);
  return (
    <A
      href={props.href}
      class={cn(
        "flex h-[30px] w-full items-center gap-2 rounded-md px-2 text-base font-medium transition-colors",
        active()
          ? "bg-selected text-foreground"
          : "text-muted-foreground hover:bg-accent hover:text-foreground",
      )}
      aria-current={active() ? "page" : undefined}
      onClick={() => props.onNavigate?.()}
    >
      <props.icon size={15} />
      {props.label}
    </A>
  );
}

export function ConnectionDot() {
  const live = useLive();
  const look = () => {
    switch (live.connection()) {
      case "live":
        return { tone: "bg-online", label: "Connected to the daemon" };
      case "connecting":
        return { tone: "bg-warn", label: "Connecting…" };
      case "reconnecting":
        return { tone: "bg-warn", label: "Reconnecting…" };
      case "signed_out":
        return { tone: "bg-subtle", label: "Signed out" };
      case "stopped":
        return { tone: "bg-danger", label: "Daemon unreachable" };
    }
  };
  return (
    <Tooltip>
      <TooltipTrigger
        as="span"
        class="flex size-6 items-center justify-center"
        role="status"
        aria-label={look().label}
      >
        <StatusDot class={look().tone} />
      </TooltipTrigger>
      <TooltipContent>{look().label}</TooltipContent>
    </Tooltip>
  );
}

export function InstanceMenu() {
  const auth = useAuth();
  const [confirm, setConfirm] = createSignal(false);
  const app = () => {
    const s = auth.state();
    return s.kind === "signed-in" ? s.app : null;
  };
  const name = () => app()?.instance_name ?? "urtorrentd";
  const shutdown = async () => {
    try {
      await unwrap(api.POST("/api/v1/app/shutdown"));
      setConfirm(false);
      auth.stopped();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The daemon did not stop.");
    }
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          as="button"
          class="flex h-7 min-w-0 items-center gap-1.5 rounded-md px-1.5 text-base hover:bg-accent"
          aria-label={`${name()}: instance menu`}
        >
          <span class="truncate font-semibold text-foreground">{name()}</span>
          <ChevronDown size={12} class="flex-none text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent class="w-64">
          <DropdownMenuLabel class="flex flex-col gap-0.5">
            <span class="text-base font-medium text-foreground">{name()}</span>
            <span class="mono text-xs font-normal text-subtle">
              urtorrentd {app()?.version} · {app()?.library}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <SunMoon size={14} />
              Theme
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent class="min-w-40">
              <DropdownMenuRadioGroup
                value={themeChoice()}
                onChange={(v) => isThemeChoice(v) && setThemeChoice(v)}
              >
                <For each={THEME_CHOICES}>
                  {(c) => <DropdownMenuRadioItem value={c.value}>{c.label}</DropdownMenuRadioItem>}
                </For>
              </DropdownMenuRadioGroup>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem onSelect={() => void auth.signOut()}>
            <LogOut size={14} />
            Sign out
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setConfirm(true)} class="text-danger">
            <Power size={14} />
            Shut down the daemon…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <AlertDialog open={confirm()} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Shut down the daemon?</AlertDialogTitle>
            <AlertDialogDescription>
              Every torrent stops until urtorrentd is started again on the machine it runs on. This
              page cannot start it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose as={Button} variant="outline" aria-label="Cancel">
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" onClick={() => void shutdown()}>
              Shut down
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** The design's search: a button that opens the command palette (⌘K). */
function SearchButton(props: { onNavigate?: () => void }) {
  const shell = useShell();
  return (
    <button
      type="button"
      class="flex h-[30px] w-full items-center justify-between gap-2 rounded-md border border-border bg-background px-2 text-base font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
      onClick={() => {
        props.onNavigate?.();
        shell.openPalette();
      }}
    >
      <span class="flex items-center gap-2">
        <Search size={14} class="flex-none" />
        Search
      </span>
      <Kbd>{isMac() ? "⌘K" : "Ctrl K"}</Kbd>
    </button>
  );
}

function Filters() {
  const live = useLive();
  const [params, setParams] = useSearchParams<FilterParams>();
  const counts = createMemo(() => countAll(live.torrents()));
  const status = () => params.status ?? "all";
  const categories = createMemo(() => {
    const names = new Set(Object.keys(live.state.categories));
    for (const [name, n] of counts().categories) if (n > 0) names.add(name);
    return [...names].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  });
  const tags = createMemo(() => {
    const names = new Set(live.state.tags);
    for (const t of counts().tags.keys()) names.add(t);
    return [...names].sort((a, b) => a.localeCompare(b));
  });
  const trackers = createMemo(() =>
    [...counts().trackers.entries()].sort((a, b) => {
      const rank = (k: string) => (k === NO_TRACKER ? 2 : k === TRACKER_DOWN ? 1 : 0);
      return rank(a[0]) - rank(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]);
    }),
  );
  const toggle = (key: "category" | "tag" | "tracker", value: string) =>
    setParams({ [key]: params[key] === value ? undefined : value });

  return (
    <div class="flex min-h-0 flex-1 flex-col overflow-auto px-2 py-2">
      <Section title="Status">
        <For each={STATUS_FILTERS.filter((s) => s !== "moving" || counts().status.moving > 0)}>
          {(s) => (
            <FilterItem
              label={
                <>
                  <StatusDot class={STATUS_DOTS[s]} />
                  {STATUS_LABELS[s]}
                </>
              }
              count={counts().status[s]}
              active={status() === s}
              onClick={() => setParams({ status: s === "all" ? undefined : s })}
            />
          )}
        </For>
      </Section>
      <CategorySection
        names={categories()}
        count={(name) => counts().categories.get(name) ?? 0}
        active={params.category}
        onToggle={(name) => toggle("category", name)}
        onGone={(name) => params.category === name && setParams({ category: undefined })}
      />
      <TagSection
        names={tags()}
        count={(tag) => counts().tags.get(tag) ?? 0}
        active={params.tag}
        onToggle={(tag) => toggle("tag", tag)}
        onGone={(tag) => params.tag === tag && setParams({ tag: undefined })}
      />
      <Show when={trackers().length > 0}>
        <Section title="Trackers">
          <For each={trackers()}>
            {([key, n]) => (
              <FilterItem
                label={<span class="truncate">{trackerLabel(key)}</span>}
                title={trackerLabel(key)}
                count={n}
                active={params.tracker === key}
                onClick={() => toggle("tracker", key)}
              />
            )}
          </For>
        </Section>
      </Show>
    </div>
  );
}

function TransferFooter() {
  const live = useLive();
  const t = () => live.state.transfer;
  return (
    <div class="flex flex-col gap-1.5 border-t border-divider px-3 py-2.5 mono text-xs text-subtle">
      <div class="flex justify-between">
        <span>
          <span class="text-brand" aria-hidden="true">
            ↓
          </span>
          <span class="sr-only">Download</span> {formatRate(t()?.download_rate ?? 0)}
        </span>
        <span>
          <span class="text-upload" aria-hidden="true">
            ↑
          </span>
          <span class="sr-only">Upload</span> {formatRate(t()?.upload_rate ?? 0)}
        </span>
      </div>
      <div class="flex justify-between gap-2">
        <span class="truncate">
          {formatCount(t()?.peers ?? 0)} peers · DHT {formatCount(t()?.dht_nodes ?? 0)}
        </span>
        <span class="flex-none">
          {t()?.free_space == null ? "—" : formatBytes(t()?.free_space ?? 0)} free
        </span>
      </div>
    </div>
  );
}

export function Sidebar(props: { class?: string; onNavigate?: () => void }) {
  const location = useLocation();
  return (
    <aside class={cn("min-h-0 flex-col bg-sidebar", props.class)} aria-label="Sidebar">
      <div class="flex h-12 flex-none items-center gap-2 px-3">
        <LogoMark />
        <InstanceMenu />
        <div class="flex-1" />
        <ConnectionDot />
      </div>
      <div class="flex-none px-2 pb-2">
        <SearchButton onNavigate={props.onNavigate} />
      </div>
      <nav aria-label="Main" class="flex flex-none flex-col gap-px px-2">
        <NavItem
          href="/torrents"
          icon={PanelsTopLeft}
          label="Torrents"
          onNavigate={props.onNavigate}
        />
        <NavItem href="/stats" icon={ChartLine} label="Stats" onNavigate={props.onNavigate} />
        <NavItem href="/rss" icon={Rss} label="RSS" onNavigate={props.onNavigate} />
        <NavItem href="/log" icon={TextAlignStart} label="Log" onNavigate={props.onNavigate} />
        <NavItem href="/settings" icon={Settings} label="Settings" onNavigate={props.onNavigate} />
      </nav>
      <Switch
        fallback={
          <>
            <div class="flex-1" />
            <TransferFooter />
          </>
        }
      >
        <Match when={location.pathname.startsWith("/torrents")}>
          <Filters />
          <TransferFooter />
        </Match>
        <Match when={location.pathname.startsWith("/stats")}>
          <Suspense fallback={<div class="flex-1" />}>
            <StatsSidebar onNavigate={props.onNavigate} />
          </Suspense>
        </Match>
        <Match when={location.pathname.startsWith("/rss")}>
          <Suspense fallback={<div class="flex-1" />}>
            <RssSidebar onNavigate={props.onNavigate} />
          </Suspense>
        </Match>
        <Match when={location.pathname.startsWith("/log")}>
          <Suspense fallback={<div class="flex-1" />}>
            <LogSidebar onNavigate={props.onNavigate} />
          </Suspense>
        </Match>
      </Switch>
    </aside>
  );
}
