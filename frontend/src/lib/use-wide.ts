// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { createSignal, onCleanup, onMount } from "solid-js";

/** Whether a media query matches, following it as the viewport changes. */
export function useMedia(media: string) {
  const query = window.matchMedia(media);
  const [matches, setMatches] = createSignal(query.matches);
  const update = () => setMatches(query.matches);
  onMount(() => query.addEventListener("change", update));
  onCleanup(() => query.removeEventListener("change", update));
  return matches;
}

/** Whether the viewport has room for a detail panel beside a list (1280px and wider). */
export function useWide() {
  return useMedia("(min-width: 1280px)");
}

/** A phone (under 640px): list rows take two lines (AGENTS.md 6.3). */
export function useNarrow() {
  return useMedia("(max-width: 639px)");
}
