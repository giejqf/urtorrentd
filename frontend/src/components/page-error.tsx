// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Not designed: what shows when a page fails to render, in the style of the
// sign-in card, instead of a blank window. A chunk that no longer loads
// means the daemon now serves a newer build of the UI, and a reload fixes
// it. Moving to another page tries again.

import { useLocation } from "@solidjs/router";
import { createEffect, on, Show } from "solid-js";

import { Button } from "~/components/ui/button";

const STALE_BUILD =
  /dynamically imported module|Importing a module script failed|error loading dynamically/i;

export function PageError(props: { error: unknown; reset: () => void }) {
  const location = useLocation();
  createEffect(
    on(
      () => location.pathname,
      () => props.reset(),
      { defer: true },
    ),
  );
  const message = () => (props.error instanceof Error ? props.error.message : String(props.error));
  const stale = () => STALE_BUILD.test(message());
  return (
    <div class="flex h-full min-w-0 flex-1 items-center justify-center bg-background p-4">
      <section
        role="alert"
        class="flex w-full max-w-[440px] flex-col items-start gap-4 rounded-card border border-border bg-card p-8 shadow-card"
      >
        <div class="flex flex-col gap-1">
          <h1 class="m-0 text-xl font-semibold tracking-[-0.01em]">
            {stale() ? "The web UI was updated" : "This page failed"}
          </h1>
          <p class="m-0 text-base text-muted-foreground">
            {stale()
              ? "The daemon now serves a newer version of the UI. Reload to use it."
              : "The UI hit an error it did not expect. Reload, or go to another page."}
          </p>
        </div>
        <Show when={!stale()}>
          <pre class="m-0 max-h-40 w-full overflow-auto rounded-md border border-divider bg-background p-3 mono text-xs break-words whitespace-pre-wrap text-subtle">
            {message()}
          </pre>
        </Show>
        <div class="flex gap-2">
          <Button onClick={() => window.location.reload()}>Reload</Button>
          <Show when={!stale()}>
            <Button variant="outline" onClick={() => props.reset()}>
              Try again
            </Button>
          </Show>
        </div>
      </section>
    </div>
  );
}
