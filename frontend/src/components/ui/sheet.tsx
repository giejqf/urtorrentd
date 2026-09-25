// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors
// Based on solid-ui (MIT): Copyright (c) 2023 shadcn, Copyright (c) 2023 Stefan E-K.

import type { Component, ComponentProps, JSX, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";

import * as SheetPrimitive from "@kobalte/core/dialog";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import { cva, type VariantProps } from "class-variance-authority";
import X from "lucide-solid/icons/x";

import { cn } from "~/lib/utils";

// A panel sliding in from an edge: the detail panel and the sidebar on
// narrow screens (AGENTS.md 6.3).
const Sheet = SheetPrimitive.Root;
const SheetTrigger = SheetPrimitive.Trigger;
const SheetClose = SheetPrimitive.CloseButton;

const sheetVariants = cva(
  "fixed z-50 flex flex-col bg-card text-card-foreground shadow-card outline-none data-[closed]:animate-out data-[closed]:duration-200 data-[expanded]:animate-in data-[expanded]:duration-300",
  {
    variants: {
      position: {
        top: "inset-x-0 top-0 border-b border-divider data-[closed]:slide-out-to-top data-[expanded]:slide-in-from-top",
        bottom:
          "inset-x-0 bottom-0 border-t border-divider data-[closed]:slide-out-to-bottom data-[expanded]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-[85vw] max-w-sm border-r border-divider data-[closed]:slide-out-to-left data-[expanded]:slide-in-from-left",
        right:
          "inset-y-0 right-0 h-full w-[85vw] max-w-[420px] border-l border-divider data-[closed]:slide-out-to-right data-[expanded]:slide-in-from-right",
      },
    },
    defaultVariants: {
      position: "right",
    },
  },
);

type SheetContentProps<T extends ValidComponent = "div"> = SheetPrimitive.DialogContentProps<T> &
  VariantProps<typeof sheetVariants> & {
    class?: string | undefined;
    children?: JSX.Element;
    /** Show the close button in the corner (default true). */
    closeButton?: boolean;
  };

const SheetContent = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, SheetContentProps<T>>,
) => {
  const [local, others] = splitProps(props as SheetContentProps, [
    "position",
    "class",
    "children",
    "closeButton",
  ]);
  return (
    <SheetPrimitive.Portal>
      <SheetPrimitive.Overlay class="fixed inset-0 z-50 bg-overlay data-[closed]:animate-out data-[closed]:fade-out-0 data-[expanded]:animate-in data-[expanded]:fade-in-0" />
      <SheetPrimitive.Content
        class={cn(sheetVariants({ position: local.position }), "max-h-screen", local.class)}
        {...others}
      >
        {local.children}
        {local.closeButton !== false && (
          <SheetPrimitive.CloseButton
            class="absolute top-2.5 right-3 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:shadow-focus focus-visible:ring-1 focus-visible:ring-ring"
            aria-label="Close"
          >
            <X class="size-3.5" aria-hidden="true" />
          </SheetPrimitive.CloseButton>
        )}
      </SheetPrimitive.Content>
    </SheetPrimitive.Portal>
  );
};

const SheetHeader: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return <div class={cn("flex flex-col gap-1.5", local.class)} {...others} />;
};

const SheetFooter: Component<ComponentProps<"div">> = (props) => {
  const [local, others] = splitProps(props, ["class"]);
  return (
    <div
      class={cn("flex flex-col-reverse gap-2 sm:flex-row sm:justify-end", local.class)}
      {...others}
    />
  );
};

type SheetTitleProps<T extends ValidComponent = "h2"> = SheetPrimitive.DialogTitleProps<T> & {
  class?: string | undefined;
};

const SheetTitle = <T extends ValidComponent = "h2">(
  props: PolymorphicProps<T, SheetTitleProps<T>>,
) => {
  const [local, others] = splitProps(props as SheetTitleProps, ["class"]);
  return (
    <SheetPrimitive.Title
      class={cn("m-0 text-md font-semibold text-foreground", local.class)}
      {...others}
    />
  );
};

type SheetDescriptionProps<T extends ValidComponent = "p"> =
  SheetPrimitive.DialogDescriptionProps<T> & { class?: string | undefined };

const SheetDescription = <T extends ValidComponent = "p">(
  props: PolymorphicProps<T, SheetDescriptionProps<T>>,
) => {
  const [local, others] = splitProps(props as SheetDescriptionProps, ["class"]);
  return (
    <SheetPrimitive.Description
      class={cn("m-0 text-base text-muted-foreground", local.class)}
      {...others}
    />
  );
};

export {
  Sheet,
  SheetTrigger,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetFooter,
  SheetTitle,
  SheetDescription,
};
