// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// How the page looks, as the viewer chooses (AGENTS.md 6.2): the theme
// (dark, light, or the system's), the accent (the colour of downloads and
// progress) and the units of sizes and rates; and whether finished
// downloads notify (lib/notify.ts). Each choice is kept in this
// browser (so the sign-in page and the first paint have it) and by the
// daemon with the other UI preferences (`/client-data`, so it follows the
// user); after sign-in the daemon's wins. `data-theme` and `data-accent` on
// <html> select the tokens in app.css.

import { createEffect, createRoot, createSignal, on } from "solid-js";

import { api, unwrap } from "~/api/client";

import { setBinaryUnits } from "./units";

export type ThemeChoice = "system" | "dark" | "light";
export type Theme = "dark" | "light";
export type Accent = "blue" | "green" | "violet" | "orange";
export type Units = "decimal" | "binary";
export type Notify = "on" | "off";

/** The choices, as menus name them. */
export const THEME_CHOICES: readonly { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Match the system" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];
export const ACCENTS: readonly { value: Accent; label: string }[] = [
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
  { value: "violet", label: "Violet" },
  { value: "orange", label: "Orange" },
];
export const UNITS: readonly { value: Units; label: string }[] = [
  { value: "decimal", label: "Decimal (MB, GB)" },
  { value: "binary", label: "Binary (MiB, GiB)" },
];

const oneOf =
  <T extends string>(values: readonly { value: T }[]) =>
  (v: unknown): v is T =>
    values.some((x) => x.value === v);
export const isThemeChoice = oneOf(THEME_CHOICES);
export const isAccent = oneOf(ACCENTS);
export const isUnits = oneOf(UNITS);
export const isNotify = (v: unknown): v is Notify => v === "on" || v === "off";

/** The theme a choice comes to, given whether the system is light. */
export function resolveTheme(choice: ThemeChoice, systemLight: boolean): Theme {
  return choice === "system" ? (systemLight ? "light" : "dark") : choice;
}

/** One choice: its signal, and where it is kept. */
interface Kept<T> {
  get: () => T;
  set: (v: T) => void;
  local: string;
  remote: string;
  valid: (v: unknown) => v is T;
}

function kept<T>(name: string, valid: (v: unknown) => v is T, fallback: T): Kept<T> {
  const local = `urtorrentd.${name}`;
  let start = fallback;
  try {
    const v = localStorage.getItem(local);
    if (valid(v)) start = v;
  } catch {
    // Private mode or blocked storage: the default.
  }
  const [get, set] = createSignal<T>(start);
  return { get, set: (v) => set(() => v), local, remote: `webui.${name}`, valid };
}

interface Look {
  theme: Kept<ThemeChoice>;
  accent: Kept<Accent>;
  units: Kept<Units>;
  notify: Kept<Notify>;
  resolved: () => Theme;
  applied: () => Theme;
  setApplied: (t: Theme) => void;
}

// Made on first use, so modules that import this one load without a
// browser (the unit tests).
let made: Look | undefined;
function look(): Look {
  made ??= createRoot(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const theme = kept("theme", isThemeChoice, "system");
    const [systemLight, setSystemLight] = createSignal(media.matches);
    media.addEventListener("change", () => setSystemLight(media.matches));
    const resolved = () => resolveTheme(theme.get(), systemLight());
    const [applied, setApplied] = createSignal<Theme>(resolved());
    return {
      theme,
      accent: kept("accent", isAccent, "blue"),
      units: kept("units", isUnits, "decimal"),
      notify: kept("notify", isNotify, "off"),
      resolved,
      applied,
      setApplied,
    };
  });
  return made;
}

/** The viewer's theme choice. */
export const themeChoice = (): ThemeChoice => look().theme.get();
/** The theme in force now. */
export const theme = (): Theme => look().resolved();
/** The theme the page's tokens are in: read by what copies a token's value
 * (the charts), after `data-theme` changed. */
export const appliedTheme = (): Theme => look().applied();
/** The viewer's accent. */
export const accentChoice = (): Accent => look().accent.get();
/** The viewer's units. */
export const unitsChoice = (): Units => look().units.get();
/** Whether the viewer wants a notification when a download finishes. */
export const notifyChoice = (): Notify => look().notify.get();

function apply(): void {
  const l = look();
  const root = document.documentElement;
  root.dataset.theme = l.resolved();
  root.style.colorScheme = l.resolved();
  if (l.accent.get() === "blue") delete root.dataset.accent;
  else root.dataset.accent = l.accent.get();
  setBinaryUnits(l.units.get() === "binary");
  l.setApplied(l.resolved());
}

/** Apply the look now and whenever a choice or the system changes. */
export function startTheme(): void {
  apply();
  const l = look();
  createRoot(() =>
    createEffect(on([l.resolved, l.accent.get, l.units.get], apply, { defer: true })),
  );
}

function choose<T extends string>(k: Kept<T>, v: T): void {
  k.set(v);
  try {
    localStorage.setItem(k.local, v);
  } catch {
    // Private mode or blocked storage: the daemon still keeps it.
  }
  void unwrap(api.PATCH("/api/v1/client-data", { body: { [k.remote]: v } })).catch(() => undefined);
}

/** Choose a theme: here at once, and for the user at the daemon. */
export const setThemeChoice = (v: ThemeChoice) => choose(look().theme, v);
/** Choose an accent. */
export const setAccentChoice = (v: Accent) => choose(look().accent, v);
/** Choose the units of sizes and rates. */
export const setUnitsChoice = (v: Units) => choose(look().units, v);
/** Choose whether finished downloads notify. */
export const setNotifyChoice = (v: Notify) => choose(look().notify, v);

/** After sign-in: take the user's choices from the daemon, where it has them. */
export async function loadThemeChoice(): Promise<void> {
  const l = look();
  const all = [l.theme, l.accent, l.units, l.notify] as const;
  try {
    const data = await unwrap(
      api.GET("/api/v1/client-data", {
        params: { query: { keys: all.map((k) => k.remote).join(",") } },
      }),
    );
    for (const k of all) {
      const v = data[k.remote];
      if (k.valid(v) && v !== k.get()) {
        (k as Kept<typeof v>).set(v);
        try {
          localStorage.setItem(k.local, String(v));
        } catch {
          // Kept by the daemon anyway.
        }
      }
    }
  } catch {
    // Keep this browser's.
  }
}
