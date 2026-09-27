// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { createUniqueId } from "solid-js";

import { cn } from "~/lib/utils";

/**
 * The logo mark: one stroke that rises in a U and runs on into a ring round
 * it, each end tucked behind the other. Drawn in the text colour: 22px in
 * the sidebar, 40px on sign-in with `large`. The geometry (a 362-unit box
 * centred on the ring) is the logo's, measured from its artwork;
 * public/favicon.svg draws the same.
 */
export function LogoMark(props: { large?: boolean; class?: string }) {
  // Masks by id: each mark its own, as a hidden copy's would not draw.
  const id = createUniqueId();
  return (
    <svg
      viewBox="-181 -181 362 362"
      class={cn("flex-none text-foreground", props.large ? "size-10" : "size-[22px]", props.class)}
      fill="none"
      stroke="currentColor"
      stroke-width="33"
      aria-hidden="true"
    >
      <defs>
        {/* The ring gives way, 13 units wide, where the U rises into it. */}
        <mask
          id={`logo-ring-${id}`}
          maskUnits="userSpaceOnUse"
          x="-181"
          y="-181"
          width="362"
          height="362"
        >
          <rect x="-181" y="-181" width="362" height="362" fill="#fff" stroke="none" />
          <path d="M-78.5 14.5V-85A78.5 78.5 0 0 1 0-163.5" stroke="#000" stroke-width="59" />
        </mask>
        {/* The U's right side stops 13 units inside the ring. */}
        <mask
          id={`logo-u-${id}`}
          maskUnits="userSpaceOnUse"
          x="-181"
          y="-181"
          width="362"
          height="362"
        >
          <rect x="-181" y="-181" width="362" height="362" fill="#fff" stroke="none" />
          <rect x="0" y="-181" width="181" height="362" fill="#000" stroke="none" />
          <circle r="135" fill="#fff" stroke="none" />
        </mask>
      </defs>
      <circle r="164.5" mask={`url(#logo-ring-${id})`} />
      <path
        d="M-78.5-85A78.5 78.5 0 0 1 78.5-85V14.5A78.5 78.5 0 0 1-78.5 14.5Z"
        mask={`url(#logo-u-${id})`}
      />
    </svg>
  );
}
