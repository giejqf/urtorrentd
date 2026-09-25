// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors
// Based on solid-ui (MIT): Copyright (c) 2023 shadcn, Copyright (c) 2023 Stefan E-K.

import type { ValidComponent } from "solid-js";
import { splitProps } from "solid-js";

import type { PolymorphicProps } from "@kobalte/core/polymorphic";
import * as SkeletonPrimitive from "@kobalte/core/skeleton";

import { cn } from "~/lib/utils";

type SkeletonRootProps<T extends ValidComponent = "div"> =
  SkeletonPrimitive.SkeletonRootProps<T> & { class?: string | undefined };

const Skeleton = <T extends ValidComponent = "div">(
  props: PolymorphicProps<T, SkeletonRootProps<T>>,
) => {
  const [local, others] = splitProps(props as SkeletonRootProps, ["class"]);
  return (
    <SkeletonPrimitive.Root
      class={cn("rounded-md bg-muted data-[animate='true']:animate-pulse", local.class)}
      {...others}
    />
  );
};

export { Skeleton };
