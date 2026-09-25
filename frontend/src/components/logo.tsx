// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { cn } from "~/lib/utils";

/**
 * The logo mark: an arrow into a tray on a light tile (the design's 22px
 * sidebar tile, or the 40px sign-in tile with `large`).
 */
export function LogoMark(props: { large?: boolean; class?: string }) {
  return (
    <div
      class={cn(
        "flex flex-none items-center justify-center bg-primary text-primary-foreground",
        props.large ? "size-10 rounded-tile" : "size-[22px] rounded-md",
        props.class,
      )}
      aria-hidden="true"
    >
      <svg
        width={props.large ? 22 : 13}
        height={props.large ? 22 : 13}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2.5"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M12 3v12" />
        <path d="m7 10 5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
    </div>
  );
}
