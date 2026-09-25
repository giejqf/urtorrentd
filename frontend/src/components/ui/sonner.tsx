// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors
// Based on solid-ui (MIT): Copyright (c) 2023 shadcn, Copyright (c) 2023 Stefan E-K.

import type { Component, ComponentProps } from "solid-js";

import { Toaster as Sonner } from "solid-sonner";

type ToasterProps = ComponentProps<typeof Sonner>;

// Toasts on the popover surface; the daemon's message goes in the
// description (AGENTS.md 4.1).
const Toaster: Component<ToasterProps> = (props) => {
  return (
    <Sonner
      theme="dark"
      class="toaster group"
      toastOptions={{
        classes: {
          toast:
            "group toast group-[.toaster]:rounded-lg group-[.toaster]:border-border group-[.toaster]:bg-popover group-[.toaster]:text-base group-[.toaster]:text-popover-foreground group-[.toaster]:shadow-menu",
          title: "group-[.toast]:font-medium",
          description: "group-[.toast]:text-sm group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          error: "group-[.toaster]:[&_[data-icon]]:text-danger",
          success: "group-[.toaster]:[&_[data-icon]]:text-ok",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
