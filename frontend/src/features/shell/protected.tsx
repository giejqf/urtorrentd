// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The signed-in app: sign-in or setup when there is no session, an
// explanation when the daemon cannot be reached, otherwise the shell
// (sidebar and page) over the live store, with a bar while its stream is
// down.

import { Navigate, type RouteSectionProps, useLocation, useSearchParams } from "@solidjs/router";
import {
  createContext,
  createEffect,
  createSignal,
  ErrorBoundary,
  Match,
  on,
  onCleanup,
  onMount,
  type ParentComponent,
  Show,
  Switch,
  useContext,
} from "solid-js";

import { toast } from "solid-sonner";

import { LogoMark } from "~/components/logo";
import { PageError } from "~/components/page-error";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import { useAuth } from "~/features/auth/auth";
import { SettingsNav } from "~/features/settings/nav";
import { AddDialog } from "~/features/torrents/add/add-dialog";
import { parseSources } from "~/features/torrents/add/form";
import { formatRate } from "~/lib/format";
import { torrentFiles } from "~/lib/magnets";
import { useNarrow } from "~/lib/use-wide";

import { ConnectionBanner } from "./connection-banner";
import { LiveProvider, useLive } from "./live";
import { CommandPalette } from "./palette";
import { isOpenModal, isTyping } from "./palette-view";
import { TabBar } from "./tab-bar";
import { Sidebar } from "./sidebar";

/** What the add dialog starts from. */
export interface AddSeed {
  links?: string;
  files?: readonly File[];
}

interface Shell {
  /** Open the sidebar (a sheet on narrow screens). */
  openNav: () => void;
  /** Open the add dialog, from any page, maybe with sources. */
  openAdd: (seed?: AddSeed) => void;
  /** Open the command palette (⌘K). */
  openPalette: () => void;
}

const ShellContext = createContext<Shell>({
  openNav: () => undefined,
  openAdd: () => undefined,
  openPalette: () => undefined,
});

export function useShell(): Shell {
  return useContext(ShellContext);
}

function Unreachable() {
  const auth = useAuth();
  const text = () => {
    const s = auth.state();
    return s.kind === "unreachable" ? s.message : "";
  };
  return (
    <div class="flex h-full items-center justify-center bg-background p-4">
      <main class="flex w-full max-w-[400px] flex-col items-start gap-4 rounded-card border border-border bg-card p-8 shadow-card">
        <LogoMark large />
        <div class="flex flex-col gap-1">
          <h1 class="m-0 text-xl font-semibold tracking-[-0.01em]">Daemon unreachable</h1>
          <p class="m-0 text-base text-muted-foreground" role="status">
            {text()}
          </p>
        </div>
        <Button variant="outline" onClick={() => void auth.refresh()}>
          Try again
        </Button>
      </main>
    </div>
  );
}

