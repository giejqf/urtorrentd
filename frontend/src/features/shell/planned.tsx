// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Screens of later milestones (AGENTS.md 10): the navigation shows them,
// and they say what is coming instead of pretending to work.

import type { Component } from "solid-js";

import { PageHeader } from "./page-header";

export function planned(title: string, milestone: string, what: string): Component {
  return () => (
    <div class="flex min-w-0 flex-1 flex-col">
      <PageHeader title={title} />
      <div class="flex flex-1 items-center justify-center p-8">
        <div class="flex max-w-sm flex-col gap-2 text-center">
          <h2 class="m-0 text-md font-semibold">{title} is not built yet</h2>
          <p class="m-0 text-base text-muted-foreground">
            {what} It is planned for milestone {milestone} of the web UI.
          </p>
        </div>
      </div>
    </div>
  );
}
