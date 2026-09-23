// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// A client written against the types generated from openapi.json. It only
// has to type-check (`npm run check`): correct calls compile, and the
// `@ts-expect-error` lines prove that wrong ones do not.

import createClient from "openapi-fetch";
import type { components, paths } from "./schema.js";

type Schemas = components["schemas"];

const api = createClient<paths>({ baseUrl: "http://127.0.0.1:8080" });

export async function demo(): Promise<void> {
  await api.POST("/api/v1/auth/login", { body: { username: "admin", password: "secret" } });

  const { data, error } = await api.GET("/api/v1/torrents", {
    params: { query: { filter: "downloading", sort: "eta", reverse: true } },
  });
  if (error) {
    const code: Schemas["ErrorCode"] = error.error.code;
    console.log(code, error.error.message);
    return;
  }
  for (const t of data) {
    const state: Schemas["TorrentState"] = t.state;
    const eta: number | null | undefined = t.eta;
    const limit: Schemas["RatioLimit"] = t.share_limits.ratio;
    console.log(t.hash, state, eta, t.progress, limit.mode);
  }

  const added = await api.POST("/api/v1/torrents", {
    body: {
      urls: ["magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567"],
      options: { stopped: true, stop_condition: "files_checked", category: "linux" },
    },
  });
  console.log(added.data?.added.map((a: Schemas["AddedTorrent"]) => a.hash));

  await api.POST("/api/v1/torrents/stop", { body: { hashes: "all" } });
  await api.POST("/api/v1/torrents/limits", { body: { hashes: ["0123456789abcdef0123456789abcdef01234567"], download_limit: null } });
  await api.PATCH("/api/v1/settings", { body: { download_limit: 1048576, dht: false } });
  await api.GET("/api/v1/torrents/{hash}/files", { params: { path: { hash: "0123456789abcdef0123456789abcdef01234567" } } });

  const sync = await api.GET("/api/v1/sync", { params: { query: { rev: 3 } } });
  if (sync.data && !sync.data.full) {
    console.log(Object.keys(sync.data.torrents), sync.data.torrents_removed, sync.data.transfer.download_rate);
  }

  // @ts-expect-error: `hashes` is a list of info-hashes or "all".
  await api.POST("/api/v1/torrents/stop", { body: { hashes: 42 } });
  // @ts-expect-error: not a filter.
  await api.GET("/api/v1/torrents", { params: { query: { filter: "nonsense" } } });
  // @ts-expect-error: not a setting (typed bodies catch unknown fields; openapi-fetch's
  // inferred body parameter does not run TypeScript's excess-property check).
  const patch: Schemas["SettingsPatch"] = { no_such_setting: true };
  await api.PATCH("/api/v1/settings", { body: patch });
  // @ts-expect-error: no such endpoint.
  await api.GET("/api/v1/nope");
}
