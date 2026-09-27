// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import { binPieces, findPiece, roundMax } from "./pieces";

describe("pieces chart", () => {
  it("rounds the axis up to a round number of copies", () => {
    expect(roundMax(0)).toBe(2);
    expect(roundMax(2)).toBe(2);
    expect(roundMax(2.1)).toBe(4);
    expect(roundMax(7)).toBe(8);
    expect(roundMax(11)).toBe(12);
    expect(roundMax(13)).toBe(16);
    expect(roundMax(170)).toBe(200);
  });

  it("counts our copy, and finds rare pieces we miss", () => {
    const chart = binPieces(
      {
        states: ["have", "have", "missing", "missing", "downloading", "missing"],
        availability: [0, 3, 1, 4, 0, 0],
        priorities: [4, 4, 4, 4, 4, 0],
      },
      3,
    );
    expect(chart.total).toBe(6);
    expect(chart.have).toBe(2);
    expect(chart.bins).toEqual([
      { copies: 2.5, have: 1, rare: false },
      { copies: 2.5, have: 0, rare: true },
      { copies: 0, have: 0, rare: true },
    ]);
    // Skipped pieces (priority 0) are never counted as rare.
    expect(chart.rareMissing).toBe(2);
    expect(chart.meanCopies).toBeCloseTo(10 / 6);
    expect(chart.max).toBe(4);
  });

  it("uses one bin per piece when there are few", () => {
    const chart = binPieces({ states: ["have"], availability: [5], priorities: [4] });
    expect(chart.bins).toEqual([{ copies: 6, have: 1, rare: false }]);
    expect(binPieces({ states: [], availability: [], priorities: [] }).bins).toEqual([]);
  });
});

describe("findPiece", () => {
  const hashes = ["aa11", "bb22", "bb33"];
  it("finds a piece by its number or the start of its hash", () => {
    expect(findPiece(hashes, "2")).toBe(2);
    expect(findPiece(hashes, "#1")).toBe(1);
    expect(findPiece(hashes, "BB")).toBe(1);
    expect(findPiece(hashes, "bb3")).toBe(2);
  });
  it("finds nothing past the end, for other text, or for nothing", () => {
    expect(findPiece(hashes, "3")).toBeNull();
    expect(findPiece(hashes, "cc")).toBeNull();
    expect(findPiece(hashes, "zz")).toBeNull();
    expect(findPiece(hashes, " ")).toBeNull();
  });
});
