// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The settings sections, in the navigation's order (the palette and the
// end-to-end tests read them too).

export interface Section {
  id: string;
  label: string;
}

export const SECTIONS: readonly { title: string; items: readonly Section[] }[] = [
  {
    title: "Transfer",
    items: [
      { id: "downloads", label: "Downloads" },
      { id: "speed", label: "Speed" },
      { id: "queue", label: "Queue & share limits" },
    ],
  },
  {
    title: "Network",
    items: [
      { id: "connection", label: "Connection" },
      { id: "bittorrent", label: "BitTorrent" },
      { id: "bans", label: "Banned addresses" },
    ],
  },
  {
    title: "Automation",
    items: [
      { id: "watch-folders", label: "Watch folders" },
      { id: "rss", label: "RSS" },
      { id: "webhooks", label: "Webhooks" },
    ],
  },
  {
    title: "Daemon",
    items: [
      { id: "statistics", label: "Statistics & GeoIP" },
      { id: "security", label: "Security & API" },
      { id: "engine", label: "Engine" },
      { id: "about", label: "About" },
    ],
  },
];
