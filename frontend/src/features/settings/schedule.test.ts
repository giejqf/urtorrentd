// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import { hoursPerWeek, isOpen, minutes, nextSwitch, weekGrid, zonedNow } from "./schedule";

const MON = 0;
const TUE = 1;
const FRI = 4;
const SAT = 5;

describe("schedule", () => {
  it("reads HH:MM as the daemon does", () => {
    expect(minutes("01:00")).toBe(60);
    expect(minutes("23:59")).toBe(1439);
    expect(minutes("1:00")).toBeNull();
    expect(minutes("24:00")).toBeNull();
    expect(minutes("07:60")).toBeNull();
  });

  it("opens a window on its days, and runs one past midnight into the next", () => {
    const night = {
      from: minutes("22:00") ?? 0,
      to: minutes("02:00") ?? 0,
      days: ["mon"] as const,
    };
    expect(isOpen(night, MON, minutes("23:00") ?? 0)).toBe(true);
    expect(isOpen(night, TUE, minutes("01:00") ?? 0)).toBe(true);
    expect(isOpen(night, MON, minutes("01:00") ?? 0)).toBe(false);
    expect(isOpen(night, TUE, minutes("23:00") ?? 0)).toBe(false);
    const every = { ...night, days: [] };
    expect(isOpen(every, MON, minutes("01:00") ?? 0)).toBe(true);
  });

  it("counts the week, to the minute", () => {
    const weekdays = { from: 60, to: 420, days: ["mon", "tue", "wed", "thu", "fri"] as const };
    expect(hoursPerWeek(weekdays)).toBe(30);
    const partial = { from: 90, to: 435, days: ["mon"] as const };
    const grid = weekGrid(partial);
    expect(grid[MON]?.slice(0, 8)).toEqual([0, 30, 60, 60, 60, 60, 60, 15]);
    expect(hoursPerWeek(partial)).toBe(5.75);
  });

  it("finds the next switch", () => {
    const weekdays = { from: 60, to: 420, days: ["mon", "tue", "wed", "thu", "fri"] as const };
    // Friday 10:40: next it opens on Monday at 01:00.
    expect(nextSwitch(weekdays, FRI, 640)).toMatchObject({ opens: true, day: MON, minute: 60 });
    // Saturday, no window: still Monday.
    expect(nextSwitch(weekdays, SAT, 0)?.day).toBe(MON);
    // Inside the window: it closes at 07:00.
    expect(nextSwitch(weekdays, TUE, 120)).toMatchObject({ opens: false, day: TUE, minute: 420 });
  });

  it("tells the day and minute in a zone", () => {
    // 2026-09-25 is a Friday; 09:40 UTC is 10:40 in London (BST).
    const t = new Date("2026-09-25T09:40:00Z");
    expect(zonedNow(t, "Europe/London")).toEqual({ day: FRI, minute: 640 });
    expect(zonedNow(t, "UTC")).toEqual({ day: FRI, minute: 580 });
  });
});
