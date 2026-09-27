// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors
// Based on solid-ui (MIT): Copyright (c) 2023 shadcn, Copyright (c) 2023 Stefan E-K.

import type { JSX, ValidComponent } from "solid-js";
import { splitProps } from "solid-js";

import type { PolymorphicProps } from "@kobalte/core";
import * as SwitchPrimitive from "@kobalte/core/switch";

import { cn } from "~/lib/utils";

// The design's `.sw`: a 36×20 pill, dark when off, white when on, its
// 16px thumb white when off and dark when on (in the light theme: a grey
// pill when off, dark when on, the thumb white both ways).
const Switch = SwitchPrimitive.Root;
const SwitchDescription = SwitchPrimitive.Description;

type SwitchControlProps = SwitchPrimitive.SwitchControlProps & {
  class?: string | undefined;
  children?: JSX.Element;
};

const SwitchControl = <T extends ValidComponent = "input">(
  props: PolymorphicProps<T, SwitchControlProps>,
) => {
  const [local, others] = splitProps(props as SwitchControlProps, ["class", "children"]);
  return (
    <>
      <SwitchPrimitive.Input class="peer" />
      <SwitchPrimitive.Control
        class={cn(
          "relative inline-flex h-5 w-9 flex-none cursor-pointer items-center rounded-full bg-border transition-colors peer-focus-visible:shadow-focus peer-focus-visible:ring-1 peer-focus-visible:ring-ring data-[checked]:bg-primary data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50",
          local.class,
        )}
        {...others}
      >
        <SwitchPrimitive.Thumb class="pointer-events-none absolute top-0.5 left-0.5 block size-4 rounded-full bg-switch-thumb shadow-sm transition-transform data-[checked]:translate-x-4 data-[checked]:bg-primary-foreground" />
        {local.children}
      </SwitchPrimitive.Control>
    </>
  );
};

type SwitchLabelProps = SwitchPrimitive.SwitchLabelProps & { class?: string | undefined };

const SwitchLabel = <T extends ValidComponent = "label">(
  props: PolymorphicProps<T, SwitchLabelProps>,
) => {
  const [local, others] = splitProps(props as SwitchLabelProps, ["class"]);
  return (
    <SwitchPrimitive.Label
      class={cn(
        "text-base text-foreground data-[disabled]:cursor-not-allowed data-[disabled]:opacity-70",
        local.class,
      )}
      {...others}
    />
  );
};

export { Switch, SwitchControl, SwitchLabel, SwitchDescription };
