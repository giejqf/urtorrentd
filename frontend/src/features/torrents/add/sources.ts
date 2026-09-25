// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The add dialog's sources and what the daemon says of them: a preview for
// each link (`POST /previews`, polled while it fetches; AGENTS.md 4.1) and
// the metadata of each `.torrent` file (`POST /torrents/parse`). Previews
// the dialog asked for and did not use are dropped (`DELETE /previews`).

import { batch, onCleanup } from "solid-js";
import { createStore, produce } from "solid-js/store";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";

import { type LinkSource, NORMAL } from "./form";

/** Previews the dialog asks for at most (the daemon holds 32 in all). */
const MAX_PREVIEWS = 16;

export type SourceStatus =
  /** Downloading the `.torrent`, or fetching the metadata. */
  | "fetching"
  | "ready"
  | "failed"
  /** The daemon has it already. */
  | "duplicate"
  /** Not previewed (too many at once); it can still be added. */
  | "unpreviewed";

export interface Source {
  key: string;
  kind: LinkSource["kind"] | "file";
  /** What is sent for a link. */
  text: string;
  label: string;
  status: SourceStatus;
  hash: string | null;
  metadata: Schemas["TorrentMetadata"] | null;
  peers: number | null;
  seeds: number | null;
  swarmSeeds: number | null;
  swarmLeechers: number | null;
  error: string | null;
  /** The dialog asked the daemon for this preview (drop it if unused). */
  previewed: boolean;
  /** Per file, when the user changed any. */
  priorities: number[] | undefined;
  /** A `.torrent` file's bytes, base64. */
  torrent: string | null;
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(text);
}

function blank(key: string, kind: Source["kind"], text: string, label: string): Source {
  return {
    key,
    kind,
    text,
    label,
    status: "fetching",
    hash: null,
    metadata: null,
    peers: null,
    seeds: null,
    swarmSeeds: null,
    swarmLeechers: null,
    error: null,
    previewed: false,
    priorities: undefined,
    torrent: null,
  };
}

export function createSources(isAdded: (hash: string) => boolean) {
  const [list, setList] = createStore<Source[]>([]);
  const set = (key: string, f: (s: Source) => void) =>
    setList(
      produce((all) => {
        const s = all.find((x) => x.key === key);
        if (s) f(s);
      }),
    );

  const apply = (key: string, p: Schemas["PreviewInfo"]) =>
    set(key, (s) => {
      s.hash = p.hash;
      s.label = p.name || s.label;
      s.status = p.state;
      s.metadata = p.metadata;
      s.peers = p.peers;
      s.seeds = p.seeds;
      s.swarmSeeds = p.swarm_seeds;
      s.swarmLeechers = p.swarm_leechers;
      s.error = p.error;
    });

  const failed = (key: string, e: unknown) =>
    set(key, (s) => {
      if (e instanceof ApiError && e.code === "duplicate") {
        s.status = "duplicate";
        s.error = "Already in the list: it will be skipped.";
      } else if (e instanceof ApiError && e.code === "busy") {
        s.status = "unpreviewed";
        s.error = e.message;
      } else {
        s.status = "failed";
        s.error = e instanceof ApiError ? e.message : "The daemon did not answer.";
      }
    });

  const preview = async (key: string, text: string) => {
    if (list.filter((s) => s.previewed).length >= MAX_PREVIEWS) {
      set(key, (s) => {
        s.status = "unpreviewed";
        s.error = `Only the first ${MAX_PREVIEWS} sources are previewed.`;
      });
      return;
    }
    try {
      const p = await unwrap(api.POST("/api/v1/previews", { body: { source: text } }));
      if (!list.some((s) => s.key === key)) {
        // Removed while the daemon worked: let it go.
        void drop(p.hash);
        return;
      }
      set(key, (s) => {
        s.previewed = true;
      });
      apply(key, p);
    } catch (e) {
      failed(key, e);
    }
  };

  const drop = (hash: string) =>
    unwrap(api.DELETE("/api/v1/previews/{hash}", { params: { path: { hash } } })).catch(
      () => undefined,
    );

  // Poll the previews that are still fetching.
  const timer = setInterval(() => {
    for (const s of list) {
      if (s.status !== "fetching" || !s.previewed || !s.hash) continue;
      const { key, hash } = s;
      unwrap(api.GET("/api/v1/previews/{hash}", { params: { path: { hash } } }))
        .then((p) => apply(key, p))
        .catch((e) => failed(key, e));
    }
  }, 1_000);
  onCleanup(() => clearInterval(timer));

  return {
    list,
    /** Follow the links typed: preview new ones, drop removed ones. */
    setLinks(links: readonly LinkSource[]) {
      const keep = new Set(links.map((l) => `link:${l.text}`));
      const gone = list.filter((s) => s.kind !== "file" && !keep.has(s.key));
      const fresh = links.filter((l) => !list.some((s) => s.key === `link:${l.text}`));
      batch(() => {
        if (gone.length > 0) setList((all) => all.filter((s) => !gone.includes(s)));
        for (const l of fresh)
          setList(list.length, blank(`link:${l.text}`, l.kind, l.text, l.label));
      });
      for (const s of gone) if (s.previewed && s.hash) void drop(s.hash);
      for (const l of fresh) void preview(`link:${l.text}`, l.text);
    },
    async addFiles(files: readonly File[]) {
      for (const f of files) {
        const key = `file:${f.name}:${f.size}:${f.lastModified}`;
        if (list.some((s) => s.key === key)) continue;
        setList(list.length, blank(key, "file", "", f.name));
        try {
          const torrent = base64(new Uint8Array(await f.arrayBuffer()));
          const m = await unwrap(api.POST("/api/v1/torrents/parse", { body: { torrent } }));
          set(key, (s) => {
            s.torrent = torrent;
            s.hash = m.hash;
            s.label = m.name;
            s.metadata = m;
            s.status = isAdded(m.hash) ? "duplicate" : "ready";
            s.error = isAdded(m.hash) ? "Already in the list: it will be skipped." : null;
          });
        } catch (e) {
          failed(key, e);
        }
      }
    },
    removeFile(key: string) {
      setList((all) => all.filter((s) => s.key !== key));
    },
    setPriority(key: string, index: number, priority: number) {
      set(key, (s) => {
        const n = s.metadata?.files.length ?? 0;
        const p = s.priorities ?? Array.from({ length: n }, () => NORMAL);
        p[index] = priority;
        s.priorities = [...p];
      });
    },
    /** Mark a source added (the daemon took its preview) and leave it out. */
    added(key: string) {
      setList((all) => all.filter((s) => s.key !== key));
    },
    notAdded(key: string, message: string) {
      set(key, (s) => {
        s.status = "failed";
        s.error = `Not added: ${message}`;
      });
    },
    /** Drop every preview the dialog asked for (closing without adding). */
    dropAll() {
      for (const s of list) if (s.previewed && s.hash) void drop(s.hash);
      setList([]);
    },
  };
}

export type Sources = ReturnType<typeof createSources>;

/** Whether a source goes into the request. */
export function addable(s: Source): boolean {
  if (s.status === "duplicate") return false;
  if (s.status === "failed") return s.kind === "magnet" || s.kind === "hash";
  return s.kind !== "file" || s.torrent !== null;
}
