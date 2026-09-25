// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { cn } from "~/lib/utils";

/** The design's 6–7px dot. Colour is never the only signal: put a label next to it. */
export function StatusDot(props: { class?: string; small?: boolean }) {
  return (
    <span
      aria-hidden="true"
      class={cn(
        "inline-block flex-none rounded-full",
        props.small ? "size-1.5" : "size-[7px]",
        props.class,
      )}
    />
  );
}