const ShellLayout: ParentComponent = (props) => {
  const [navOpen, setNavOpen] = createSignal(false);
  const [adding, setAdding] = createSignal<AddSeed | null>(null);
  const [dropping, setDropping] = createSignal(false);
  const [palette, setPalette] = createSignal(false);
  const location = useLocation();
  const inSettings = () => location.pathname.startsWith("/settings");
  const narrow = useNarrow();
  // A phone shows one torrent full screen, with its own actions below.
  const detailOpen = () => /^\/torrents\/[0-9a-f]{40}/.test(location.pathname);
  const shell: Shell = {
    openNav: () => setNavOpen(true),
    openAdd: (seed) => setAdding(seed ?? {}),
    openPalette: () => setPalette(true),
  };
  // The tab's title: the session's rates, then the instance (qBittorrent's
  // WebUI does the same), so a tab in the background still says them.
  const live = useLive();
  const auth = useAuth();
  createEffect(() => {
    const a = auth.state();
    const name = a.kind === "signed-in" ? (a.app.instance_name ?? "urtorrentd") : "urtorrentd";
    const t = live.state.transfer;
    document.title =
      t && live.connection() === "live"
        ? `↓ ${formatRate(t.download_rate)} ↑ ${formatRate(t.upload_rate)} · ${name}`
        : name;
  });
  onCleanup(() => {
    document.title = "urtorrentd";
  });

  // Sources from anywhere on the page: a magnet link the browser hands over
  // (`?add=`, taken out of the address at once: it can carry a passkey), a
  // pasted link or `.torrent` file, a dropped one.
  const [params, setParams] = useSearchParams<{ add?: string }>();
  createEffect(
    on(
      () => params.add,
      (link) => {
        if (!link) return;
        setParams({ add: undefined }, { replace: true });
        shell.openAdd({ links: link });
      },
    ),
  );
  const onPaste = (e: ClipboardEvent) => {
    if (isTyping(e.target) || isOpenModal()) return;
    const files = torrentFiles(e.clipboardData?.files);
    const text = e.clipboardData?.getData("text/plain").trim() ?? "";
    if (files.length > 0) shell.openAdd({ files });
    else if (text !== "" && parseSources(text).sources.length > 0) shell.openAdd({ links: text });
    else return;
    e.preventDefault();
  };
  onMount(() => document.addEventListener("paste", onPaste));
  onCleanup(() => document.removeEventListener("paste", onPaste));
  const carries = (e: DragEvent) =>
    !isOpenModal() &&
    [...(e.dataTransfer?.types ?? [])].some((t) => t === "Files" || t === "text/uri-list");
  const drop = (e: DragEvent) => {
    setDropping(false);
    if (!carries(e)) return;
    e.preventDefault();
    const files = torrentFiles(e.dataTransfer?.files);
    const text =
      (e.dataTransfer?.getData("text/uri-list") || e.dataTransfer?.getData("text/plain")) ?? "";
    if (files.length > 0) shell.openAdd({ files });
    else if (parseSources(text).sources.length > 0) shell.openAdd({ links: text.trim() });
    else toast.error("Only .torrent files, magnet links and torrent URLs can be added.");
  };

  return (
    <ShellContext.Provider value={shell}>
      <div
        class="relative flex h-full overflow-hidden bg-background pt-[env(safe-area-inset-top)]"
        onDragOver={(e) => {
          if (!carries(e)) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (e.relatedTarget === null) setDropping(false);
        }}
        onDrop={drop}
      >
        <Show when={dropping()}>
          <div
            class="pointer-events-none absolute inset-0 z-40 flex items-center justify-center bg-overlay p-6"
            aria-hidden="true"
          >
            <div class="rounded-card border border-dashed border-border-strong bg-card px-8 py-6 text-center shadow-card">
              <div class="text-md font-semibold">Drop to add</div>
              <div class="text-sm text-subtle">.torrent files, magnet links or torrent URLs</div>
            </div>
          </div>
        </Show>
        <Show
          when={inSettings()}
          fallback={<Sidebar class="hidden w-56 flex-none border-r border-divider lg:flex" />}
        >
          <SettingsNav class="hidden w-56 flex-none border-r border-divider lg:flex" />
        </Show>
        <Sheet open={navOpen()} onOpenChange={setNavOpen}>
          <SheetContent position="left" class="w-60 p-0">
            <SheetTitle class="sr-only">Navigation</SheetTitle>
            <Show
              when={inSettings()}
              fallback={<Sidebar class="flex h-full" onNavigate={() => setNavOpen(false)} />}
            >
              <SettingsNav class="flex h-full" onNavigate={() => setNavOpen(false)} />
            </Show>
          </SheetContent>
        </Sheet>
        <div class="flex min-w-0 flex-1 flex-col">
          <ConnectionBanner />
          {/* Focusable, so focus has a place to go when a dialog closes. */}
          <div id="content" tabindex="-1" class="flex min-h-0 min-w-0 flex-1 outline-none">
            <ErrorBoundary fallback={(error, reset) => <PageError error={error} reset={reset} />}>
              {props.children}
            </ErrorBoundary>
          </div>
          <Show when={narrow() && !detailOpen()}>
            <TabBar />
          </Show>
        </div>
      </div>
      <AddDialog
        open={adding() !== null}
        links={adding()?.links}
        files={adding()?.files}
        onClose={() => setAdding(null)}
      />
      <CommandPalette open={palette()} onOpenChange={setPalette} />
    </ShellContext.Provider>
  );
};

export default function Protected(props: RouteSectionProps) {
  const auth = useAuth();
  const location = useLocation();
  const target = () => {
    const s = auth.state();
    if (s.kind === "signed-out" && s.setupRequired) return "/setup";
    const next = encodeURIComponent(location.pathname + location.search);
    return `/sign-in?next=${next}`;
  };
  return (
    <Switch>
      <Match when={auth.state().kind === "unreachable"}>
        <Unreachable />
      </Match>
      <Match when={auth.state().kind === "signed-out"}>
        <Navigate href={target()} />
      </Match>
      <Match when={auth.state().kind === "signed-in"}>
        <LiveProvider>
          <ShellLayout>{props.children}</ShellLayout>
        </LiveProvider>
      </Match>
    </Switch>
  );
}
