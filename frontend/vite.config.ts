// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { fileURLToPath, URL } from "node:url";

import tailwindcss from "@tailwindcss/vite";
import solid from "vite-plugin-solid";
import { defineConfig } from "vitest/config";

// The daemon the dev server proxies `/api` to. The proxy keeps the browser's
// `Host` (`changeOrigin: false`): the daemon's CSRF check compares `Origin`
// with it, so rewriting it would refuse every POST (AGENTS.md 5.3).
const daemon = process.env.URTORRENTD_URL ?? "http://127.0.0.1:8080";

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  base: "/",
  resolve: {
    alias: { "~": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  server: {
    host: "localhost",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: daemon, changeOrigin: false, ws: false },
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
  },
});
