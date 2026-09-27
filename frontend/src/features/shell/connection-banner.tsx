// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Not designed: what the page says while the event stream is down. The
// figures on screen are the daemon's last update, so the bar says when that
// was (rule 2: nothing on screen claims to be live when it is not). A drop
// shorter than two seconds (the browser reconnecting) shows nothing.

import { createEffect, createSignal, on, onCleanup, Show } from "solid-js";

import { StatusDot } from "~/components/status-dot";
import { Button } from "~/components/ui/button";
import { formatTime } from "~/lib/format";

import { useLive } from "./live";

const GRACE_MS = 2_000;

export function ConnectionBanner() {
  const live = useLive();
  const [shown, setShown] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const down = () => {
    const c = live.connection();
    return live.ready() && (c === "reconnecting" || c === "stopped");
  };
  createEffect(
    on(down, (d) => {
      clearTimeout(timer);
      if (!d) setShown(false);
      else timer = setTimeout(() => setShown(true), GRACE_MS);
    }),
  );
  onCleanup(() => clearTimeout(timer));
  const since = () => {
    const at = live.updatedAt();
    return at === null ? null : formatTime(Math.floor(at / 1000));
  };
  return (
    <Show when={shown()}>
      <div
        role="status"
        class="flex min-h-9 flex-none flex-wrap items-center gap-x-3 gap-y-1 border-b border-warn/40 bg-warn/8 px-4 py-1.5 text-sm"
      >
        <span class="flex items-center gap-2 font-medium">
          <StatusDot class="bg-warn motion-safe:animate-pulse" />
          {live.connection() === "stopped"
            ? "The daemon cannot be reached"
            : "Reconnecting to the daemon…"}
        </span>
        <span class="text-muted-foreground">
          What is shown is as of {since()}; it updates again once the daemon answers.
        </span>
        <span class="flex-1" />
        <Button variant="outline" size="sm" class="h-7" onClick={() => live.reconnect()}>
          Try now
        </Button>
      </div>
    </Show>
  );
}
