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

  // Statistics: a torrent's hourly traffic, for a heatmap binned in the
  // viewer's time zone.
  const hourly = await api.GET("/api/v1/stats/torrents/{hash}/traffic", {
    params: { path: { hash: "0123456789abcdef0123456789abcdef01234567" }, query: { step: "hour" } },
  });
  const heat = new Map<string, number>();
  for (const p of hourly.data?.points ?? []) {
    const at = new Date(p.t * 1000);
    const cell = `${at.getDay()}:${at.getHours()}`;
    heat.set(cell, (heat.get(cell) ?? 0) + p.uploaded);
  }
  const days = await api.GET("/api/v1/stats/torrents/{hash}/days", {
    params: { path: { hash: "0123456789abcdef0123456789abcdef01234567" } },
  });
  const ratios: (number | null)[] = days.data?.days.map((d: Schemas["TorrentDay"]) => d.ratio) ?? [];
  const top = await api.GET("/api/v1/stats/top", { params: { query: { by: "uploaded", limit: 5 } } });
  console.log(heat, ratios, top.data?.torrents.map((t) => [t.name, t.uploaded, t.removed]));

  // Where the upload went: countries for a map, and a stacked series of the
  // top five.
  const geo = await api.GET("/api/v1/stats/geo", {
    params: { query: { dim: "country", by: "uploaded", limit: 5, series: true, step: "day" } },
  });
  const byCountry = new Map<string, number>();
  for (const r of geo.data?.rows ?? []) {
    byCountry.set(r.country ?? "unknown", r.uploaded);
  }
  const unattributed: number = geo.data?.unattributed.uploaded ?? 0;
  const networks = await api.GET("/api/v1/stats/geo", { params: { query: { dim: "asn" } } });
  const orgs = networks.data?.rows.map((r: Schemas["GeoRow"]) => `${r.asn ?? "?"} ${r.as_org ?? ""}`);
  const peers = await api.GET("/api/v1/torrents/{hash}/peers", {
    params: { path: { hash: "0123456789abcdef0123456789abcdef01234567" } },
  });
  const flags: (string | null)[] = peers.data?.map((p) => p.country) ?? [];
  console.log(byCountry, unattributed, orgs, flags);

  // Breakdowns: clients, groups, trackers, and what to remove.
  const clients = await api.GET("/api/v1/stats/peers", { params: { query: { dim: "client", step: "day" } } });
  const clientShare = clients.data?.rows.map((r: Schemas["PeerRow"]) => [r.key ?? "unknown", r.uploaded]);
  const byTag = await api.GET("/api/v1/stats/groups", { params: { query: { group: "tag", series: true } } });
  const trackers = await api.GET("/api/v1/stats/trackers", { params: { query: { from: 0, step: "day" } } });
  const failing = trackers.data?.rows.filter((r) => r.announce_errors > r.announces).map((r) => r.host);
  const idle = await api.GET("/api/v1/stats/idle-seeds", { params: { query: { days: 90, limit: 20 } } });
  const reclaim: number = (idle.data?.torrents ?? []).filter((t) => t.value < 0.1).reduce((n, t) => n + t.size, 0);
  console.log(clientShare, byTag.data?.points.length, failing, reclaim);

  // A metadata preview, then the add that uses it.
  const hash = "0123456789abcdef0123456789abcdef01234567";
  const preview = await api.POST("/api/v1/previews", { body: { source: `magnet:?xt=urn:btih:${hash}` } });
  if (preview.data?.state === "ready") {
    const files = preview.data.metadata?.files.map((f: Schemas["MetadataFile"]) => [f.path, f.size]);
    console.log(files);
    await api.POST("/api/v1/torrents", { body: { urls: [hash], options: { category: "music" } } });
  }

  // The alternative-limits schedule and watch folders are settings.
  await api.PATCH("/api/v1/settings", {
    body: {
      alt_speed_schedule: { from: "08:00", to: "23:30", days: ["mon", "fri"], time_zone: "Europe/Berlin" },
      watch_folders: [{ path: "/srv/watch", recursive: true, after_add: "delete", options: { category: "tv" } }],
    },
  });
  // @ts-expect-error: not a day.
  const badDay: Schemas["Weekday"] = "funday";
  void badDay;

  // RSS: a feed, its articles, a rule and its dry run.
  const feed = await api.POST("/api/v1/rss/feeds", { body: { url: "https://indexer.example/rss", folder: "tv" } });
  if (feed.data) {
    const detail = await api.GET("/api/v1/rss/feeds/{id}", { params: { path: { id: feed.data.id } } });
    const unread = detail.data?.articles.filter((a: Schemas["RssArticle"]) => !a.read).map((a) => a.torrent_url);
    await api.POST("/api/v1/rss/feeds/{id}/read", { params: { path: { id: feed.data.id } }, body: { articles: "all" } });
    await api.PUT("/api/v1/rss/rules/{name}", {
      params: { path: { name: "Show 1080p" } },
      body: { must_contain: "show 1080p", smart_filter: true, feeds: [feed.data.id], add_options: { category: "tv" } },
    });
    const would = await api.GET("/api/v1/rss/rules/{name}/matches", { params: { path: { name: "Show 1080p" } } });
    console.log(unread, would.data?.map((a) => a.title));
  }
  // Client data: any JSON by key.
  await api.PATCH("/api/v1/client-data", { body: { "ui.theme": "dark", "ui.old": null } });
  const prefs = await api.GET("/api/v1/client-data", { params: { query: { keys: "ui.theme" } } });
  console.log(prefs.data?.["ui.theme"]);

  // The rest of the preferences, and the endpoints that came with them.
  await api.PATCH("/api/v1/settings", {
    body: {
      content_layout: "subfolder",
      stop_condition: "files_checked",
      excluded_file_names: ["*.nfo", "sample"],
      export_dir: "/srv/torrents",
      api_trusted_proxies: ["10.0.0.0/8"],
      listen_interface: "wg0",
    },
  });
  await api.PUT("/api/v1/app/cookies", { body: [{ name: "uid", value: "42", domain: "tracker.example" }] });
  const ifaces = await api.GET("/api/v1/app/interfaces");
  const app = await api.GET("/api/v1/app");
  console.log(ifaces.data?.map((i: Schemas["NetworkInterface"]) => i.name), app.data?.listen_addresses, app.data?.fetched_trackers?.trackers);
  await api.POST("/api/v1/torrents/download-path", { body: { hashes: "all", path: null } });

  // Webhooks.
  const hook = await api.POST("/api/v1/webhooks", {
    body: { url: "https://media.lan/hook", events: ["finished", "moved"], secret: "s3cret" },
  });
  if (hook.data) {
    const tried = await api.POST("/api/v1/webhooks/{id}/test", { params: { path: { id: hook.data.id } } });
    console.log(tried.data?.status, tried.data?.error);
    await api.PATCH("/api/v1/webhooks/{id}", { params: { path: { id: hook.data.id } }, body: { secret: null } });
  }
  // @ts-expect-error: not an event.
  await api.POST("/api/v1/webhooks", { body: { url: "https://x", events: ["exploded"] } });

  // @ts-expect-error: `dim` is required.
  await api.GET("/api/v1/stats/peers", { params: { query: {} } });
  // @ts-expect-error: not a dimension.
  await api.GET("/api/v1/stats/geo", { params: { query: { dim: "city" } } });
  // @ts-expect-error: not a step.
  await api.GET("/api/v1/stats/transfer", { params: { query: { step: "week" } } });
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

// Live updates: server-sent events whose data is a SyncResponse. The schema
// ties the stream's payload to that type; the check below fails if it does not.
type EventData = paths["/api/v1/events"]["get"]["responses"][200]["content"]["text/event-stream"];
const eventDataIsSyncResponse: EventData extends Schemas["SyncResponse"] ? true : false = true;
void eventDataIsSyncResponse;

export function watch(onUpdate: (update: Schemas["SyncResponse"]) => void): EventSource {
  // The browser resumes with Last-Event-ID on reconnect.
  const events = new EventSource("/api/v1/events", { withCredentials: true });
  events.addEventListener("sync", (e: MessageEvent<string>) => {
    const update: EventData = JSON.parse(e.data);
    onUpdate(update);
  });
  return events;
}

// A webhook receiver typed from the same schema.
export function onWebhook(body: string): string | null {
  const payload: Schemas["WebhookPayload"] = JSON.parse(body);
  switch (payload.event) {
    case "finished":
    case "moved":
      return payload.torrent?.content_path ?? null;
    default:
      return null;
  }
}
