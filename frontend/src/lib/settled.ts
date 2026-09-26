// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { type Accessor, createEffect, createSignal, on, onCleanup } from "solid-js";

/** `value` once it has stopped changing for `ms` (typing into a field that asks the daemon). */
export function useSettled<T>(value: Accessor<T>, ms = 400): Accessor<T> {
  const [settled, setSettled] = createSignal<T>(value());
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(
    on(
      value,
      (v) => {
        clearTimeout(timer);
        timer = setTimeout(() => setSettled(() => v), ms);
      },
      { defer: true },
    ),
  );
  onCleanup(() => clearTimeout(timer));
  return settled;
}
