// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The coverage check (AGENTS.md 7.3): every operation of the API is called
// by the UI or listed in `coverage.md` with the reason it is not. Pure, so
// that it can be tested on a made-up schema; `coverage.test.ts` feeds it the
// real files.

const METHODS = ["get", "put", "post", "delete", "patch"] as const;

export interface Coverage {
  /** Operations neither called nor listed. */
  missing: string[];
  /** Listed operations the UI calls after all (the row is stale). */
  stale: string[];
  /** Listed operations the schema does not have. */
  unknown: string[];
}

interface Schema {
  paths: Record<string, Partial<Record<string, unknown>>>;
}

/** Every `METHOD /path` of a schema. */
export function operations(schema: Schema): string[] {
  const ops: string[] = [];
  for (const [path, item] of Object.entries(schema.paths)) {
    for (const m of METHODS) {
      if (item[m] !== undefined) ops.push(`${m.toUpperCase()} ${path}`);
    }
  }
  return ops;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether the sources call an operation: `api.POST("/api/v1/...")` for any
 * method, and for `GET` any other quoted occurrence of the path too (an
 * `EventSource` or `fetch` URL, a link), unless it is another method's call.
 */
export function isCalled(op: string, sources: readonly string[]): boolean {
  const [method = "", path = ""] = op.split(" ");
  const quoted = `["'\`]${escape(path)}["'\`]`;
  const call = new RegExp(`\\b${method}\\(\\s*${quoted}`);
  // A GET's path anywhere, but not as the path of another method's call.
  const any = new RegExp(`(?<!\\b(?:POST|PUT|PATCH|DELETE)\\(\\s*)${quoted}`);
  return sources.some((s) => call.test(s) || (method === "GET" && any.test(s)));
}

/** The operations `coverage.md` lists: its table rows' first cells. */
export function listed(markdown: string): string[] {
  const rows: string[] = [];
  for (const line of markdown.split("\n")) {
    const m = /^\|\s*`((?:GET|PUT|POST|DELETE|PATCH) \/[^`]*)`\s*\|/.exec(line);
    if (m?.[1]) rows.push(m[1]);
  }
  return rows;
}

export function checkCoverage(
  schema: Schema,
  sources: readonly string[],
  markdown: string,
): Coverage {
  const ops = operations(schema);
  const waived = new Set(listed(markdown));
  const known = new Set(ops);
  return {
    missing: ops.filter((op) => !waived.has(op) && !isCalled(op, sources)),
    stale: [...waived].filter((op) => known.has(op) && isCalled(op, sources)),
    unknown: [...waived].filter((op) => !known.has(op)),
  };
}
