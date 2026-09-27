// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The command palette as designed (Command palette ⌘K; AGENTS.md 6.4):
// torrents by the daemon's search (removed ones from the statistics), file
// names across torrents, and commands, in one list moved through with the
// arrows. ⌘K (Ctrl K) or / opens it anywhere; its commands' keys work
// without it: , opens Settings and ⌥S switches the alternative limits.

import * as DialogPrimitive from "@kobalte/core/dialog";
import { useNavigate } from "@solidjs/router";
import { createQuery, keepPreviousData } from "@tanstack/solid-query";
import ChevronRight from "lucide-solid/icons/chevron-right";
import FileIcon from "lucide-solid/icons/file";
import Search from "lucide-solid/icons/search";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { Kbd } from "~/components/kbd";
import { ProgressRing } from "~/components/progress-ring";
import { useAuth } from "~/features/auth/auth";
import { SECTIONS } from "~/features/settings/nav-sections";
import { kbText } from "~/features/settings/speed-form";
import { REPORTS } from "~/features/stats/sidebar";
import { formatBytes, formatCount, formatPercent, formatShortDate } from "~/lib/format";
import { canHandleMagnets, handleMagnets } from "~/lib/magnets";
import { useSettled } from "~/lib/settled";
import {
  ACCENTS,
  accentChoice,
  setAccentChoice,
  setThemeChoice,
  setUnitsChoice,
  THEME_CHOICES,
  themeChoice,
  UNITS,
  unitsChoice,
} from "~/lib/theme";
import { stateLook, type Tone } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { useLive } from "./live";
import {
  commandMatches,
  cycleScope,
  highlight,
  isOpenModal,
  isTyping,
  parseQuery,
  type Scope,
  SCOPES,
} from "./palette-view";
import { useShell } from "./protected";
import { ShortcutsDialog } from "./shortcuts";

type TorrentSummary = Schemas["TorrentSummary"];

const mac = () => /Mac|iPhone|iPad/.test(navigator.platform);
const mod = () => (mac() ? "⌘" : "Ctrl ");

const toneStroke: Record<Tone, string> = {
  brand: "stroke-brand",
  ok: "stroke-ok",
  idle: "stroke-ok/45",
  warn: "stroke-warn",
  muted: "stroke-muted-foreground",
  subtle: "stroke-subtle",
  danger: "stroke-danger",
};

interface Command {
  id: string;
  label: string;
  sub?: string;
  keywords?: string;
  /** The key that does it without the palette. */
  key?: string;
  run: () => void;
}

type Item =
  | { kind: "torrent"; id: string; t: TorrentSummary }
  | { kind: "removed"; id: string; r: Schemas["HistoryTorrent"] }
  | { kind: "all"; id: string; words: string; count: number }
  | { kind: "file"; id: string; f: Schemas["FileMatch"] }
  | { kind: "command"; id: string; c: Command };

interface Group {
  label: string;
  count?: number;
  /** The request behind it, as the design shows it. */
  request?: string;
  items: Item[];
}

/** Everything's share of each group, and a scope's own. */
const LIMIT = { everything: 5, scoped: 50 };

