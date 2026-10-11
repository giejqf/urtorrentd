// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The README's badges, made with badge-maker from what the repository says
// (Cargo.toml, rust-toolchain.toml, openapi.json, docs/api.md,
// docs/settings.md), so they never drift from it. Run `cargo xtask badges`
// after a release or a change to those files, and commit the SVGs.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeBadge } from "badge-maker";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const read = (path) => readFileSync(join(root, path), "utf8");

function must(text, re, what) {
  const m = text.match(re);
  if (!m) throw new Error(`cannot find ${what}`);
  return m[1];
}

const version = must(read("Cargo.toml"), /^version = "([^"]+)"/m, "the workspace version");
const toolchain = must(read("rust-toolchain.toml"), /^channel = "([^"]+)"/m, "the toolchain");
const edition = must(read("Cargo.toml"), /^edition = "([^"]+)"/m, "the edition");
const library = must(read("crates/urtorrentd/Cargo.toml"), /^urtorrent = "([^"]+)"/m, "urtorrent");
const spec = JSON.parse(read("openapi.json"));
const operations = Object.values(spec.paths)
  .flatMap((item) => Object.keys(item))
  .filter((m) => ["get", "post", "put", "patch", "delete"].includes(m)).length;

// The coverage tables: one row per action or preference key of the reference.
const rows = (path, statuses) => {
  const counts = Object.fromEntries(statuses.map((s) => [s, 0]));
  for (const line of read(path).split("\n")) {
    const m = line.match(/^\| `[^`]+` \| ([a-z/]+) \|/);
    if (m && m[1] in counts) counts[m[1]] += 1;
  }
  return counts;
};
const api = rows("docs/api.md", ["done", "unsupported"]);
const prefs = rows("docs/settings.md", ["setting", "done", "fixed", "n/a", "unsupported"]);
const prefsTotal = Object.values(prefs).reduce((a, b) => a + b, 0);

// The project's mark (frontend/public/favicon.svg), white on the label.
const logo = read("frontend/public/favicon.svg").replace(/<style>.*?<\/style>/, "").replace("currentColor", "#fff");
const logoBase64 = `data:image/svg+xml;base64,${Buffer.from(logo).toString("base64")}`;

const label = "#30363d";
const brand = "#3987e5";
const badges = {
  version: { label: "urtorrentd", message: `v${version}`, color: brand, logoBase64 },
  licence: { label: "licence", message: "Apache-2.0", color: "#6e7781" },
  rust: { label: "rust", message: `${toolchain} · ${edition}`, color: "#c4572a" },
  library: { label: "urtorrent", message: library, color: "#8250df" },
  platform: { label: "platform", message: "Linux 6.1+ · io_uring", color: "#2da44e" },
  openapi: { label: "OpenAPI 3.1", message: `${operations} operations`, color: "#1f883d" },
  webapi: {
    label: "qBittorrent WebAPI",
    message: `${api.done} done · ${api.unsupported} unsupported`,
    color: brand,
  },
  settings: {
    label: "preferences",
    message: `${prefsTotal}/${prefsTotal} mapped`,
    color: brand,
  },
  webui: { label: "web UI", message: "built in", color: "#0e7490" },
};

for (const [name, b] of Object.entries(badges)) {
  const svg = makeBadge({ labelColor: label, style: "flat", ...b });
  writeFileSync(join(here, `${name}.svg`), `${svg}\n`);
  console.log(`${name}.svg: ${b.label} | ${b.message}`);
}
