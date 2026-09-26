// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import {
  byteUnit,
  dash,
  formatAgo,
  formatAxis,
  formatBytes,
  formatChange,
  formatClock,
  formatCount,
  formatDays,
  formatDateTime,
  formatDuration,
  formatEta,
  formatFullDateTime,
  formatLimit,
  formatPercent,
  formatPieceSize,
  formatRate,
  formatRatio,
  parseBytes,
  parseLimit,
  unlimited,
} from "./format";

describe("formatBytes", () => {
  it("uses decimal units by default, as the design does", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(999)).toBe("999 B");
    expect(formatBytes(1000)).toBe("1.0 kB");
    expect(formatBytes(640e3)).toBe("640 kB");
    expect(formatBytes(4.2e6)).toBe("4.2 MB");
    expect(formatBytes(318e6)).toBe("318 MB");
    expect(formatBytes(6.3e9)).toBe("6.3 GB");
    expect(formatBytes(11.2e9)).toBe("11.2 GB");
    expect(formatBytes(1.21e12)).toBe("1.2 TB");
  });

  it("moves to the next unit when rounding reaches it", () => {
    expect(formatBytes(999_960_000)).toBe("1.0 GB");
    expect(formatBytes(999_400_000)).toBe("999 MB");
  });

  it("uses binary units on request", () => {
    expect(formatBytes(1023, { binary: true })).toBe("1023 B");
    expect(formatBytes(1024, { binary: true })).toBe("1.0 KiB");
    expect(formatBytes(4 * 1024 ** 2, { binary: true })).toBe("4.0 MiB");
    expect(formatBytes(1536 * 1024 ** 3, { binary: true })).toBe("1.5 TiB");
  });

  it("shows a dash for what is not a byte count", () => {
    expect(formatBytes(-1)).toBe(dash);
    expect(formatBytes(Number.NaN)).toBe(dash);
  });
});

describe("rates and limits", () => {
  it("formats rates", () => {
    expect(formatRate(0)).toBe("0 B/s");
    expect(formatRate(8.1e6)).toBe("8.1 MB/s");
    expect(formatRate(96e3)).toBe("96.0 kB/s");
    expect(formatRate(410e3)).toBe("410 kB/s");
  });

  it("shows null limits as unlimited", () => {
    expect(formatLimit(null)).toBe(unlimited);
    expect(formatLimit(5e6)).toBe("5.0 MB/s");
    expect(formatLimit(0)).toBe("0 B/s");
  });
});

describe("formatPieceSize", () => {
  it("is always binary", () => {
    expect(formatPieceSize(16 * 1024)).toBe("16 KiB");
    expect(formatPieceSize(4 * 1024 ** 2)).toBe("4 MiB");
    expect(formatPieceSize(1024 ** 3)).toBe("1 GiB");
    expect(formatPieceSize(0)).toBe(dash);
  });
});

describe("durations", () => {
  it("shows the two largest units", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(59)).toBe("59s");
    expect(formatDuration(192)).toBe("3m 12s");
    expect(formatDuration(660)).toBe("11m");
    expect(formatDuration(24 * 60 + 10)).toBe("24m 10s");
    expect(formatDuration(12 * 86_400 + 4 * 3_600 + 59)).toBe("12d 4h");
    expect(formatDuration(83 * 86_400)).toBe("83d");
    expect(formatDuration(3_600 + 30)).toBe("1h");
    expect(formatDuration(-5)).toBe(dash);
  });

  it("shows an unknown ETA as a dash", () => {
    expect(formatEta(null)).toBe(dash);
    expect(formatEta(192)).toBe("3m 12s");
  });
});

describe("ratio and progress", () => {
  it("formats ratios with two decimals", () => {
    expect(formatRatio(null)).toBe(dash);
    expect(formatRatio(4.214)).toBe("4.21");
    expect(formatRatio(0)).toBe("0.00");
  });

  it("never shows 100% before the end", () => {
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.62)).toBe("62%");
    expect(formatPercent(0.9999)).toBe("99%");
    expect(formatPercent(0.9999, 1)).toBe("99.9%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(1.2)).toBe("100%");
  });

  it("separates thousands", () => {
    expect(formatCount(3072)).toBe("3,072");
    expect(formatCount(12)).toBe("12");
  });
});