export function CommandPalette(props: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const live = useLive();
  const auth = useAuth();
  const shell = useShell();
  const navigate = useNavigate();
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
    enabled: props.open,
  }));

  const altOn = () => live.state.transfer?.alt_speed_enabled ?? false;
  const switchAlt = async () => {
    const enabled = !altOn();
    try {
      await unwrap(api.PUT("/api/v1/transfer/alt-speed", { body: { enabled } }));
      toast.success(enabled ? "Alternative limits on" : "Alternative limits off");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The alternative limits did not switch.");
    }
  };
  const go = (href: string) => navigate(href);

  const commands = createMemo<Command[]>(() => {
    const s = settings.data;
    const limits = s
      ? ` · ${kbText(s.alt_download_limit) || "∞"} / ${kbText(s.alt_upload_limit) || "∞"} kB/s`
      : "";
    return [
      {
        id: "add",
        label: "Add torrent…",
        sub: "from magnet, URL or file",
        keywords: "new magnet url file",
        run: () => shell.openAdd(),
      },
      {
        id: "alt",
        label: "Toggle alternative speed limits",
        sub: `currently ${altOn() ? "on" : "off"}${limits}`,
        keywords: "turtle slow speed limits",
        key: mac() ? "⌥S" : "Alt S",
        run: () => void switchAlt(),
      },
      { id: "torrents", label: "Open Torrents", keywords: "list", run: () => go("/torrents") },
      ...REPORTS.map((r) => ({
        id: `stats:${r.href}`,
        label: r.href === "/stats" ? "Open Stats" : `Open Stats › ${r.label}`,
        keywords: "statistics reports history",
        run: () => go(r.href),
      })),
      { id: "rss", label: "Open RSS", keywords: "feeds rules articles", run: () => go("/rss") },
      { id: "log", label: "Open Log", keywords: "messages events", run: () => go("/log") },
      {
        id: "settings",
        label: "Open Settings",
        keywords: "preferences options",
        key: ",",
        run: () => go("/settings"),
      },
      ...SECTIONS.flatMap((g) =>
        g.items.map((i) => ({
          id: `settings:${i.id}`,
          label: `Open Settings › ${i.label}`,
          keywords: `${g.title} preferences`,
          run: () => go(`/settings/${i.id}`),
        })),
      ),
      ...THEME_CHOICES.map((c) => ({
        id: `theme:${c.value}`,
        label: `Theme: ${c.label}`,
        sub: themeChoice() === c.value ? "in use" : undefined,
        keywords: "appearance colours colors dark light mode",
        run: () => setThemeChoice(c.value),
      })),
      ...(canHandleMagnets()
        ? [
            {
              id: "magnets",
              label: "Open magnet links here",
              sub: "in this browser, once it asks you to confirm",
              keywords: "magnet handler protocol browser links",
              run: () => handleMagnets(),
            },
          ]
        : []),
      ...ACCENTS.map((c) => ({
        id: `accent:${c.value}`,
        label: `Accent: ${c.label}`,
        sub: accentChoice() === c.value ? "in use" : undefined,
        keywords: "appearance colour color brand",
        run: () => setAccentChoice(c.value),
      })),
      ...UNITS.map((c) => ({
        id: `units:${c.value}`,
        label: `Units: ${c.label}`,
        sub: unitsChoice() === c.value ? "in use" : undefined,
        keywords: "sizes rates bytes mebibytes megabytes",
        run: () => setUnitsChoice(c.value),
      })),
      {
        id: "shortcuts",
        label: "Keyboard shortcuts",
        keywords: "keys help hotkeys",
        key: "?",
        run: () => setShortcuts(true),
      },
      { id: "sign-out", label: "Sign out", keywords: "log out", run: () => void auth.signOut() },
    ];
  });

  let before: Element | null = null;
  const [shortcuts, setShortcuts] = createSignal(false);
  const setOpen = (open: boolean) => {
    // Where focus was before the palette, to go back to.
    if (open && !props.open) before = document.activeElement;
    props.onOpenChange(open);
  };

  // Keys that work anywhere.
  const onKey = (e: KeyboardEvent) => {
    if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey) && !e.altKey) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(!props.open);
      return;
    }
    if (props.open || isTyping(e.target) || isOpenModal()) return;
    if (e.key === "/" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setOpen(true);
    } else if (e.key === "?" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      setShortcuts(true);
    } else if (e.key === "," && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      go("/settings");
    } else if (e.code === "KeyS" && e.altKey && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      void switchAlt();
    }
  };
  // Before the page's own keys (the list's k moves up).
  onMount(() => document.addEventListener("keydown", onKey, true));
  onCleanup(() => document.removeEventListener("keydown", onKey, true));

  return (
    <>
      <DialogPrimitive.Root open={props.open} onOpenChange={setOpen}>
        <DialogPrimitive.Portal>
          {/* It closes at once, no fade: focus goes back before the next key. */}
          <DialogPrimitive.Overlay class="fixed inset-0 z-50 bg-overlay data-[expanded]:animate-in data-[expanded]:fade-in-0" />
          <div class="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[min(120px,12vh)] max-sm:px-2 max-sm:pt-2">
            <DialogPrimitive.Content
              onCloseAutoFocus={(e) => {
                // Back where the user was, or to the page itself: focus left
                // on the removed field would swallow every key after.
                e.preventDefault();
                const back = before;
                before = null;
                if (back instanceof HTMLElement && back.isConnected && back !== document.body) {
                  back.focus();
                } else {
                  document.getElementById("content")?.focus({ preventScroll: true });
                }
              }}
              class="flex max-h-[calc(100dvh-2rem)] w-full max-w-[680px] flex-col overflow-hidden rounded-card border border-border bg-card text-card-foreground shadow-card outline-none data-[expanded]:animate-in data-[expanded]:fade-in-0"
              aria-label="Command palette"
            >
              <Show when={props.open}>
                <Palette commands={commands()} onClose={() => setOpen(false)} />
              </Show>
            </DialogPrimitive.Content>
          </div>
        </DialogPrimitive.Portal>
      </DialogPrimitive.Root>
      <ShortcutsDialog open={shortcuts()} onClose={() => setShortcuts(false)} />
    </>
  );
}

