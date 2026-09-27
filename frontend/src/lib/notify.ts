// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Browser notifications when a download finishes: the viewer's opt-in
// (kept with the look, lib/theme.ts), and the browser's permission, which
// only a secure page (HTTPS or localhost) can ask for.

import type { Schemas } from "~/api/client";

import { notifyChoice } from "./theme";

/** Whether this browser can show notifications for this page at all. */
export function canNotify(): boolean {
  return window.isSecureContext && "Notification" in window;
}

/** Ask the browser; true once it allows them. */
export async function askToNotify(): Promise<boolean> {
  if (!canNotify()) return false;
  if (Notification.permission === "granted") return true;
  return (await Notification.requestPermission()) === "granted";
}

/** Tell the viewer, when chosen and allowed, that these finished. */
export function notifyFinished(done: readonly Schemas["TorrentSummary"][]): void {
  if (done.length === 0 || notifyChoice() !== "on" || !canNotify()) return;
  if (Notification.permission !== "granted") return;
  for (const t of done.slice(0, 5)) {
    // The name is text in a system notification, never markup.
    new Notification("Download finished", { body: t.name, tag: t.hash });
  }
  if (done.length > 5) {
    new Notification("Downloads finished", { body: `and ${done.length - 5} more` });
  }
}
