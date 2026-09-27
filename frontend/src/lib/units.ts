// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Whether sizes and rates are written in binary units (KiB, MiB) instead of
// the design's decimal ones: a viewer's preference (lib/theme.ts keeps it).
// A signal, so every size on the page follows a change.

import { createSignal } from "solid-js";

const [binary, setBinary] = createSignal(false);

/** Binary units are chosen. */
export const binaryUnits = binary;
/** Set by the preference. */
export const setBinaryUnits = (on: boolean) => setBinary(on);
