// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// `.torrent` files for tests (AGENTS.md 7.4): random content, bencoded
// metainfo with SHA-1 piece hashes, and its v1 info-hash. Tests never
// download anything from outside: a seeder daemon gets the content on disk.

import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Bencodable = number | string | Buffer | Bencodable[] | { [key: string]: Bencodable };

export function bencode(value: Bencodable): Buffer {
  if (typeof value === "number") return Buffer.from(`i${Math.trunc(value)}e`);
  if (typeof value === "string") return bencode(Buffer.from(value, "utf8"));
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from(`${value.length}:`), value]);
  if (Array.isArray(value)) {
    return Buffer.concat([Buffer.from("l"), ...value.map(bencode), Buffer.from("e")]);
  }
  // Keys in byte order; ours are ASCII.
  const keys = Object.keys(value).sort();
  const parts = keys.flatMap((k) => [bencode(k), bencode(value[k] as Bencodable)]);
  return Buffer.concat([Buffer.from("d"), ...parts, Buffer.from("e")]);
}

export interface TestFile {
  /** Path inside the torrent (below its name for multi-file torrents). */
  path: string;
  size: number;
}

export interface TestTorrent {
  name: string;
  /** Lowercase hex v1 info-hash. */
  hash: string;
  /** The `.torrent` file. */
  bytes: Buffer;
  /** The `.torrent` file, base64 (as `POST /torrents` takes it). */
  base64: string;
  size: number;
  pieceLength: number;
  pieces: number;
  /** Write the content under `dir` (a seeder's save path). */
  writeContent(dir: string): void;
}

export interface TorrentOptions {
  name: string;
  /** One file of this size (default), or several below a folder. */
  size?: number;
  files?: TestFile[];
  pieceLength?: number;
  private?: boolean;
  /** Announce URLs (loopback only in tests). */
  trackers?: string[];
}

export function makeTorrent(opts: TorrentOptions): TestTorrent {
  const pieceLength = opts.pieceLength ?? 16_384;
  const files = opts.files ?? [{ path: opts.name, size: opts.size ?? 256 * 1024 }];
  const single = opts.files === undefined;
  const contents = files.map((f) => ({ ...f, data: randomBytes(f.size) }));
  const all = Buffer.concat(contents.map((c) => c.data));
  const hashes: Buffer[] = [];
  for (let at = 0; at < all.length; at += pieceLength) {
    hashes.push(
      createHash("sha1")
        .update(all.subarray(at, at + pieceLength))
        .digest(),
    );
  }
  const info: { [key: string]: Bencodable } = {
    name: opts.name,
    "piece length": pieceLength,
    pieces: Buffer.concat(hashes),
  };
  if (single) info.length = all.length;
  else info.files = contents.map((c) => ({ length: c.size, path: c.path.split("/") }));
  if (opts.private) info.private = 1;
  const meta: { [key: string]: Bencodable } = { info };
  if (opts.trackers?.length) {
    meta.announce = opts.trackers[0] as string;
    meta["announce-list"] = opts.trackers.map((t) => [t]);
  }
  const bytes = bencode(meta);
  return {
    name: opts.name,
    hash: createHash("sha1").update(bencode(info)).digest("hex"),
    bytes,
    base64: bytes.toString("base64"),
    size: all.length,
    pieceLength,
    pieces: hashes.length,
    writeContent(dir: string) {
      for (const c of contents) {
        const path = single ? join(dir, c.path) : join(dir, opts.name, c.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, c.data);
      }
    },
  };
}
