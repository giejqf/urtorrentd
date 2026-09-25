// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Real daemons for end-to-end tests (AGENTS.md 7.4). Each starts from the
// debug build with its own data directory, offline from its first second
// (`--initial-settings`: peers on one loopback address, no DHT, no LSD, no
// bootstrap nodes), and serves the built UI (`--web-ui dist`), so the
// browser gets exactly what production serves. The harness talks to the
// API with an API key, never through `api_bypass_local_auth`, which would
// let the browser in without signing in and hide auth bugs.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import createClient, { type Client } from "openapi-fetch";

import type { paths } from "../src/api/schema";

const ROOT = resolve(import.meta.dirname, "../..");
export const BINARY = process.env.URTORRENTD_BIN ?? join(ROOT, "target/debug/urtorrentd");
export const UI_DIR = process.env.URTORRENTD_WEB_UI ?? join(ROOT, "frontend/dist");

export const CREDENTIALS = { username: "admin", password: "correct horse battery" };

async function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const address = s.address();
      const port = typeof address === "object" && address ? address.port : 0;
      s.close(() => ok(port));
    });
  });
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

export interface DaemonOptions {
  /** The loopback address its peers listen on (`127.x.y.z`). */
  peerIp: string;
  /** More first-start settings. */
  settings?: Record<string, unknown>;
  /** Leave first-run setup open (no credentials). */
  fresh?: boolean;
}

export class Daemon {
  /** The daemon's origin: the UI at `/`, the API at `/api/v1`. */
  readonly url: string;
  readonly peerIp: string;
  /** Where its torrents are saved. */
  readonly savePath: string;
  /** The API as the harness uses it (with an API key once set up). */
  api: Client<paths>;
  private readonly dir: string;
  private readonly proc: ChildProcess;
  private output = "";

  private constructor(url: string, peerIp: string, dir: string, proc: ChildProcess) {
    this.url = url;
    this.peerIp = peerIp;
    this.dir = dir;
    this.savePath = join(dir, "downloads");
    this.proc = proc;
    this.api = createClient<paths>({ baseUrl: url });
    const keep = (chunk: Buffer) => {
      this.output = (this.output + chunk.toString()).slice(-20_000);
    };
    proc.stdout?.on("data", keep);
    proc.stderr?.on("data", keep);
  }

  static async start(opts: DaemonOptions): Promise<Daemon> {
    for (const [what, path] of [
      ["the daemon (cargo build -p urtorrentd)", BINARY],
      ["the UI (npm run build)", join(UI_DIR, "index.html")],
    ] as const) {
      if (!existsSync(path)) throw new Error(`build ${what} first: ${path} is missing`);
    }
    const dir = mkdtempSync(join(tmpdir(), "urtorrentd-e2e-"));
    const settings = {
      listen_port: 0,
      listen_v4: opts.peerIp,
      listen_v6: null,
      dht: false,
      lsd: false,
      dht_bootstrap_nodes: [],
      save_path: join(dir, "downloads"),
      ...opts.settings,
    };
    const initial = join(dir, "initial.json");
    writeFileSync(initial, JSON.stringify(settings));
    const port = await freePort();
    const proc = spawn(
      BINARY,
      [
        "--data-dir",
        join(dir, "data"),
        "--api-listen",
        `127.0.0.1:${port}`,
        "--initial-settings",
        initial,
        "--web-ui",
        UI_DIR,
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RUST_LOG: "warn" } },
    );
    const d = new Daemon(`http://127.0.0.1:${port}`, opts.peerIp, dir, proc);
    await d.waitUp();
    if (!opts.fresh) await d.setup();
    return d;
  }

  private async waitUp(): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) {
        throw new Error(`the daemon exited (${this.proc.exitCode}):\n${this.output}`);
      }
      try {
        const r = await fetch(`${this.url}/api/v1/auth/status`);
        if (r.ok) return;
      } catch {
        // not listening yet
      }
      await sleep(50);
    }
    throw new Error(`the daemon did not come up:\n${this.output}`);
  }

  /** First-run setup with {@link CREDENTIALS}, then an API key for the harness. */
  async setup(): Promise<void> {
    const r = await fetch(`${this.url}/api/v1/auth/setup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(CREDENTIALS),
    });
    if (r.status !== 204) throw new Error(`setup: ${r.status} ${await r.text()}`);
    const cookie = (r.headers.getSetCookie()[0] ?? "").split(";")[0] ?? "";
    const k = await fetch(`${this.url}/api/v1/auth/api-key`, {
      method: "POST",
      headers: { cookie },
    });
    if (!k.ok) throw new Error(`api key: ${k.status} ${await k.text()}`);
    const { api_key } = (await k.json()) as { api_key: string };
    this.api = createClient<paths>({
      baseUrl: this.url,
      headers: { authorization: `Bearer ${api_key}` },
    });
  }

  /** The daemon's recent output, for failure messages. */
  log(): string {
    return this.output;
  }

  /** Stop gracefully (SIGTERM takes the shutdown endpoint's path), or kill. */
  async stop(): Promise<void> {
    if (this.proc.exitCode === null) {
      this.proc.kill("SIGTERM");
      const deadline = Date.now() + 15_000;
      while (this.proc.exitCode === null && Date.now() < deadline) await sleep(50);
      if (this.proc.exitCode === null) this.proc.kill("SIGKILL");
    }
    rmSync(this.dir, { recursive: true, force: true });
  }

  /** The address its peers listen on, as `ip:port`. */
  async peerAddress(): Promise<string> {
    const { data } = await this.api.GET("/api/v1/app");
    if (!data) throw new Error("GET /app failed");
    return `${this.peerIp}:${data.listen_port}`;
  }

  /** Poll one torrent through the API until `done` holds. */
  async waitFor(
    hash: string,
    done: (t: Record<string, unknown>) => boolean,
    what: string,
    ms = 30_000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + ms;
    for (;;) {
      const { data } = await this.api.GET("/api/v1/torrents/{hash}", {
        params: { path: { hash } },
      });
      if (data && done(data as Record<string, unknown>)) return data as Record<string, unknown>;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting for ${what}: ${JSON.stringify(data)}`);
      await sleep(100);
    }
  }
}
