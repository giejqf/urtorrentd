// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors
// Based on solid-ui (MIT): Copyright (c) 2023 shadcn, Copyright (c) 2023 Stefan E-K.

import type { JSX, ValidComponent } from "solid-js";
import { Match, splitProps, Switch } from "solid-js";

import * as CheckboxPrimitive from "@kobalte/core/checkbox";
import type { PolymorphicProps } from "@kobalte/core/polymorphic";

import { cn } from "~/lib/utils";

type CheckboxRootProps<T extends ValidComponent = "div"> =
  CheckboxPrimitive.CheckboxRootProps<T> & {
    class?: string | undefined;
    children?: JSX.Element;
  };

// The design's `.chk`: 16px, radius 4, a strong border on the page colour;
// checked it turns white with a dark tick. A `CheckboxLabel` child names it.
const Checkbox = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, CheckboxRootProps<T>>,
) => {
  const [local, others] = splitProps(props as CheckboxRootProps, ["class", "children"]);
  return (
    <CheckboxPrimitive.Root class={cn("group flex items-center gap-2.5", local.class)} {...others}>
      <CheckboxPrimitive.Input class="peer" />
      <CheckboxPrimitive.Control class="flex size-4 shrink-0 items-center justify-center rounded-sm border border-border-strong bg-background transition-colors peer-focus-visible:border-ring peer-focus-visible:shadow-focus data-[checked]:border-primary data-[checked]:bg-primary data-[checked]:text-primary-foreground data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[indeterminate]:border-primary data-[indeterminate]:bg-primary data-[indeterminate]:text-primary-foreground">
        <CheckboxPrimitive.Indicator>
          <Switch>
            <Match when={!others.indeterminate}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="size-3"
                aria-hidden="true"
              >
                <path d="M5 12l5 5l10 -10" />
              </svg>
            </Match>
            <Match when={others.indeterminate}>
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
                class="size-3"
                aria-hidden="true"
              >
                <path d="M5 12l14 0" />
              </svg>
            </Match>
          </Switch>
        </CheckboxPrimitive.Indicator>
      </CheckboxPrimitive.Control>
      {local.children}
    </CheckboxPrimitive.Root>
  );
};

type CheckboxLabelProps<T extends ValidComponent = "label"> =
  CheckboxPrimitive.CheckboxLabelProps<T> & { class?: string | undefined };

const CheckboxLabel = <T extends ValidComponent = "label">(
  props: PolymorphicProps<T, CheckboxLabelProps<T>>,
) => {
  const [local, others] = splitProps(props as CheckboxLabelProps, ["class"]);
  return (
    <CheckboxPrimitive.Label
      class={cn("cursor-pointer text-base text-muted-foreground select-none", local.class)}
      {...others}
    />
  );
};

export { Checkbox, CheckboxLabel };
