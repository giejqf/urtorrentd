// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import type { Schemas } from "~/api/client";

import { diff, draftOf, kbText, parseCount, parseKb } from "./speed-form";

const saved = {
  download_limit: null,
  upload_limit: 12_000_000,
  alt_download_limit: 10_485_760,
  alt_upload_limit: 1_000_000,
  alt_speed_enabled: false,
  alt_speed_schedule: { from: "01:00", to: "07:00", days: ["mon", "tue"], time_zone: null },
  max_connections: 500,
  max_connections_per_torrent: 200,
  max_uploads: 40,
  max_uploads_per_torrent: null,
} as unknown as Schemas["Settings"];

describe("units", () => {
  it("shows bytes per second as kB/s and reads them back", () => {
    expect(kbText(12_000_000)).toBe("12 000");
    expect(kbText(10_485_760)).toBe("10 485.76");
    expect(kbText(null)).toBe("");
    expect(parseKb("12 000")).toBe(12_000_000);
    expect(parseKb("10 485.76")).toBe(10_485_760);
    expect(parseKb("")).toBeNull();
    expect(parseKb("0")).toBeNull();
    expect(parseKb("fast")).toBeUndefined();
    expect(parseCount("", true)).toBeNull();
    expect(parseCount("", false)).toBeUndefined();
    expect(parseCount("4.5", false)).toBeUndefined();
  });
});

describe("changes", () => {
  it("sends nothing when nothing changed, even for odd byte counts", () => {
    const d = diff(saved, draftOf(saved));
    expect(d.patch).toEqual({});
    expect(d.names).toEqual([]);
  });

  it("sends only what changed, in the API's units", () => {
    const draft = { ...draftOf(saved), upload_limit: "", max_uploads_per_torrent: "4" };
    const d = diff(saved, draft);
    expect(d.patch).toEqual({ upload_limit: null, max_uploads_per_torrent: 4 });
    expect(d.names).toEqual(["upload_limit", "max_uploads_per_torrent"]);
  });

  it("sends the whole schedule when a part of it changes", () => {
    const d = diff(saved, { ...draftOf(saved), days: ["mon", "tue", "wed"] });
    expect(d.patch).toEqual({
      alt_speed_schedule: {
        from: "01:00",
        to: "07:00",
        days: ["mon", "tue", "wed"],
        time_zone: null,
      },
    });
    expect(d.names).toEqual(["alt_speed_schedule.days"]);
    const off = diff(saved, { ...draftOf(saved), schedule: false });
    expect(off.patch).toEqual({ alt_speed_schedule: null });
  });

  it("says what is wrong", () => {
    const d = diff(saved, { ...draftOf(saved), from: "7:00", to: "07:00", max_connections: "" });
    expect(d.errors.from).toBe("HH:MM, 24-hour.");
    expect(d.errors.max_connections).toBe("A whole number.");
    const same = diff(saved, { ...draftOf(saved), to: "01:00" });
    expect(same.errors.to).toBe("The window cannot start and end at the same time.");
  });
});
