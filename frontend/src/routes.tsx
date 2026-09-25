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
const Speed = lazy(() => import("~/features/settings/speed"));
const PlannedSettings = lazy(() => import("~/features/settings/planned"));

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
      <Route path="/settings/speed" component={Speed} />
      <Route path="/settings/:section" component={PlannedSettings} />
      <Route path="*" component={() => <Navigate href="/torrents" />} />
    </Route>
  </>
);
