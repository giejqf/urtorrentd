// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The route table (AGENTS.md 4.5): one lazy chunk per feature. Sign-in and
// setup are public; everything else is behind the signed-in shell.

import { Navigate, Route } from "@solidjs/router";
import { lazy } from "solid-js";

import Protected from "~/features/shell/protected";

const SignIn = lazy(() => import("~/features/auth/sign-in"));
const Setup = lazy(() => import("~/features/auth/setup"));
const Torrents = lazy(() => import("~/features/torrents/torrents"));

const StatsOverview = lazy(() => import("~/features/stats/overview"));
const StatsTrackers = lazy(() => import("~/features/stats/trackers"));
const StatsPeers = lazy(() => import("~/features/stats/peers"));
const StatsIdle = lazy(() => import("~/features/stats/idle"));
const StatsTimeline = lazy(() => import("~/features/stats/timeline"));
const Rss = lazy(() => import("~/features/rss/rss"));
const Log = lazy(() => import("~/features/log/log"));
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
      <Route path="/stats" component={StatsOverview} />
      <Route path="/stats/trackers" component={StatsTrackers} />
      <Route path="/stats/peers" component={StatsPeers} />
      <Route path="/stats/idle-seeds" component={StatsIdle} />
      <Route path="/stats/timeline" component={StatsTimeline} />
      <Route path="/stats/*" component={() => <Navigate href="/stats" />} />
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
