// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Magnet links clicked in the browser open this page's add dialog: the
// browser hands them to `/torrents?add=<link>` once the user lets it
// (`registerProtocolHandler`, only in a secure context: HTTPS or localhost).

/** The page's address the browser sends magnet links to. */
export function magnetHandlerUrl(origin: string): string {
  return `${origin}/torrents?add=%s`;
}

/** Whether this browser can be asked to open magnet links here. */
export function canHandleMagnets(): boolean {
  return window.isSecureContext && typeof navigator.registerProtocolHandler === "function";
}

/** Ask the browser to open magnet links here; it asks the user to confirm. */
export function handleMagnets(): void {
  navigator.registerProtocolHandler("magnet", magnetHandlerUrl(window.location.origin));
}

/** `.torrent` files among dropped or pasted ones. */
export function torrentFiles(files: FileList | readonly File[] | null | undefined): File[] {
  return [...(files ?? [])].filter((f) => /\.torrent$/i.test(f.name));
}
