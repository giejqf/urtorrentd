// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// UI preferences (AGENTS.md 4.2): kept by the daemon in `/client-data`
// under `webui.` keys, so they follow the user to any browser. A value
// that does not validate (an older layout, another client's) is ignored.

import { type Accessor, createSignal, onCleanup } from "solid-js";

import { api, unwrap } from "~/api/client";

const PREFIX = "webui.";

export function usePref<T>(
  name: string,
  fallback: T,
  valid: (v: unknown) => v is T,
): [Accessor<T>, (v: T) => void] {
  const key = PREFIX + name;
  const [value, setValue] = createSignal<T>(fallback);
  let touched = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  void unwrap(api.GET("/api/v1/client-data", { params: { query: { keys: key } } }))
    .then((data) => {
      const stored = data[key];
      if (!touched && valid(stored)) setValue(() => stored);
    })
    .catch(() => undefined);
  onCleanup(() => clearTimeout(timer));
  const set = (v: T) => {
    touched = true;
    setValue(() => v);
    clearTimeout(timer);
    timer = setTimeout(() => {
      void unwrap(api.PATCH("/api/v1/client-data", { body: { [key]: v } })).catch(() => undefined);
    }, 400);
  };
  return [value, set];
}
