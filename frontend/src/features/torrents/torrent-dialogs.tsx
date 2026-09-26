// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The torrents screen's dialogs (remove, move, share limits), opened from
// the list's menu and keys, the selection bar, the panels and their tabs.

import { createContext, createSignal, type ParentProps, useContext } from "solid-js";

import { DeleteDialog } from "./delete-dialog";
import { MoveDialog } from "./move-dialog";
import { ShareLimitsDialog } from "./share-limits-dialog";

interface TorrentDialogs {
  remove: (hashes: readonly string[]) => void;
  move: (hashes: readonly string[]) => void;
  shareLimits: (hashes: readonly string[]) => void;
}

const Context = createContext<TorrentDialogs>();

export function TorrentDialogsProvider(
  props: ParentProps<{ onRemoved?: (hashes: readonly string[]) => void }>,
) {
  const [removing, setRemoving] = createSignal<readonly string[]>([]);
  const [moving, setMoving] = createSignal<readonly string[]>([]);
  const [limiting, setLimiting] = createSignal<readonly string[]>([]);
  const nonEmpty = (h: readonly string[]) => h.length > 0;
  return (
    <Context.Provider
      value={{
        remove: (h) => nonEmpty(h) && setRemoving([...h]),
        move: (h) => nonEmpty(h) && setMoving([...h]),
        shareLimits: (h) => nonEmpty(h) && setLimiting([...h]),
      }}
    >
      {props.children}
      <DeleteDialog
        hashes={removing()}
        onClose={(deleted) => {
          const gone = removing();
          setRemoving([]);
          if (deleted) props.onRemoved?.(gone);
        }}
      />
      <MoveDialog hashes={moving()} onClose={() => setMoving([])} />
      <ShareLimitsDialog hashes={limiting()} onClose={() => setLimiting([])} />
    </Context.Provider>
  );
}

export function useTorrentDialogs(): TorrentDialogs {
  const d = useContext(Context);
  if (!d) throw new Error("useTorrentDialogs outside TorrentDialogsProvider");
  return d;
}
