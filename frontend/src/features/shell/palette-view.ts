// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The command palette's pure parts (AGENTS.md 6.4): the scope a query asks
// for, the parts of a name a query matches, and which commands it finds.

export type Scope = "everything" | "torrents" | "files" | "commands";

export const SCOPES: readonly { value: Scope; label: string; prefix: string | null }[] = [
  { value: "everything", label: "Everything", prefix: null },
  { value: "torrents", label: "Torrents", prefix: "t" },
  { value: "files", label: "Files", prefix: "f" },
  { value: "commands", label: "Commands", prefix: ">" },
];

/**
 * A query with its scope: `>` first asks for commands, and `t ` or `f ` (the
 * letter, then a space) for torrents or files. Otherwise the chosen scope.
 */
export function parseQuery(text: string, chosen: Scope): { scope: Scope; words: string } {
  if (text.startsWith(">")) return { scope: "commands", words: text.slice(1).trim() };
  const m = /^([tf]) (.*)$/s.exec(text);
  if (m) return { scope: m[1] === "t" ? "torrents" : "files", words: (m[2] ?? "").trim() };
  return { scope: chosen, words: text.trim() };
}

/** The next scope (Tab) or the one before (Shift+Tab). */
export function cycleScope(scope: Scope, back: boolean): Scope {
  const i = SCOPES.findIndex((s) => s.value === scope);
  const n = SCOPES.length;
  return SCOPES[(i + (back ? n - 1 : 1)) % n]?.value ?? "everything";
}

export interface Part {
  text: string;
  match: boolean;
}

/**
 * A text cut where the query's words are found (case ignored; a word's `*`
 * and `?` are wildcards, so such a word is not marked). Presentation only:
 * what matched was the daemon's to say.
 */
export function highlight(text: string, query: string): Part[] {
  const lower = text.toLowerCase();
  const marks: [number, number][] = [];
  for (const w of query.toLowerCase().split(/\s+/)) {
    if (w === "" || /[*?]/.test(w)) continue;
    const at = lower.indexOf(w);
    if (at >= 0) marks.push([at, at + w.length]);
  }
  marks.sort((a, b) => a[0] - b[0]);
  const parts: Part[] = [];
  let pos = 0;
  for (const [a, b] of marks) {
    const from = Math.max(a, pos);
    if (from >= b) continue;
    if (from > pos) parts.push({ text: text.slice(pos, from), match: false });
    const last = parts[parts.length - 1];
    if (last?.match && from === pos) last.text += text.slice(from, b);
    else parts.push({ text: text.slice(from, b), match: true });
    pos = b;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos), match: false });
  return parts;
}

export interface CommandText {
  label: string;
  /** Other words it is found by. */
  keywords?: string;
}

/** Whether every word of the query is in a command's label or keywords. */
export function commandMatches(c: CommandText, query: string): boolean {
  const hay = `${c.label} ${c.keywords ?? ""}`.toLowerCase();
  return query
    .toLowerCase()
    .split(/\s+/)
    .every((w) => w === "" || hay.includes(w));
}

/** Whether a key press is typing: in a field, or with a modifier other than Shift. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/** Whether a dialog is open: the page's own keys, paste and drop wait. */
export function isOpenModal(): boolean {
  return document.querySelector('[role="dialog"], [role="alertdialog"]') !== null;
}
