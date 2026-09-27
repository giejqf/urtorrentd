// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The colour theme (AGENTS.md 6.2): dark, light, or the system's. The choice
// is kept in this browser (so the sign-in page and the first paint have it)
// and by the daemon with the other UI preferences (`/client-data`, so it
// follows the user); after sign-in the daemon's wins. `data-theme` on
// <html> selects the tokens in app.css.

import { createEffect, createRoot, createSignal, on } from "solid-js";

import { api, unwrap } from "~/api/client";

export type ThemeChoice = "system" | "dark" | "light";
export type Theme = "dark" | "light";

const LOCAL = "urtorrentd.theme";
const REMOTE = "webui.theme";

/** The choices, as menus name them. */
export const THEME_CHOICES: readonly { value: ThemeChoice; label: string }[] = [
  { value: "system", label: "Match the system" },
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
];

export function isThemeChoice(v: unknown): v is ThemeChoice {
  return v === "system" || v === "dark" || v === "light";
}

/** The theme a choice comes to, given whether the system is light. */
export function resolveTheme(choice: ThemeChoice, systemLight: boolean): Theme {
  return choice === "system" ? (systemLight ? "light" : "dark") : choice;
}

function stored(): ThemeChoice {
  try {
    const v = localStorage.getItem(LOCAL);
    return isThemeChoice(v) ? v : "system";
  } catch {
    return "system";
  }
}

interface ThemeState {
  choice: () => ThemeChoice;
  setChoice: (c: ThemeChoice) => void;
  theme: () => Theme;
  applied: () => Theme;
  setApplied: (t: Theme) => void;
}

// Made on first use, so modules that import this one load without a
// browser (the unit tests).
let made: ThemeState | undefined;
function state(): ThemeState {
  made ??= createRoot(() => {
    const media = window.matchMedia("(prefers-color-scheme: light)");
    const [choice, setChoice] = createSignal<ThemeChoice>(stored());
    const [systemLight, setSystemLight] = createSignal(media.matches);
    media.addEventListener("change", () => setSystemLight(media.matches));
    const theme = () => resolveTheme(choice(), systemLight());
    const [applied, setApplied] = createSignal<Theme>(theme());
    return { choice, setChoice, theme, applied, setApplied };
  });
  return made;
}

/** The viewer's choice. */
export const themeChoice = (): ThemeChoice => state().choice();
/** The theme in force now. */
export const theme = (): Theme => state().theme();
/** The theme the page's tokens are in: read by what copies a token's value
 * (the charts), after `data-theme` changed. */
export const appliedTheme = (): Theme => state().applied();

function apply(): void {
  const root = document.documentElement;
  root.dataset.theme = theme();
  root.style.colorScheme = theme();
  state().setApplied(theme());
}

/** Set `data-theme` now and whenever the choice or the system changes. */
export function startTheme(): void {
  apply();
  createRoot(() => createEffect(on(theme, apply, { defer: true })));
}

function keep(choice: ThemeChoice): void {
  try {
    localStorage.setItem(LOCAL, choice);
  } catch {
    // Private mode or blocked storage: the daemon still keeps it.
  }
}

/** Choose a theme: here at once, and for the user at the daemon. */
export function setThemeChoice(choice: ThemeChoice): void {
  state().setChoice(choice);
  keep(choice);
  void unwrap(api.PATCH("/api/v1/client-data", { body: { [REMOTE]: choice } })).catch(
    () => undefined,
  );
}

/** After sign-in: take the user's choice from the daemon, if it has one. */
export async function loadThemeChoice(): Promise<void> {
  try {
    const data = await unwrap(
      api.GET("/api/v1/client-data", { params: { query: { keys: REMOTE } } }),
    );
    const v = data[REMOTE];
    if (isThemeChoice(v) && v !== state().choice()) {
      state().setChoice(v);
      keep(v);
    }
  } catch {
    // Keep this browser's.
  }
}
