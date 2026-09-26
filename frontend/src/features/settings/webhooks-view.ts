// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// What the Webhooks page says about a webhook: its URL as a list shows it
// (webhook URLs often carry a token, so the list shows the origin only),
// its health from the last delivery, a delivery in a line, a new signing
// secret, and a payload's JSON split for colouring (as text, never HTML).
// Pure and tested.

import type { Schemas } from "~/api/client";
import { formatAgo } from "~/lib/format";

type Webhook = Schemas["Webhook"];
type Delivery = Schemas["WebhookDelivery"];

/** The events a webhook can ask for (`test` is always delivered). */
export const EVENTS: Schemas["WebhookEvent"][] = [
  "added",
  "metadata",
  "finished",
  "moved",
  "error",
  "removed",
];

/** The URL as lists show it: its origin, the rest elided. */
export function shownUrl(url: string): string {
  try {
    const u = new URL(url);
    const rest = u.pathname !== "/" || u.search !== "";
    return `${u.origin}${rest ? "/…" : "/"}`;
  } catch {
    return url;
  }
}

export function webhookName(h: Pick<Webhook, "name" | "url">): string {
  if (h.name) return h.name;
  try {
    return new URL(h.url).host;
  } catch {
    return h.url;
  }
}

export type Health = { label: string; tone: "ok" | "danger" | "subtle" };

export function health(h: Pick<Webhook, "enabled" | "deliveries">): Health {
  if (!h.enabled) return { label: "disabled", tone: "subtle" };
  const last = h.deliveries[0];
  if (!last) return { label: "no delivery yet", tone: "subtle" };
  return last.error === null
    ? { label: "healthy", tone: "ok" }
    : { label: "failing", tone: "danger" };
}

/** A delivery's answer: the status code, or "no answer". */
export function answer(d: Pick<Delivery, "status">): string {
  return d.status === null ? "no answer" : String(d.status);
}

/** The last delivery in a line: `finished · 200 · 2h ago`. */
export function lastLine(h: Pick<Webhook, "deliveries">, now: number): string {
  const d = h.deliveries[0];
  if (!d) return "—";
  const tries = d.attempts > 1 ? ` · ${d.attempts} attempts` : "";
  return `${d.event} · ${answer(d)}${tries} · ${formatAgo(d.time, now)}`;
}

/** A new signing secret: 32 random bytes as hex. */
export function newSecret(
  random: (bytes: Uint8Array) => void = (b) => crypto.getRandomValues(b),
): string {
  const bytes = new Uint8Array(32);
  random(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export type JsonPart = { text: string; kind: "key" | "string" | "number" | "literal" | "plain" };

/** Pretty JSON cut into parts to colour: keys, strings, numbers, literals. */
export function jsonParts(value: unknown): JsonPart[] {
  const text = JSON.stringify(value, null, 2);
  const parts: JsonPart[] = [];
  const re = /("(?:\\.|[^"\\])*")(\s*:)?|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|\b(true|false|null)\b/g;
  let at = 0;
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index), kind: "plain" });
    if (m[1] !== undefined) {
      parts.push({ text: m[1], kind: m[2] ? "key" : "string" });
      if (m[2]) parts.push({ text: m[2], kind: "plain" });
    } else if (m[3] !== undefined) parts.push({ text: m[3], kind: "number" });
    else parts.push({ text: m[0], kind: "literal" });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at), kind: "plain" });
  return parts;
}
