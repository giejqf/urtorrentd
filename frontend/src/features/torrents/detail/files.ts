// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Files tab's model: the daemon's files (`GET /torrents/{hash}/files`)
// as a tree in their order in the torrent, each folder summed from its files;
// what a checkbox or a priority choice sends (one `POST .../files/priority`
// takes indexes and one priority); and each file's pieces as runs for the
// lanes. Pure and tested.

import type { Schemas } from "~/api/client";
import { formatBytes, formatCount } from "~/lib/format";

import { NORMAL } from "../add/form";

type FileInfo = Schemas["FileInfo"];
type PieceState = Schemas["PieceState"];

export interface FileRow {
  /** Relative to the save path, `/`-separated: the file's, or the folder's. */
  path: string;
  name: string;
  depth: number;
  folder: boolean;
  /** Bytes: a folder's files together. */
  size: number;
  /** Over the files not skipped, by size; `null` when every one is skipped. */
  progress: number | null;
  /** The file's index, or every file's under the folder. */
  indexes: number[];
  /** A file's priority, or its folder's files' when they share one. */
  priority: number | null;
  wanted: "all" | "some" | "none";
}

interface Folder {
  path: string;
  name: string;
  children: (Folder | FileInfo)[];
}

const isFolder = (n: Folder | FileInfo): n is Folder => "children" in n;

/** Every folder and file, a folder before its contents, in the torrent's order. */
export function fileRows(files: readonly FileInfo[]): FileRow[] {
  const root: Folder = { path: "", name: "", children: [] };
  const folders = new Map<string, Folder>();
  for (const f of [...files].sort((a, b) => a.index - b.index)) {
    const parts = f.path.split("/");
    let at = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const path = parts.slice(0, i + 1).join("/");
      let next = folders.get(path);
      if (!next) {
        next = { path, name: parts[i] ?? "", children: [] };
        folders.set(path, next);
        at.children.push(next);
      }
      at = next;
    }
    at.children.push(f);
  }
  const rows: FileRow[] = [];
  const walk = (node: Folder | FileInfo, depth: number): FileInfo[] => {
    if (!isFolder(node)) {
      rows.push({
        path: node.path,
        name: node.path.slice(node.path.lastIndexOf("/") + 1),
        depth,
        folder: false,
        size: node.size,
        progress: node.priority > 0 ? node.progress : null,
        indexes: [node.index],
        priority: node.priority,
        wanted: node.priority > 0 ? "all" : "none",
      });
      return [node];
    }
    const at = rows.length;
    const inside = node.children.flatMap((c) => walk(c, depth + 1));
    rows.splice(at, 0, folderRow(node, depth, inside));
    return inside;
  };
  for (const c of root.children) walk(c, 0);
  return rows;
}

function folderRow(node: Folder, depth: number, files: FileInfo[]): FileRow {
  const wanted = files.filter((f) => f.priority > 0);
  const wantedSize = wanted.reduce((n, f) => n + f.size, 0);
  const done = wanted.reduce((n, f) => n + f.progress * f.size, 0);
  const first = files[0]?.priority ?? null;
  return {
    path: node.path,
    name: node.name,
    depth,
    folder: true,
    size: files.reduce((n, f) => n + f.size, 0),
    progress: wanted.length === 0 ? null : wantedSize > 0 ? done / wantedSize : 1,
    indexes: files.map((f) => f.index),
    priority: files.every((f) => f.priority === first) ? first : null,
    wanted: wanted.length === files.length ? "all" : wanted.length === 0 ? "none" : "some",
  };
}

/** The rows shown: none inside a collapsed folder. */
export function shownRows(rows: readonly FileRow[], collapsed: ReadonlySet<string>): FileRow[] {
  if (collapsed.size === 0) return [...rows];
  return rows.filter((r) => {
    for (let at = r.path.lastIndexOf("/"); at > 0; at = r.path.lastIndexOf("/", at - 1)) {
      if (collapsed.has(r.path.slice(0, at))) return false;
    }
    return true;
  });
}

/**
 * What a row's checkbox sends: every file skipped when all were wanted,
 * else the skipped ones at normal priority (the others keep theirs).
 */
export function toggleWanted(
  row: FileRow,
  files: readonly FileInfo[],
): { indexes: number[]; priority: number } {
  if (row.wanted === "all") return { indexes: row.indexes, priority: 0 };
  const by = new Map(files.map((f) => [f.index, f.priority]));
  return { indexes: row.indexes.filter((i) => (by.get(i) ?? 0) === 0), priority: NORMAL };
}

/** The files under the chosen rows, each once, in order. */
export function chosenIndexes(rows: readonly FileRow[], chosen: ReadonlySet<string>): number[] {
  const out = new Set<number>();
  for (const r of rows) if (chosen.has(r.path)) for (const i of r.indexes) out.add(i);
  return [...out].sort((a, b) => a - b);
}

/** "5 files · 834 MB wanted of 835 MB". */
export function filesSummary(files: readonly FileInfo[]): string {
  const total = files.reduce((n, f) => n + f.size, 0);
  const wanted = files.reduce((n, f) => n + (f.priority > 0 ? f.size : 0), 0);
  const count = `${formatCount(files.length)} ${files.length === 1 ? "file" : "files"}`;
  if (wanted === total) return `${count} · ${formatBytes(total)}`;
  return `${count} · ${formatBytes(wanted)} wanted of ${formatBytes(total)}`;
}

/** The path a row gets under a new name, in the same folder. */
export function renamedPath(path: string, name: string): string {
  const at = path.lastIndexOf("/");
  return at < 0 ? name : `${path.slice(0, at)}/${name}`;
}

/** Why a new name cannot be used; `null` when it can. */
export function nameProblem(name: string): string | null {
  if (name.trim() === "") return "A name is needed.";
  if (name.includes("/") || name.includes("\\")) return "A name without slashes.";
  if (name === "." || name === "..") return "Not a name.";
  return null;
}

/** Runs of pieces `[from, to)` in `[first, last]` for which `test` holds. */
export function pieceRuns(
  states: readonly PieceState[],
  first: number,
  last: number,
  test: (s: PieceState) => boolean,
): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = first; i <= last + 1; i += 1) {
    const on = i <= last && i < states.length && test(states[i] ?? "missing");
    if (on && start < 0) start = i;
    if (!on && start >= 0) {
      runs.push([start, i]);
      start = -1;
    }
  }
  return runs;
}

/**
 * Runs as an SVG path of bars `h` high at `y`, pieces scaled to `width`;
 * runs closer than half a pixel merge, so a path has at most one bar per
 * pixel whatever the piece count.
 */
export function runsPath(
  runs: readonly [number, number][],
  pieces: number,
  width: number,
  y: number,
  h: number,
): string {
  if (pieces <= 0) return "";
  const x = (i: number) => (i / pieces) * width;
  const bars: [number, number][] = [];
  for (const [a, b] of runs) {
    const from = x(a);
    const to = x(b);
    const last = bars[bars.length - 1];
    if (last && from - last[1] < 0.5) last[1] = to;
    else bars.push([from, to]);
  }
  return bars
    .map(([a, b]) => {
      const w = Math.max(b - a, 0.6);
      return `M${a.toFixed(1)} ${y}h${w.toFixed(1)}v${h}h${(-w).toFixed(1)}Z`;
    })
    .join("");
}
