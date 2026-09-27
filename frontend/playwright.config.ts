// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// End-to-end tests (AGENTS.md 7.4): real daemons, a real browser, the built
// UI served by the daemon. `npm run e2e` builds both first.

import { defineConfig, devices } from "@playwright/test";

const viewport = { width: 1440, height: 900 };

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  // The scale benchmark (e2e/scale.spec.ts) runs only when asked: SLOW=1.
  grepInvert: process.env.SLOW ? undefined : /@slow/,
  // Each test may run two daemons next to its browser: half the cores.
  workers: "50%",
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    viewport,
    // The theme follows the system by default: the suite runs in the dark
    // one, and the palette spec checks the light one.
    colorScheme: "dark",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], viewport } },
    { name: "firefox", use: { ...devices["Desktop Firefox"], viewport } },
    { name: "webkit", use: { ...devices["Desktop Safari"], viewport } },
  ],
});
