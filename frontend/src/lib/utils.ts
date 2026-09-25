// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { type ClassValue, clsx } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// The theme's own sizes (app.css): without them tailwind-merge would take
// `text-md` for a colour and drop it next to `text-subtle`.
const twMerge = extendTailwindMerge({
  extend: {
    theme: {
      text: ["2xs", "md"],
      shadow: ["focus", "card", "menu"],
      radius: ["tile", "card"],
    },
  },
});

/** Joins class names, later Tailwind classes winning over earlier ones. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
