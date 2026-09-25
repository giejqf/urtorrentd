// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The classes dropdown and context menus share: a popover surface, 30px
// items at 13px, 11px group labels.

export const menuContent =
  "z-50 min-w-40 origin-[var(--kb-menu-content-transform-origin)] overflow-hidden rounded-lg border border-border bg-popover p-1 text-base text-popover-foreground shadow-menu outline-none data-[closed]:animate-out data-[closed]:fade-out-0 data-[closed]:zoom-out-95 data-[expanded]:animate-in data-[expanded]:fade-in-0 data-[expanded]:zoom-in-95";

export const menuItem =
  "relative flex h-[30px] cursor-default items-center gap-2 rounded-md px-2 text-foreground-2 transition-colors outline-none select-none focus:bg-accent focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:size-3.5 [&_svg]:shrink-0";

export const menuIndicatorItem =
  "relative flex h-[30px] cursor-default items-center rounded-md pr-2 pl-7 text-foreground-2 transition-colors outline-none select-none focus:bg-accent focus:text-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50";

export const menuLabel = "px-2 py-1.5 text-xs font-medium text-subtle";

export const menuSeparator = "-mx-1 my-1 h-px border-0 bg-divider";

export const menuShortcut = "mono ml-auto pl-4 text-2xs text-subtle";
