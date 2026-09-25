// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The signed-in app: sign-in or setup when there is no session, an
// explanation when the daemon cannot be reached, otherwise the shell
// (sidebar and page) over the live store.

import { Navigate, type RouteSectionProps, useLocation } from "@solidjs/router";
import {
  createContext,
  createSignal,
  Match,
  type ParentComponent,
  Show,
  Switch,
  useContext,
} from "solid-js";

import { LogoMark } from "~/components/logo";
import { Button } from "~/components/ui/button";
import { Sheet, SheetContent, SheetTitle } from "~/components/ui/sheet";
import { useAuth } from "~/features/auth/auth";
import { SettingsNav } from "~/features/settings/nav";

import { LiveProvider } from "./live";
import { Sidebar } from "./sidebar";

interface Shell {
  /** Open the sidebar (a sheet on narrow screens). */
  openNav: () => void;
}

const ShellContext = createContext<Shell>({ openNav: () => undefined });

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
  const location = useLocation();
  const inSettings = () => location.pathname.startsWith("/settings");
  return (
    <ShellContext.Provider value={{ openNav: () => setNavOpen(true) }}>
      <div class="flex h-full overflow-hidden bg-background">
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
        <div class="flex min-w-0 flex-1">{props.children}</div>
      </div>
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
