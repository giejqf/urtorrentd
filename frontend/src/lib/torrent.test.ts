// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import type { Schemas } from "~/api/client";

import {
  errorKindLabel,
  filterMatches,
  FILTERS,
  GROUPS,
  stateLook,
  tagSummary,
  trackerHost,
} from "./torrent";

type State = Schemas["TorrentState"];

const t = (
  state: State,
  more: Partial<{
    stalled: boolean;
    complete: boolean;
    download_rate: number;
    upload_rate: number;
  }> = {},
) => ({ state, stalled: false, complete: false, download_rate: 0, upload_rate: 0, ...more });

describe("stateLook", () => {
  it("maps every state to a group that exists", () => {
    const states: State[] = [
      "metadata",
      "checking_queued",
      "checking",
      "downloading",
      "seeding",
      "queued",
      "stopped",
      "error",
      "moving",
      "held",
      "unknown",
    ];
    for (const s of states) {
      const look = stateLook(t(s));
      expect(GROUPS.some((g) => g.key === look.group)).toBe(true);
    }
  });

  it("shows stalled downloads and seeds as Stalled", () => {
    expect(stateLook(t("downloading", { stalled: true }))).toMatchObject({
      group: "stalled",
      label: "Stalled",
    });
    expect(stateLook(t("seeding", { stalled: true })).group).toBe("stalled");
    expect(stateLook(t("seeding")).group).toBe("seeding");
    expect(stateLook(t("checking_queued"))).toMatchObject({
      group: "checking",
      label: "Queued for check",
    });
  });

  it("names error kinds", () => {
    expect(errorKindLabel("content_missing")).toBe("Files missing");
    expect(errorKindLabel(null)).toBe("Error");
  });
});

describe("filterMatches (the daemon's filter_matches)", () => {
  it("treats Downloading as not complete, whatever the state", () => {
    expect(filterMatches("downloading", t("stopped"))).toBe(true);
    expect(filterMatches("downloading", t("seeding", { complete: true }))).toBe(false);
  });

  it("counts Held as stopped and not running", () => {
    expect(filterMatches("stopped", t("held"))).toBe(true);
    expect(filterMatches("running", t("held"))).toBe(false);
    expect(filterMatches("running", t("error"))).toBe(false);
    expect(filterMatches("running", t("queued"))).toBe(true);
  });

  it("wants seeding torrents complete and running", () => {
    expect(filterMatches("seeding", t("seeding", { complete: true }))).toBe(true);
    expect(filterMatches("seeding", t("stopped", { complete: true }))).toBe(false);
    expect(filterMatches("completed", t("stopped", { complete: true }))).toBe(true);
  });

  it("judges activity by the rates", () => {
    expect(filterMatches("active", t("seeding", { upload_rate: 1 }))).toBe(true);
    expect(filterMatches("inactive", t("seeding"))).toBe(true);
  });

  it("splits stalled by state", () => {
    const s = t("seeding", { stalled: true });
    expect(filterMatches("stalled", s)).toBe(true);
    expect(filterMatches("stalled_seeding", s)).toBe(true);
    expect(filterMatches("stalled_downloading", s)).toBe(false);
  });

  it("covers checking, moving and errors", () => {
    expect(filterMatches("checking", t("checking_queued"))).toBe(true);
    expect(filterMatches("moving", t("moving"))).toBe(true);
    expect(filterMatches("errored", t("error"))).toBe(true);
    expect(FILTERS).toHaveLength(14);
  });
});

describe("helpers", () => {
  it("takes tracker hosts, never full URLs", () => {
    expect(trackerHost("https://Torrent.Ubuntu.com/announce?passkey=secret")).toBe(
      "torrent.ubuntu.com",
    );
    expect(trackerHost("udp://tracker.example.org:1337/announce")).toBe("tracker.example.org");
    expect(trackerHost("http://[2001:db8::1]:6969/announce")).toBe("2001:db8::1");
    expect(trackerHost("not a url")).toBeNull();
    expect(trackerHost(null)).toBeNull();
  });

  it("summarises tags", () => {
    expect(tagSummary([])).toEqual({ first: null, more: 0 });
    expect(tagSummary(["iso", "keep", "4k"])).toEqual({ first: "iso", more: 2 });
  });
});
