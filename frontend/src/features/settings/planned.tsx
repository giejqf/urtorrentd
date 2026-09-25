// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings sections of a later milestone: the navigation has them, and they
// say what is coming instead of pretending to work.

import { Navigate, useParams } from "@solidjs/router";
import { Show } from "solid-js";

import { SettingsFrame } from "./frame";
import { sectionLabel } from "./nav";

export default function PlannedSettings() {
  const params = useParams<{ section: string }>();
  const label = () => sectionLabel(params.section);
  return (
    <Show when={label()} fallback={<Navigate href="/settings/speed" />}>
      {(title) => (
        <SettingsFrame title={title()}>
          <p class="m-0 text-base text-muted-foreground">
            The {title()} settings are not built yet: they are planned for milestone W4 of the web
            UI. The daemon has them already (<span class="mono">GET /api/v1/settings</span>).
          </p>
        </SettingsFrame>
      )}
    </Show>
  );
}