function Palette(props: { commands: Command[]; onClose: () => void }) {
  const live = useLive();
  const auth = useAuth();
  const navigate = useNavigate();
  const [text, setText] = createSignal("");
  const [chosen, setChosen] = createSignal<Scope>("everything");
  const [active, setActive] = createSignal(0);
  const query = createMemo(() => parseQuery(text(), chosen()));
  const scope = () => query().scope;
  const words = () => query().words;
  const settled = useSettled(words, 150);
  const limit = () => (scope() === "everything" ? LIMIT.everything : LIMIT.scoped);
  const wants = (s: Scope) => scope() === "everything" || scope() === s;

  const hashes = createQuery(() => ({
    queryKey: ["torrents", "search", settled()],
    queryFn: async () =>
      new Set(
        await unwrap(
          api.GET("/api/v1/torrents/hashes", { params: { query: { search: settled() } } }),
        ),
      ),
    enabled: settled() !== "" && wants("torrents"),
    placeholderData: keepPreviousData,
  }));
  const removed = createQuery(() => ({
    queryKey: ["stats", "torrents", settled(), limit()],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/stats/torrents", {
          params: { query: { search: settled(), removed: true, limit: limit() } },
        }),
      ),
    enabled: settled() !== "" && wants("torrents"),
    placeholderData: keepPreviousData,
    retry: false,
  }));
  const files = createQuery(() => ({
    queryKey: ["torrents", "files", settled(), limit()],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/torrents/files", {
          params: { query: { search: settled(), limit: limit() } },
        }),
      ),
    enabled: settled() !== "" && wants("files"),
    placeholderData: keepPreviousData,
  }));
  const indexed = createQuery(() => ({
    queryKey: ["torrents", "files", "", 1],
    queryFn: () => unwrap(api.GET("/api/v1/torrents/files", { params: { query: { limit: 1 } } })),
  }));

  const groups = createMemo<Group[]>(() => {
    const out: Group[] = [];
    const w = words();
    const typed = w !== "" && w === settled();
    if (wants("torrents") && typed) {
      const found = hashes.data;
      const rows = found
        ? live
            .torrents()
            .filter((t) => found.has(t.hash))
            .sort((a, b) => a.name.localeCompare(b.name))
        : [];
      const gone = (removed.data ?? []).filter((r) => !live.state.torrents[r.hash]);
      const items: Item[] = [
        ...rows.slice(0, limit()).map((t): Item => ({ kind: "torrent", id: `t:${t.hash}`, t })),
        ...gone
          .slice(0, scope() === "everything" ? 2 : limit())
          .map((r): Item => ({ kind: "removed", id: `r:${r.hash}`, r })),
      ];
      if (rows.length > 0) items.push({ kind: "all", id: "all", words: w, count: rows.length });
      if (items.length > 0)
        out.push({ label: "Torrents", count: rows.length + gone.length, items });
    }
    if (wants("files") && typed && files.data && files.data.total > 0) {
      out.push({
        label: "Files",
        count: files.data.total,
        request: `GET /torrents/files?search=${w}`,
        items: files.data.files.map((f): Item => ({
          kind: "file",
          id: `f:${f.hash}:${f.index}`,
          f,
        })),
      });
    }
    if (wants("commands")) {
      const found = props.commands.filter((c) => commandMatches(c, w));
      const shown = scope() === "everything" && w !== "" ? found.slice(0, limit()) : found;
      if (shown.length > 0) {
        out.push({
          label: "Commands",
          count: found.length,
          items: shown.map((c): Item => ({ kind: "command", id: `c:${c.id}`, c })),
        });
      }
    }
    return out;
  });
  const flat = createMemo(() => groups().flatMap((g) => g.items));
  const position = createMemo(() => new Map(flat().map((it, i) => [it.id, i])));
  createEffect(on(flat, () => setActive(0), { defer: true }));

  const openInStats = (hash: string) => navigate(`/stats/timeline?hash=${hash}`);
  const run = (item: Item | undefined, stats: boolean) => {
    if (!item) return;
    props.onClose();
    switch (item.kind) {
      case "torrent":
        if (stats) openInStats(item.t.hash);
        else navigate(`/torrents/${item.t.hash}`);
        break;
      case "removed":
        openInStats(item.r.hash);
        break;
      case "all":
        navigate(`/torrents?q=${encodeURIComponent(item.words)}`);
        break;
      case "file":
        if (stats) openInStats(item.f.hash);
        else navigate(`/torrents/${item.f.hash}?tab=files`);
        break;
      case "command":
        item.c.run();
        break;
    }
  };

  let list: HTMLDivElement | undefined;
  const move = (by: number) => {
    const n = flat().length;
    if (n === 0) return;
    setActive((i) => (i + by + n) % n);
    list?.querySelector(`[data-index="${active()}"]`)?.scrollIntoView({ block: "nearest" });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "Enter") run(flat()[active()], e.metaKey || e.ctrlKey);
    else if (e.key === "Tab") {
      const next = cycleScope(scope(), e.shiftKey);
      setChosen(next);
      // A prefix would win over the choice: drop it.
      if (scope() !== next) setText(words());
    } else return;
    e.preventDefault();
  };

  const instance = () => {
    const s = auth.state();
    return s.kind === "signed-in" ? (s.app.instance_name ?? "urtorrentd") : "urtorrentd";
  };
  const empty = () => {
    if (flat().length > 0) return null;
    if (words() === "") {
      return scope() === "files"
        ? "Type words of a file's path; * and ? are wildcards."
        : "Type a name, a category, a tag, a tracker or the start of an info-hash.";
    }
    return words() === settled() ? `Nothing found for “${words()}”.` : "Searching…";
  };
  return (
    <>
      <div class="flex h-[52px] flex-none items-center gap-2.5 border-b border-divider px-4">
        <Search size={16} class="flex-none text-subtle" />
        <input
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-results"
          aria-activedescendant={flat()[active()] ? `palette-${active()}` : undefined}
          aria-label="Search torrents, files and commands"
          class="min-w-0 flex-1 bg-transparent text-[14px] text-foreground outline-none placeholder:text-subtle"
          placeholder="Search torrents, files and commands"
          spellcheck={false}
          autocomplete="off"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={onKeyDown}
          autofocus
        />
        <Kbd>esc</Kbd>
      </div>
      <div class="flex flex-none flex-wrap items-center gap-1 border-b border-divider px-3 py-2">
        <div role="radiogroup" aria-label="Search in" class="flex gap-1">
          <For each={SCOPES}>
            {(s) => (
              <button
                type="button"
                role="radio"
                aria-checked={scope() === s.value}
                class={cn(
                  "inline-flex h-6 items-center gap-1.5 rounded-md border border-border px-2 text-xs font-medium whitespace-nowrap",
                  scope() === s.value
                    ? "border-highlight bg-highlight text-foreground"
                    : "text-foreground-2 hover:bg-accent hover:text-foreground",
                )}
                onClick={() => {
                  setChosen(s.value);
                  setText(words());
                }}
              >
                {s.label}
                <Show when={s.prefix}>
                  <span class="text-subtle" aria-hidden="true">
                    {s.prefix}
                  </span>
                </Show>
              </button>
            )}
          </For>
        </div>
        <span class="flex-1" />
        <span class="text-sm text-subtle max-sm:hidden">
          wildcards <span class="mono">* ?</span> in file search
        </span>
      </div>
      <div
        ref={list}
        id="palette-results"
        role="listbox"
        aria-label="Results"
        class="flex max-h-[440px] min-h-0 flex-col overflow-auto p-1.5"
      >
        <For each={groups()}>
          {(g, gi) => (
            <div role="group" aria-label={g.label}>
              <div
                class={cn(
                  "flex gap-2 px-3 pb-1 text-xs text-subtle",
                  gi() === 0 ? "pt-2" : "pt-2.5",
                )}
                aria-hidden="true"
              >
                <span>
                  {g.label}
                  <Show when={g.count !== undefined}> · {formatCount(g.count ?? 0)}</Show>
                </span>
                <Show when={g.request}>
                  <span class="truncate mono">{g.request}</span>
                </Show>
              </div>
              <For each={g.items}>
                {(item) => {
                  const i = () => position().get(item.id) ?? 0;
                  return (
                    <Row
                      item={item}
                      index={i()}
                      active={active() === i()}
                      words={words()}
                      onHover={() => setActive(i())}
                      onRun={(stats) => run(item, stats)}
                    />
                  );
                }}
              </For>
            </div>
          )}
        </For>
        <Show when={empty()}>
          {(m) => <p class="m-0 px-3 py-6 text-center text-sm text-subtle">{m()}</p>}
        </Show>
      </div>
      <div class="flex h-[34px] flex-none items-center gap-3 border-t border-divider px-3.5 text-xs text-subtle">
        <span class="flex items-center gap-1 max-sm:hidden">
          <Kbd>↑↓</Kbd> move
        </span>
        <span class="flex items-center gap-1">
          <Kbd>↵</Kbd> open
        </span>
        <span class="flex items-center gap-1 max-sm:hidden">
          <Kbd>{mod()}↵</Kbd> open in Stats
        </span>
        <span class="flex-1" />
        <span class="truncate">
          {instance()} · {formatCount(live.torrents().length)}{" "}
          {live.torrents().length === 1 ? "torrent" : "torrents"}
          <Show when={indexed.data}>{(d) => <> · {formatCount(d().total)} files indexed</>}</Show>
        </span>
      </div>
    </>
  );
}

