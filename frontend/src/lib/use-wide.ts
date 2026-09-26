// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { createSignal, onCleanup, onMount } from "solid-js";

/** Whether the viewport has room for a detail panel beside a list (1280px and wider). */
export function useWide() {
  const query = window.matchMedia("(min-width: 1280px)");
  const [wide, setWide] = createSignal(query.matches);
  const update = () => setWide(query.matches);
  onMount(() => query.addEventListener("change", update));
  onCleanup(() => query.removeEventListener("change", update));
  return wide;
}
