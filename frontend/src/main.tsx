// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import "~/app.css";

import { render } from "solid-js/web";

import { App } from "~/app";
import { startTheme } from "~/lib/theme";

startTheme();

const root = document.getElementById("root");
if (root) render(() => <App />, root);
