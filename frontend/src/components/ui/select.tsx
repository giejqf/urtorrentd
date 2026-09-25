// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors
// Based on solid-ui (MIT): Copyright (c) 2023 shadcn, Copyright (c) 2023 Stefan E-K.

import type { JSX, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";

import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import * as SelectPrimitive from "@kobalte/core/select";

import { menuContent, menuIndicatorItem } from "~/components/ui/menu-styles";
import { cn } from "~/lib/utils";

// The design's `.sel`: a 36px field with a chevron, like the inputs.
const Select = SelectPrimitive.Root;
const SelectValue = SelectPrimitive.Value;
const SelectHiddenSelect = SelectPrimitive.HiddenSelect;
const SelectLabel = SelectPrimitive.Label;

type SelectTriggerProps<T extends ValidComponent = "button"> =
  SelectPrimitive.SelectTriggerProps<T> & {
    class?: string | undefined;
    children?: JSX.Element;
  };

const SelectTrigger = <T extends ValidComponent = "button">(
  props: PolymorphicProps<T, SelectTriggerProps<T>>,
) => {
  const [local, others] = splitProps(props as SelectTriggerProps, ["class", "children"]);
  return (
    <SelectPrimitive.Trigger
      class={cn(
        "flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-background px-3 text-left text-base text-foreground transition-[border-color,box-shadow] outline-none focus-visible:border-ring focus-visible:shadow-focus disabled:cursor-not-allowed disabled:opacity-50 data-[placeholder-shown]:text-muted-foreground",
        local.class,
      )}
      {...others}
    >
      {local.children}
      <SelectPrimitive.Icon
        as="svg"
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="size-3.5 flex-none text-muted-foreground"
      >
        <path d="m6 9 6 6 6-6" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
};

type SelectContentProps<T extends ValidComponent = "div"> =
  SelectPrimitive.SelectContentProps<T> & { class?: string | undefined };

const SelectContent = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, SelectContentProps<T>>,
) => {
  const [local, others] = splitProps(props as SelectContentProps, ["class"]);
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        class={cn(menuContent, "max-h-72 overflow-y-auto", local.class)}
        {...others}
      >
        <SelectPrimitive.Listbox class="m-0 p-0 outline-none" />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
};

type SelectItemProps<T extends ValidComponent = "li"> = SelectPrimitive.SelectItemProps<T> & {
  class?: string | undefined;
  children?: JSX.Element;
};

const SelectItem = <T extends ValidComponent = "li">(
  props: PolymorphicProps<T, SelectItemProps<T>>,
) => {
  const [local, others] = splitProps(props as SelectItemProps, ["class", "children"]);
  return (
    <SelectPrimitive.Item
      class={cn(
        menuIndicatorItem,
        "data-[highlighted]:bg-accent data-[highlighted]:text-foreground",
        local.class,
      )}
      {...others}
    >
      <SelectPrimitive.ItemIndicator class="absolute left-2 flex size-3.5 items-center justify-center">
        <svg
          xmlns="http://www.w3.org/2000/svg"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2.5"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="size-3.5"
          aria-hidden="true"
        >
          <path d="M5 12l5 5l10 -10" />
        </svg>
      </SelectPrimitive.ItemIndicator>
      <SelectPrimitive.ItemLabel>{local.children}</SelectPrimitive.ItemLabel>
    </SelectPrimitive.Item>
  );
};

export {
  Select,
  SelectValue,
  SelectHiddenSelect,
  SelectLabel,
  SelectTrigger,
  SelectContent,
  SelectItem,
};