describe("times", () => {
  const opts = { locale: "en-US", timeZone: "UTC" };
  const t = Date.UTC(2026, 8, 24, 10, 2, 5) / 1000;

  it("formats dates in the given zone", () => {
    expect(formatDateTime(t, opts)).toBe("Sep 24, 10:02");
    expect(formatFullDateTime(t, opts)).toBe("Sep 24, 2026, 10:02:05");
    expect(formatDateTime(null, opts)).toBe(dash);
  });

  it("says how long ago, by the largest unit", () => {
    expect(formatAgo(t, t + 2, opts)).toBe("just now");
    expect(formatAgo(t, t + 12, opts)).toBe("12s ago");
    expect(formatAgo(t, t + 5 * 60 + 30, opts)).toBe("5m ago");
    expect(formatAgo(t, t + 3 * 3_600, opts)).toBe("3h ago");
    expect(formatAgo(t, t + 2 * 86_400, opts)).toBe("2d ago");
    expect(formatAgo(t, t + 8 * 86_400, opts)).toBe("Sep 24, 10:02");
    expect(formatAgo(null, t, opts)).toBe(dash);
  });
});

describe("charts", () => {
  it("picks an axis unit and writes its numbers", () => {
    expect(byteUnit(0)).toEqual({ unit: "B", size: 1 });
    expect(byteUnit(420e9)).toEqual({ unit: "GB", size: 1e9 });
    expect(byteUnit(999)).toEqual({ unit: "B", size: 1 });
    expect(byteUnit(2 * 1024 ** 2, { binary: true })).toEqual({ unit: "MiB", size: 1024 ** 2 });
    expect(formatAxis(2.5)).toBe("2.5");
    expect(formatAxis(40)).toBe("40");
    expect(formatAxis(12.4)).toBe("12");
  });

  it("writes times of day and changes", () => {
    expect(formatClock(Date.UTC(2026, 8, 21, 22, 5) / 1000, { timeZone: "UTC" })).toBe("22:05");
    expect(formatChange(0.124)).toBe("▲ 12%");
    expect(formatChange(-0.08)).toBe("▼ 8%");
    expect(formatChange(0.001)).toBe("± 0%");
    expect(formatChange(12)).toBe("▲ 1,200%");
    expect(formatDays(30 * 86_400 + 5000)).toBe("30 d");
    expect(formatDays(5 * 3600)).toBe("5 h");
    expect(formatDays(700)).toBe("12 min");
  });
});

describe("parsing", () => {
  it("reads plain numbers as bytes", () => {
    expect(parseBytes("0")).toBe(0);
    expect(parseBytes("1500")).toBe(1500);
    expect(parseBytes(" 12 b ")).toBe(12);
  });

  it("reads explicit units", () => {
    expect(parseBytes("5 MB")).toBe(5_000_000);
    expect(parseBytes("5mb")).toBe(5_000_000);
    expect(parseBytes("5.5 GiB")).toBe(Math.round(5.5 * 1024 ** 3));
    expect(parseBytes("1 KiB")).toBe(1024);
    expect(parseBytes("8 MB/s")).toBe(8_000_000);
    expect(parseBytes(".5 kB")).toBe(500);
  });

  it("reads bare prefixes by the unit preference", () => {
    expect(parseBytes("500k")).toBe(500_000);
    expect(parseBytes("500k", { binary: true })).toBe(512_000);
    expect(parseBytes("2 m", { binary: true })).toBe(2 * 1024 ** 2);
  });

  it("refuses what is not a size", () => {
    expect(parseBytes("")).toBeUndefined();
    expect(parseBytes("-5 MB")).toBeUndefined();
    expect(parseBytes("5 XB")).toBeUndefined();
    expect(parseBytes("5 ib")).toBeUndefined();
    expect(parseBytes("fast")).toBeUndefined();
    expect(parseBytes("1e30")).toBeUndefined();
  });

  it("reads limits, empty or infinity being unlimited", () => {
    expect(parseLimit("")).toBeNull();
    expect(parseLimit(" ∞ ")).toBeNull();
    expect(parseLimit("Unlimited")).toBeNull();
    expect(parseLimit("5 MB/s")).toBe(5_000_000);
    expect(parseLimit("0")).toBe(0);
    expect(parseLimit("lots")).toBeUndefined();
  });
});
