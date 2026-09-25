// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors
// Based on solid-ui (MIT): Copyright (c) 2023 shadcn, Copyright (c) 2023 Stefan E-K.

import type { Component, ComponentProps } from "solid-js";
import { splitProps } from "solid-js";

import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

import { cn } from "~/lib/utils";

// `tag`: the design's `.tag` (18px, a tag or flag); `pill`: the `.pill`
// (22px, a torrent's state next to its name).
const badgeVariants = cva("inline-flex shrink-0 items-center whitespace-nowrap", {
  variants: {
    variant: {
      tag: "h-[18px] rounded-sm border border-border px-1.5 text-xs text-muted-foreground",
      pill: "h-[22px] gap-1.5 rounded-md border border-border bg-muted px-2 text-sm font-medium text-foreground",
    },
  },
  defaultVariants: {
    variant: "tag",
  },
});

type BadgeProps = ComponentProps<"span"> & VariantProps<typeof badgeVariants>;

const Badge: Component<BadgeProps> = (props) => {
  const [local, others] = splitProps(props, ["class", "variant"]);
  return <span class={cn(badgeVariants({ variant: local.variant }), local.class)} {...others} />;
};

export type { BadgeProps };
export { Badge, badgeVariants };
