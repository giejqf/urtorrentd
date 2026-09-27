// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// What the detail panel's tabs share: the torrent named at the top of each
// tab but the Overview, and a few small pieces.

import type { JSX } from "solid-js";

import type { Schemas } from "~/api/client";
import { StatusDot } from "~/components/status-dot";
import { Badge } from "~/components/ui/badge";
import { formatCount, formatEta, formatPercent, formatRatio } from "~/lib/format";
import { checkProgress, stateLook, toneBg } from "~/lib/torrent";

type TorrentSummary = Schemas["TorrentSummary"];

/** The line beside the state: progress and time left, or the ratio once complete. */
export function progressLine(t: TorrentSummary): string {
  if (!t.has_metadata) return `waiting for metadata · ${formatCount(t.peers)} peers`;
  if (checkProgress(t) !== null)
    return `${formatCount(t.pieces_checked)} of ${formatCount(t.pieces_total)} pieces checked`;
  if (t.complete) return `100% · ratio ${formatRatio(t.ratio)}`;
  const pct = formatPercent(t.progress, 1);
  return t.eta === null ? pct : `${pct} · ${formatEta(t.eta)} left`;
}

export function trackerTone(status: Schemas["TrackerStatus"]): string {
  switch (status) {
    case "working":
      return "bg-online";
    case "updating":
      return "bg-warn";
    case "not_working":
      return "bg-danger";
    case "not_contacted":
      return "bg-faint";
  }
}

/** The torrent at the top of a tab: its name, state and progress, small. */
export function TabHeading(props: { torrent: TorrentSummary }) {
  const look = () => stateLook(props.torrent);
  return (
    <div class="flex flex-none flex-col gap-0.5">
      <h2 class="m-0 truncate text-[14px] leading-[1.3] font-semibold" title={props.torrent.name}>
        {props.torrent.name}
      </h2>
      <div class="flex items-center gap-2">
        <Badge variant="pill" class="h-5 text-xs">
          <StatusDot class={toneBg[look().tone]} />
          {look().label}
        </Badge>
        <span class="truncate mono text-xs text-muted-foreground">
          {progressLine(props.torrent)}
        </span>
      </div>
    </div>
  );
}

/** A section's heading with what acts on it to the right. */
export function SectionHead(props: { title: string; children?: JSX.Element }) {
  return (
    <div class="flex min-h-6 min-w-0 items-center justify-between gap-2">
      <h3 class="m-0 flex-none section-label whitespace-nowrap">{props.title}</h3>
      {props.children}
    </div>
  );
}
