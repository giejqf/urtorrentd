// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { checkCoverage, isCalled, listed, operations } from "./coverage";

// The check itself on a made-up schema, then on the real `openapi.json`,
// `src/` and `coverage.md` (frontend/AGENTS.md 7.3).

const schema = {
  paths: {
    "/api/v1/torrents": { get: {}, post: {} },
    "/api/v1/torrents/{hash}/files": { get: {} },
    "/api/v1/torrents/start": { post: {} },
    "/api/v1/events": { get: {} },
    "/api/v1/sync": { get: {} },
  },
};

describe("coverage", () => {
  it("lists every operation of a schema", () => {
    expect(operations(schema)).toEqual([
      "GET /api/v1/torrents",
      "POST /api/v1/torrents",
      "GET /api/v1/torrents/{hash}/files",
      "POST /api/v1/torrents/start",
      "GET /api/v1/events",
      "GET /api/v1/sync",
    ]);
  });

  it("finds calls by method, and GET paths anywhere", () => {
    const src = [
      `await unwrap(api.POST(\n  "/api/v1/torrents/start",\n  { body },\n));`,
      `api.GET("/api/v1/torrents/{hash}/files", { params })`,
      `new EventSource("/api/v1/events")`,
    ];
    expect(isCalled("POST /api/v1/torrents/start", src)).toBe(true);
    expect(isCalled("GET /api/v1/torrents/{hash}/files", src)).toBe(true);
    expect(isCalled("GET /api/v1/events", src)).toBe(true);
    expect(isCalled("GET /api/v1/torrents", src)).toBe(false);
    expect(isCalled("POST /api/v1/torrents", [`api.GET("/api/v1/torrents")`])).toBe(false);
  });

  it("reads the listed operations from the table", () => {
    const md = [
      "| Operation | Why |",
      "|---|---|",
      "| `GET /api/v1/sync` | The event stream instead. |",
      "| not a row |",
    ].join("\n");
    expect(listed(md)).toEqual(["GET /api/v1/sync"]);
  });

  it("reports missing, stale and unknown rows", () => {
    const src = [`api.POST("/api/v1/torrents/start")`, `api.GET("/api/v1/events")`];
    const md = [
      "| `GET /api/v1/sync` | stream |",
      "| `POST /api/v1/torrents/start` | stale |",
      "| `DELETE /api/v1/nothing` | unknown |",
    ].join("\n");
    expect(checkCoverage(schema, src, md)).toEqual({
      missing: [
        "GET /api/v1/torrents",
        "POST /api/v1/torrents",
        "GET /api/v1/torrents/{hash}/files",
      ],
      stale: ["POST /api/v1/torrents/start"],
      unknown: ["DELETE /api/v1/nothing"],
    });
  });
});

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    const skip = name.endsWith(".d.ts") || name.includes(".test.") || name === "coverage.ts";
    return /\.(ts|tsx)$/.test(name) && !skip ? [readFileSync(path, "utf8")] : [];
  });
}

describe("the UI against the API", () => {
  it("calls every operation or says why not in coverage.md", () => {
    const root = join(import.meta.dirname, "../..");
    const schema = JSON.parse(readFileSync(join(root, "../openapi.json"), "utf8"));
    const markdown = readFileSync(join(root, "coverage.md"), "utf8");
    const result = checkCoverage(schema, sources(join(root, "src")), markdown);
    expect(result, "fix coverage.md or the UI").toEqual({ missing: [], stale: [], unknown: [] });
  });
});
