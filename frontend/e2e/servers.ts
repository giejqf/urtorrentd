// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Small local servers for serving specs (AGENTS.md 7.4): a page on another
// loopback origin (CORS), and a forwarding proxy that behaves like Caddy
// in front of the daemon (keeps `Host`, adds `X-Forwarded-*`, streams).

import { createServer, request, type Server } from "node:http";

export interface Local {
  port: number;
  origin: string;
  close(): Promise<void>;
}

async function listen(server: Server, host = "127.0.0.1"): Promise<Local> {
  await new Promise<void>((ok) => server.listen(0, host, ok));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    port,
    origin: `http://${host}:${port}`,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(() => ok());
      }),
  };
}

/** A blank page on its own origin. */
export function blankPage(): Promise<Local> {
  return listen(
    createServer((_, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end("<!doctype html><html lang=en><title>elsewhere</title><main>elsewhere</main>");
    }),
  );
}

/**
 * A reverse proxy to `target` that says the client used HTTPS, as a
 * TLS-terminating Caddy would: `Host` is kept, `X-Forwarded-For`,
 * `-Host` and `-Proto` are added, and responses stream (the event stream).
 */
export function forwardingProxy(target: string): Promise<Local> {
  const t = new URL(target);
  return listen(
    createServer((req, res) => {
      const client = (req.socket.remoteAddress ?? "").replace(/^::ffff:/, "");
      const up = request(
        {
          host: t.hostname,
          port: t.port,
          method: req.method,
          path: req.url,
          headers: {
            ...req.headers,
            "x-forwarded-for": client,
            "x-forwarded-host": req.headers.host ?? "",
            "x-forwarded-proto": "https",
          },
        },
        (r) => {
          res.writeHead(r.statusCode ?? 502, r.headers);
          r.pipe(res);
        },
      );
      up.on("error", () => {
        res.writeHead(502);
        res.end();
      });
      req.pipe(up);
    }),
  );
}
