// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The alternative-limits schedule as the daemon applies it
// (`AltSpeedSchedule::contains` in crates/urtorrentd/src/settings.rs): a
// window from `from` to `to` on the listed days (none = every day); one
// that ends before it starts runs past midnight and belongs to the day it
// starts on. Pure, so the week grid and the next switch match the daemon.

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export const DAY_LABELS: Record<Weekday, string> = {
  mon: "Mon",
  tue: "Tue",
  wed: "Wed",
  thu: "Thu",
  fri: "Fri",
  sat: "Sat",
  sun: "Sun",
};

/** `HH:MM` (two digits each, 24-hour) as minutes of the day, as the daemon reads it. */
export function minutes(text: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

export interface Window {
  from: number;
  to: number;
  days: readonly Weekday[];
}

/** Whether the window is open at minute `now` of day `day` (0 = Monday). */
export function isOpen(w: Window, day: number, now: number): boolean {
  const on = (d: number) =>
    w.days.length === 0 || w.days.includes(WEEKDAYS[(d + 7) % 7] as Weekday);
  if (w.from < w.to) return on(day) && now >= w.from && now < w.to;
  return (now >= w.from && on(day)) || (now < w.to && on(day - 1));
}

/** Minutes of each hour (`[day][hour]`, 0 = Monday) the window is open. */
export function weekGrid(w: Window): number[][] {
  return WEEKDAYS.map((_, day) =>
    Array.from({ length: 24 }, (_, hour) => {
      let n = 0;
      for (let m = hour * 60; m < hour * 60 + 60; m += 1) if (isOpen(w, day, m)) n += 1;
      return n;
    }),
  );
}

/** Hours a week the alternative limits are on. */
export function hoursPerWeek(w: Window): number {
  return weekGrid(w).reduce((sum, row) => sum + row.reduce((a, b) => a + b, 0), 0) / 60;
}

export interface Switch {
  /** Whether the window opens (true) or closes there. */
  opens: boolean;
  day: number;
  minute: number;
  /** Minutes from `now`. */
  after: number;
}

/** The next time the window opens or closes after (`day`, `now`), within a week. */
export function nextSwitch(w: Window, day: number, now: number): Switch | null {
  const open = isOpen(w, day, now);
  for (let step = 1; step <= 7 * 1440; step += 1) {
    const t = day * 1440 + now + step;
    const d = Math.floor(t / 1440) % 7;
    const m = t % 1440;
    if (isOpen(w, d, m) !== open) return { opens: !open, day: d, minute: m, after: step };
  }
  return null;
}

/** `01:00`. */
export function clock(minute: number): string {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}

/** The day (0 = Monday) and minute of the day of `date` in `timeZone`. */
export function zonedNow(
  date: Date,
  timeZone: string | undefined,
): { day: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = WEEKDAYS.indexOf(get("weekday").toLowerCase().slice(0, 3) as Weekday);
  return { day: Math.max(day, 0), minute: Number(get("hour")) * 60 + Number(get("minute")) };
}
