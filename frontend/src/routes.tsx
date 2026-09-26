// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The route table (AGENTS.md 4.5): one lazy chunk per feature. Sign-in and
// setup are public; everything else is behind the signed-in shell.

import { Navigate, Route } from "@solidjs/router";
import { lazy } from "solid-js";

import Protected from "~/features/shell/protected";
import { planned } from "~/features/shell/planned";

const SignIn = lazy(() => import("~/features/auth/sign-in"));
const Setup = lazy(() => import("~/features/auth/setup"));
const Torrents = lazy(() => import("~/features/torrents/torrents"));

const Stats = planned(
  "Stats",
  "W6",
  "Traffic over time, seeding days, rankings, places and breakdowns come from the daemon's history.",
);
const Rss = planned("RSS", "W5", "Feeds, articles and automatic download rules.");
const Log = planned("Log", "W4", "The daemon's main log and the log of banned peers.");
const Downloads = lazy(() => import("~/features/settings/downloads"));
const Speed = lazy(() => import("~/features/settings/speed"));
const Queue = lazy(() => import("~/features/settings/queue"));
const Connection = lazy(() => import("~/features/settings/connection"));
const BitTorrent = lazy(() => import("~/features/settings/bittorrent"));
const Banned = lazy(() => import("~/features/settings/banned"));
const WatchFolders = lazy(() => import("~/features/settings/watch-folders"));
const RssSettings = lazy(() => import("~/features/settings/rss-settings"));
const Webhooks = lazy(() => import("~/features/settings/webhooks"));
const Statistics = lazy(() => import("~/features/settings/statistics"));
const Security = lazy(() => import("~/features/settings/security"));
const Engine = lazy(() => import("~/features/settings/engine"));
const About = lazy(() => import("~/features/settings/about"));

export const routes = (
  <>
    <Route path="/sign-in" component={SignIn} />
    <Route path="/setup" component={Setup} />
    <Route path="/" component={Protected}>
      <Route path="/" component={() => <Navigate href="/torrents" />} />
      <Route path="/torrents/:hash?" component={Torrents} />
      <Route path="/stats/*" component={Stats} />
      <Route path="/rss/*" component={Rss} />
      <Route path="/log/*" component={Log} />
      <Route path="/settings" component={() => <Navigate href="/settings/speed" />} />
      <Route path="/settings/downloads" component={Downloads} />
      <Route path="/settings/speed" component={Speed} />
      <Route path="/settings/queue" component={Queue} />
      <Route path="/settings/connection" component={Connection} />
      <Route path="/settings/bittorrent" component={BitTorrent} />
      <Route path="/settings/bans" component={Banned} />
      <Route path="/settings/watch-folders" component={WatchFolders} />
      <Route path="/settings/rss" component={RssSettings} />
      <Route path="/settings/webhooks" component={Webhooks} />
      <Route path="/settings/statistics" component={Statistics} />
      <Route path="/settings/security" component={Security} />
      <Route path="/settings/engine" component={Engine} />
      <Route path="/settings/about" component={About} />
      <Route path="/settings/*" component={() => <Navigate href="/settings/speed" />} />
      <Route path="*" component={() => <Navigate href="/torrents" />} />
    </Route>
  </>
);
