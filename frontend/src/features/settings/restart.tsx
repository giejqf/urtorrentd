// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// "N settings apply after a restart", and the restart itself
// (`POST /app/restart`): the daemon stops gracefully and starts again in
// place. Login sessions live in its memory, so the page signs in again.

import { useQueryClient } from "@tanstack/solid-query";
import { createSignal, Show } from "solid-js";
import { Portal } from "solid-js/web";
import { toast } from "solid-sonner";

import { api, ApiError, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
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
import { useAuth } from "~/features/auth/auth";

import { useAppInfo } from "./app-info";

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

// One confirmation for every page: the banner's button, Engine and About.
const [confirm, setConfirm] = createSignal(false);

/** Ask to restart the daemon now (the frame confirms, then restarts). */
export function askRestart() {
  setConfirm(true);
}

export function RestartBanner() {
  const app = useAppInfo();
  const auth = useAuth();
  const client = useQueryClient();
  const [restarting, setRestarting] = createSignal(false);
  const pending = () => app.data?.restart_required ?? [];

  const restart = async () => {
    setConfirm(false);
    const before = app.data?.started_at ?? 0;
    try {
      await unwrap(api.POST("/api/v1/app/restart"));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The daemon did not restart.");
      return;
    }
    setRestarting(true);
    // Wait for the daemon to go and come back (a minute at most).
    const deadline = Date.now() + 60_000;
    let away = false;
    while (Date.now() < deadline) {
      await sleep(500);
      const status = await fetch("/api/v1/auth/status").catch(() => null);
      if (!status?.ok) {
        away = true;
        continue;
      }
      const a = await fetch("/api/v1/app").catch(() => null);
      if (a?.status === 401) break; // back, and the session is gone
      if (a?.ok) {
        const info = (await a.json()) as { started_at: number; restart_required: string[] };
        if (away || info.started_at !== before || info.restart_required.length === 0) break;
      }
    }
    setRestarting(false);
    await client.invalidateQueries({ queryKey: keys.app() });
    await client.invalidateQueries({ queryKey: keys.settings() });
    await auth.sessionEnded();
    if (auth.state().kind === "signed-in") toast.success("The daemon restarted.");
  };

  return (
    <>
      <Show when={pending().length > 0}>
        <div
          role="status"
          class="flex h-[30px] items-center gap-2 rounded-md border border-warn/35 bg-warn/8 pr-1 pl-2.5 text-sm text-foreground"
        >
          <StatusDot class="bg-warn" />
          <span title={pending().join(", ")}>
            {pending().length === 1
              ? "1 setting applies after a restart"
              : `${pending().length} settings apply after a restart`}
          </span>
          <Button
            variant="outline"
            size="sm"
            class="ml-1.5 h-[22px] px-2 text-xs"
            onClick={() => setConfirm(true)}
          >
            Restart daemon
          </Button>
        </div>
      </Show>
      <AlertDialog open={confirm()} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restart the daemon?</AlertDialogTitle>
            <AlertDialogDescription>
              Every torrent stops for a few seconds while urtorrentd saves its state and starts
              again, and you sign in again.
              <Show when={pending().length > 0}> It applies: {pending().join(", ")}.</Show>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose as={Button} variant="outline" aria-label="Cancel">
              Cancel
            </AlertDialogClose>
            <Button onClick={() => void restart()}>Restart</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Show when={restarting()}>
        <Portal>
          <div
            role="status"
            class="fixed inset-0 z-[60] flex items-center justify-center bg-overlay text-base text-foreground"
          >
            Restarting the daemon…
          </div>
        </Portal>
      </Show>
    </>
  );
}