function Marked(props: { text: string; words: string; class?: string }) {
  return (
    <For each={highlight(props.text, props.words)}>
      {(p) => (p.match ? <span class="font-medium text-foreground">{p.text}</span> : p.text)}
    </For>
  );
}

function Row(props: {
  item: Item;
  index: number;
  active: boolean;
  words: string;
  onHover: () => void;
  onRun: (stats: boolean) => void;
}): JSX.Element {
  // Captions on the chosen row are lighter: the design's grey fails AA on it.
  const sub = () => cn("text-xs", props.active ? "text-muted-foreground" : "text-subtle");
  const body = (): { icon: JSX.Element; main: JSX.Element; right: JSX.Element } => {
    const it = props.item;
    switch (it.kind) {
      case "torrent": {
        const look = stateLook(it.t);
        return {
          icon: (
            <ProgressRing
              progress={it.t.has_metadata ? it.t.progress : 0}
              class={toneStroke[look.tone]}
            />
          ),
          main: (
            <>
              <Marked text={it.t.name} words={props.words} />{" "}
              <span class={sub()}>
                · {look.label.toLowerCase()}
                {it.t.complete ? "" : ` ${formatPercent(it.t.progress)}`}
                {it.t.category ? ` · ${it.t.category}` : ""}
              </span>
            </>
          ),
          right: props.active ? <Kbd>↵ open</Kbd> : null,
        };
      }
      case "removed":
        return {
          icon: <ProgressRing progress={1} class="stroke-faint" />,
          main: (
            <>
              <Marked text={it.r.name ?? it.r.hash} words={props.words} />{" "}
              <span class={sub()}>· removed {formatShortDate(it.r.removed)} · history only</span>
            </>
          ),
          right: <span class={sub()}>Stats</span>,
        };
      case "all":
        return {
          icon: <Search size={14} class="text-subtle" />,
          main: (
            <>
              Show the {formatCount(it.count)} in the list{" "}
              <span class={sub()}>· torrents matching “{it.words}”</span>
            </>
          ),
          right: props.active ? <Kbd>↵ filter</Kbd> : null,
        };
      case "file":
        return {
          icon: <FileIcon size={14} class="text-subtle" />,
          main: (
            <span class="mono text-sm">
              <Marked text={it.f.path} words={props.words} />{" "}
              <span class={sub()}>
                · {formatBytes(it.f.size)} ·{" "}
                {it.f.priority === 0 ? "skipped" : formatPercent(it.f.progress)} · in {it.f.torrent}
              </span>
            </span>
          ),
          right: <span class={sub()}>Files tab</span>,
        };
      case "command":
        return {
          icon: <ChevronRight size={14} class="text-subtle" />,
          main: (
            <>
              {it.c.label}
              <Show when={it.c.sub}>
                {" "}
                <span class={sub()}>{it.c.sub}</span>
              </Show>
            </>
          ),
          right: it.c.key ? <Kbd>{it.c.key}</Kbd> : null,
        };
    }
  };
  const b = createMemo(body);
  return (
    <div
      id={`palette-${props.index}`}
      data-index={props.index}
      role="option"
      aria-selected={props.active}
      class={cn(
        "grid h-[38px] flex-none cursor-pointer grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-2.5 rounded-lg px-3 text-base text-foreground-2",
        props.active && "bg-highlight text-foreground",
      )}
      onPointerMove={() => props.onHover()}
      onClick={(e) => props.onRun(e.metaKey || e.ctrlKey)}
    >
      <span class="flex items-center justify-center">{b().icon}</span>
      <span class="truncate">{b().main}</span>
      <span class="flex items-center">{b().right}</span>
    </div>
  );
}
