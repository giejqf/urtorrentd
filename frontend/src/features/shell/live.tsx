// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The live store for the signed-in app (AGENTS.md 4.3): one event stream
// per session, feeding torrents, categories, tags and the transfer state.

import {
  type Accessor,
  createContext,
  createMemo,
  createSignal,
  onCleanup,
  type ParentComponent,
  useContext,
} from "solid-js";
import { createStore } from "solid-js/store";

import type { Schemas } from "~/api/client";
import { applySync, type Connection, connectLive, emptyLive, type LiveState } from "~/api/live";
import { useAuth } from "~/features/auth/auth";

interface Live {
  state: LiveState;
  connection: Accessor<Connection>;
  /** Every torrent (store proxies: reading a field tracks that field). */
  torrents: Accessor<Schemas["TorrentSummary"][]>;
  /** Whether the first update arrived. */
  ready: Accessor<boolean>;
  /** When the last update arrived (ms), `null` before the first. */
  updatedAt: Accessor<number | null>;
  /** Open the stream again now instead of at the next retry. */
  reconnect: () => void;
}

const LiveContext = createContext<Live>();

export const LiveProvider: ParentComponent = (props) => {
  const auth = useAuth();
  const [state, setState] = createStore<LiveState>(emptyLive());
  const [connection, setConnection] = createSignal<Connection>("connecting");
  const [updatedAt, setUpdatedAt] = createSignal<number | null>(null);
  const stream = connectLive({
    onUpdate: (u) => {
      applySync(setState, u);
      setUpdatedAt(Date.now());
    },
    onConnection: (c) => {
      setConnection(c);
      if (c === "signed_out") void auth.sessionEnded();
    },
  });
  onCleanup(() => stream.close());
  const torrents = createMemo(() => Object.values(state.torrents));
  const ready = () => state.rev !== null;
  return (
    <LiveContext.Provider
      value={{ state, connection, torrents, ready, updatedAt, reconnect: () => stream.reconnect() }}
    >
      {props.children}
    </LiveContext.Provider>
  );
};

export function useLive(): Live {
  const live = useContext(LiveContext);
  if (!live) throw new Error("useLive outside LiveProvider");
  return live;
}
