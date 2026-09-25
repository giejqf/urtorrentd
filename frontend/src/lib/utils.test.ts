// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import { cn } from "./utils";

describe("cn", () => {
  it("keeps the theme's font sizes next to colours", () => {
    expect(cn("text-md text-subtle")).toBe("text-md text-subtle");
    expect(cn("text-2xs", "text-faint")).toBe("text-2xs text-faint");
  });

  it("lets a later class of the same kind win", () => {
    expect(cn("text-sm", "text-md")).toBe("text-md");
    expect(cn("rounded-md", "rounded-card")).toBe("rounded-card");
    expect(cn("shadow-menu", "shadow-card")).toBe("shadow-card");
    expect(cn("bg-card", false, "bg-muted")).toBe("bg-muted");
  });
});
