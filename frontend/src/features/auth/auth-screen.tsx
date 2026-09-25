// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The sign-in design's frame (AGENTS.md 6.2): a 400px card on a 48px grid
// that fades into the background. Setup uses it too. No instance name or
// version here: before sign-in the daemon tells nobody what it runs
// (maintainer decision, 2026-09-24).

import { type JSX, type ParentComponent, Show } from "solid-js";

import { LogoMark } from "~/components/logo";
import { StatusDot } from "~/components/status-dot";

import { useAuth } from "./auth";

/** Whether the daemon answered, from the public `GET /auth/status`. */
export function Reachability() {
  const auth = useAuth();
  const state = () => auth.state().kind;
  return (
    <div class="flex items-center gap-2 text-sm text-muted-foreground" role="status">
      <Show
        when={state() !== "unreachable"}
        fallback={
          <>
            <StatusDot small class="bg-danger" />
            <span>Daemon unreachable</span>
          </>
        }
      >
        <StatusDot small class={state() === "loading" ? "bg-warn" : "bg-online"} />
        <span>{state() === "loading" ? "Contacting the daemon…" : "Daemon reachable"}</span>
      </Show>
    </div>
  );
}

export const AuthScreen: ParentComponent<{
  title: string;
  onSubmit: (e: SubmitEvent) => void;
  footer?: JSX.Element;
}> = (props) => (
  <div class="relative flex min-h-full items-center justify-center overflow-hidden bg-background px-4 py-16">
    <div aria-hidden="true" class="absolute inset-0 auth-grid" />
    <main class="relative w-full max-w-[400px]">
      <form
        class="flex flex-col gap-6 rounded-card border border-border bg-card p-8 shadow-card"
        onSubmit={(e) => {
          e.preventDefault();
          props.onSubmit(e);
        }}
        noValidate
      >
        <div class="flex flex-col items-start gap-3.5">
          <LogoMark large />
          <div class="flex flex-col gap-1">
            <h1 class="m-0 text-xl font-semibold tracking-[-0.01em]">{props.title}</h1>
            <Reachability />
          </div>
        </div>
        {props.children}
      </form>
    </main>
    <footer class="absolute bottom-6 flex gap-4 mono text-xs text-subtle">
      <span>urtorrentd</span>
      <span aria-hidden="true">·</span>
      <span>Apache-2.0</span>
    </footer>
  </div>
);

/** A form's error line, announced when it appears. */
export function FormError(props: { message: string | null }) {
  return (
    <Show when={props.message}>
      <p role="alert" class="m-0 -mt-2 text-sm text-danger">
        {props.message}
      </p>
    </Show>
  );
}
