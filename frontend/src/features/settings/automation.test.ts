// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import type { Schemas } from "~/api/client";

import { refreshesWithin, requestsPerDay, ruleFilter, rssDiff, rssDraft } from "./rss-view";
import { emptyFolder, folderSetting, watchDiff, watchDraft } from "./watch-form";
import { health, jsonParts, lastLine, newSecret, shownUrl } from "./webhooks-view";

const delivery = (over: Partial<Schemas["WebhookDelivery"]>) =>
  ({
    id: "d",
    time: 1000,
    event: "finished",
    hash: null,
    status: 200,
    error: null,
    attempts: 1,
    ...over,
  }) as Schemas["WebhookDelivery"];

describe("webhooks", () => {
  it("show a URL without what may be a token", () => {
    expect(shownUrl("https://discord.com/api/webhooks/1189/x9Kf")).toBe("https://discord.com/…");
    expect(shownUrl("http://127.0.0.1:8099/")).toBe("http://127.0.0.1:8099/");
    expect(shownUrl("https://sonarr.lan/api?apikey=1")).toBe("https://sonarr.lan/…");
  });

  it("tell health from the last delivery", () => {
    expect(health({ enabled: false, deliveries: [] }).label).toBe("disabled");
    expect(health({ enabled: true, deliveries: [] }).label).toBe("no delivery yet");
    expect(health({ enabled: true, deliveries: [delivery({})] }).tone).toBe("ok");
    const failed = delivery({ status: null, error: "timed out", attempts: 4 });
    expect(health({ enabled: true, deliveries: [failed] }).tone).toBe("danger");
    expect(lastLine({ deliveries: [failed] }, 1000 + 7200)).toBe(
      "finished · no answer · 4 attempts · 2h ago",
    );
  });

  it("make secrets and colour JSON as text", () => {
    expect(newSecret((b) => b.fill(171))).toBe("ab".repeat(32));
    const parts = jsonParts({ event: "finished", size: 12, detail: null });
    expect(parts.filter((p) => p.kind === "key").map((p) => p.text)).toEqual([
      '"event"',
      '"size"',
      '"detail"',
    ]);
    expect(parts.find((p) => p.kind === "string")?.text).toBe('"finished"');
    expect(parts.find((p) => p.kind === "number")?.text).toBe("12");
    expect(parts.find((p) => p.kind === "literal")?.text).toBe("null");
    expect(parts.map((p) => p.text).join("")).toBe(
      JSON.stringify({ event: "finished", size: 12, detail: null }, null, 2),
    );
  });
});

describe("rss", () => {
  it("counts requests and plans the next refreshes as the daemon does", () => {
    const feeds = [
      { refresh_interval: null, last_refresh: 0 },
      { refresh_interval: 3600, last_refresh: 0 },
    ];
    expect(requestsPerDay(feeds, 900)).toBe(96 + 24);
    // Never refreshed: at once. Overdue: at once. Else its interval after the last.
    expect(
      refreshesWithin({ refresh_interval: null, last_refresh: null }, 900, 10_000, 1800),
    ).toEqual([10_000, 10_900, 11_800]);
    expect(
      refreshesWithin({ refresh_interval: 1200, last_refresh: 9_500 }, 900, 10_000, 3600),
    ).toEqual([10_700, 11_900, 13_100]);
  });

  it("says a rule in a line", () => {
    expect(
      ruleFilter({
        must_contain: "(2160p|4K)",
        must_not_contain: "",
        use_regex: true,
        episode_filter: "",
        smart_filter: true,
        ignore_days: 30,
      }),
    ).toBe("/(2160p|4K)/  ·  smart filter  ·  ignore 30 d");
  });

  it("keeps the interval in minutes and checks the bounds", () => {
    const saved = {
      rss_enabled: true,
      rss_refresh_interval: 1800,
      rss_fetch_delay: 2,
      rss_max_articles: 50,
      rss_auto_download: false,
      rss_download_repacks: false,
    } as unknown as Schemas["Settings"];
    const d = rssDraft(saved);
    expect(d.rss_refresh_interval).toBe("30");
    expect(rssDiff(saved, { ...d, rss_refresh_interval: "15" }).patch).toEqual({
      rss_refresh_interval: 900,
    });
    expect(
      Object.keys(
        rssDiff(saved, {
          ...d,
          rss_refresh_interval: "0.5",
          rss_fetch_delay: "4000",
          rss_max_articles: "0",
        }).errors,
      ),
    ).toEqual(["rss_refresh_interval", "rss_fetch_delay", "rss_max_articles"]);
  });
});

describe("watch folders", () => {
  const saved = {
    watch_folders: [
      {
        path: "/data/watch",
        recursive: false,
        after_add: "rename",
        options: { category: "linux", content_layout: "subfolder" },
      },
    ],
  } as unknown as Schemas["Settings"];

  it("starts unchanged and keeps the options the page does not show", () => {
    const d = watchDraft(saved);
    expect(watchDiff(saved, d).changed.size).toBe(0);
    const f = { ...d.folders[0]!, tags: ["iso"], stopped: true };
    expect(folderSetting(f)).toEqual({
      path: "/data/watch",
      recursive: false,
      after_add: "rename",
      options: { category: "linux", content_layout: "subfolder", tags: ["iso"], stopped: true },
    });
    const r = watchDiff(saved, { folders: [f] });
    expect(r.names).toEqual(["watch_folders: /data/watch"]);
  });

  it("names added and removed folders and refuses bad paths", () => {
    const added = { ...emptyFolder(), path: "/mnt/drop", after_add: "delete" as const };
    const r = watchDiff(saved, { folders: [added] });
    expect(r.names).toEqual(["watch_folders: + /mnt/drop", "watch_folders: − /data/watch"]);
    expect(r.patch).toEqual({
      watch_folders: [{ path: "/mnt/drop", recursive: false, after_add: "delete", options: {} }],
    });
    expect(
      watchDiff(saved, { folders: [...watchDraft(saved).folders, emptyFolder()] }).errors.folders,
    ).toBe("The folder is needed.");
    expect(
      watchDiff(saved, {
        folders: [{ ...emptyFolder(), path: "/data/watch" }, ...watchDraft(saved).folders],
      }).errors.folders,
    ).toBe("This folder is listed twice.");
  });
});
