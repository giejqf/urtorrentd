// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors
// Based on solid-ui (MIT): Copyright (c) 2023 shadcn, Copyright (c) 2023 Stefan E-K.

import type { JSX, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";

import * as ButtonPrimitive from "@kobalte/core/button";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import type { VariantProps } from "class-variance-authority";
import { cva } from "class-variance-authority";

import { cn } from "~/lib/utils";

// The design's buttons: `.btn` (outline, 28px), `.btn.primary` (the one
// primary action), `.ib` (icon buttons, 28px), the detail tabs' 24px
// `.sbtn` and the 40px sign-in button.
const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors outline-none focus-visible:shadow-focus focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default:
          "border border-primary bg-primary text-primary-foreground hover:border-primary-hover hover:bg-primary-hover",
        outline:
          "border border-border bg-transparent text-foreground-2 hover:bg-accent hover:text-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-selected",
        ghost: "text-muted-foreground hover:bg-accent hover:text-foreground",
        destructive:
          "border border-destructive bg-destructive text-destructive-foreground hover:opacity-90",
        link: "text-foreground underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-6 gap-1 px-2 text-xs [&_svg]:size-3",
        sm: "h-7 px-2.5 text-sm [&_svg]:size-[13px]",
        default: "h-8 px-3 text-base [&_svg]:size-3.5",
        md: "h-9 gap-2 rounded-lg px-3.5 text-base [&_svg]:size-3.5",
        lg: "h-10 gap-2 rounded-lg px-3.5 text-base [&_svg]:size-4",
        icon: "size-7 [&_svg]:size-3.5",
        "icon-sm": "size-[22px] [&_svg]:size-3",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps<T extends ValidComponent = "button"> = ButtonPrimitive.ButtonRootProps<T> &
  VariantProps<typeof buttonVariants> & { class?: string | undefined; children?: JSX.Element };

const Button = <T extends ValidComponent = "button">(
  props: PolymorphicProps<T, ButtonProps<T>>,
) => {
  const [local, others] = splitProps(props as ButtonProps, ["variant", "size", "class"]);
  return (
    <ButtonPrimitive.Root
      class={cn(buttonVariants({ variant: local.variant, size: local.size }), local.class)}
      {...others}
    />
  );
};

export { Button, buttonVariants };
export type { ButtonProps };
