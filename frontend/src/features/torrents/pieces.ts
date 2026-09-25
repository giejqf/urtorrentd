// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The pieces chart's data (AGENTS.md 6.4): the daemon's per-piece states
// and availability, binned for the chart. Nothing is invented: a bin shows
// the mean copies of its pieces (the connected peers' plus ours) and the
// share of them we have; "rare" is a wanted piece we miss that at most one
// connected peer has.

import type { Schemas } from "~/api/client";

export interface PieceBin {
  /** Mean copies of the bin's pieces: connected peers with it, plus ours. */
  copies: number;
  /** Share of the bin's pieces we have, 0 to 1. */
  have: number;
  /** A wanted piece we miss is on at most one connected peer. */
  rare: boolean;
}

export interface PieceChart {
  bins: PieceBin[];
  total: number;
  have: number;
  /** Mean copies over every piece. */
  meanCopies: number;
  /** Wanted pieces we miss that at most one connected peer has. */
  rareMissing: number;
  /** The y axis' top: a round number of copies, at least 2. */
  max: number;
}

/** Axis tops whose halves are whole numbers too. */
const STEPS = [2, 4, 6, 8, 10, 12, 16, 20, 24, 30, 40, 50, 60, 80];

/** The smallest round number of copies at or above `v` (at least 2). */
export function roundMax(v: number): number {
  for (let scale = 1; ; scale *= 10) {
    for (const s of STEPS) {
      if (s * scale >= v && s * scale >= 2) return s * scale;
    }
  }
}

export function binPieces(p: Schemas["PiecesResponse"], width = 194): PieceChart {
  const total = p.states.length;
  const count = Math.max(1, Math.min(width, total));
  const bins: PieceBin[] = [];
  let have = 0;
  let copiesSum = 0;
  let rareMissing = 0;
  let peak = 0;
  for (let b = 0; b < count && total > 0; b += 1) {
    const from = Math.floor((b * total) / count);
    const to = Math.max(from + 1, Math.floor(((b + 1) * total) / count));
    let binHave = 0;
    let binCopies = 0;
    let rare = false;
    for (let i = from; i < to; i += 1) {
      const had = p.states[i] === "have";
      const peers = p.availability[i] ?? 0;
      const copies = peers + (had ? 1 : 0);
      binCopies += copies;
      if (had) binHave += 1;
      else if ((p.priorities[i] ?? 0) > 0 && peers <= 1) {
        rare = true;
        rareMissing += 1;
      }
    }
    const n = to - from;
    const mean = binCopies / n;
    peak = Math.max(peak, mean);
    have += binHave;
    copiesSum += binCopies;
    bins.push({ copies: mean, have: binHave / n, rare });
  }
  return {
    bins,
    total,
    have,
    meanCopies: total > 0 ? copiesSum / total : 0,
    rareMissing,
    max: roundMax(peak),
  };
}
