// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors
// Based on solid-ui (MIT): Copyright (c) 2023 shadcn, Copyright (c) 2023 Stefan E-K.

import type { Component, JSX, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";

import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import * as ProgressPrimitive from "@kobalte/core/progress";

import { Label } from "~/components/ui/label";
import { cn } from "~/lib/utils";

type ProgressRootProps<T extends ValidComponent = "div"> =
  ProgressPrimitive.ProgressRootProps<T> & {
    class?: string | undefined;
    /** Classes for the filled part (its colour: `bg-brand`, `bg-ok`). */
    fillClass?: string | undefined;
    children?: JSX.Element;
  };

// The design's progress bar: 4px, fully rounded, on the divider colour.
const Progress = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, ProgressRootProps<T>>,
) => {
  const [local, others] = splitProps(props as ProgressRootProps, [
    "children",
    "class",
    "fillClass",
  ]);
  return (
    <ProgressPrimitive.Root class={cn("flex flex-col gap-1.5", local.class)} {...others}>
      {local.children}
      <ProgressPrimitive.Track class="relative h-1 w-full overflow-hidden rounded-full bg-divider">
        <ProgressPrimitive.Fill
          class={cn(
            "h-full w-[var(--kb-progress-fill-width)] bg-brand transition-[width]",
            local.fillClass,
          )}
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
};

const ProgressLabel: Component<ProgressPrimitive.ProgressLabelProps> = (props) => {
  return <ProgressPrimitive.Label as={Label} {...props} />;
};

const ProgressValueLabel: Component<ProgressPrimitive.ProgressValueLabelProps> = (props) => {
  return <ProgressPrimitive.ValueLabel as={Label} {...props} />;
};

export { Progress, ProgressLabel, ProgressValueLabel };
