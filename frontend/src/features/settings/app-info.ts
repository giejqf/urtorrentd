// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { createQuery } from "@tanstack/solid-query";

import { api, unwrap } from "~/api/client";
import { keys } from "~/api/keys";

/** `GET /app`: versions, start time, settings waiting for a restart, the time zone. */
export function useAppInfo() {
  return createQuery(() => ({
    queryKey: keys.app(),
    queryFn: () => unwrap(api.GET("/api/v1/app")),
    refetchInterval: 30_000,
  }));
}
