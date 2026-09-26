// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Share limits for one torrent or many (not designed: the Options tab's
// rows in a dialog). It starts from their limits when they share them, and
// from Global when they differ; saving gives every one of them the same.

import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";

import { Button } from "~/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { useLive } from "~/features/shell/live";
import { formatCount } from "~/lib/format";

import { actions } from "./actions";
import { bulk } from "./bulk";
import { type ShareDraft, shareDraft, shareLimitsOf } from "./detail/options";
import { ShareFields, useInherited } from "./detail/share-fields";

const GLOBAL = {
  ratio: { mode: "global" },
  seeding_time: { mode: "global" },
  inactive_seeding_time: { mode: "global" },
  action: null,
} as const;

export function ShareLimitsDialog(props: { hashes: readonly string[]; onClose: () => void }) {
  const live = useLive();
  const rows = createMemo(() =>
    props.hashes.flatMap((h) => {
      const t = live.state.torrents[h];
      return t ? [t] : [];
    }),
  );
  const alike = () => {
    const first = rows()[0];
    const key = JSON.stringify(first?.share_limits);
    return first !== undefined && rows().every((t) => JSON.stringify(t.share_limits) === key);
  };
  const [draft, setDraft] = createStore<ShareDraft>(shareDraft(GLOBAL));
  const [busy, setBusy] = createSignal(false);
  createEffect(
    on(
      () => props.hashes.join(),
      () => {
        const first = rows()[0];
        setDraft(reconcile(shareDraft(alike() && first ? first.share_limits : GLOBAL)));
      },
    ),
  );
  const inherited = useInherited(() => bulk(rows()).category);
  const result = createMemo(() => shareLimitsOf(draft));
  const save = async () => {
    const limits = result().limits;
    if (!limits) return;
    setBusy(true);
    const r = await actions.shareLimits(props.hashes, limits);
    setBusy(false);
    if (r !== null) props.onClose();
  };
  return (
    <Dialog open={props.hashes.length > 0} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="max-w-[520px] gap-0 p-0">
        <div class="flex flex-col gap-0.5 px-5 pt-[18px] pr-12">
          <DialogTitle>Share limits</DialogTitle>
          <DialogDescription class="truncate text-sm text-subtle">
            {rows().length === 1
              ? (rows()[0]?.name ?? "")
              : `${formatCount(rows().length)} torrents`}
          </DialogDescription>
        </div>
        <form
          class="flex flex-col px-5 pt-3 pb-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <ShareFields
            draft={draft}
            set={(k, v) => setDraft(k, v as never)}
            inherited={inherited()}
            id="share"
            error={(r) => result().errors[r]}
          />
          <Show when={!alike()}>
            <p class="m-0 mt-2 text-sm text-subtle">
              Their limits differ now; saving gives every one of them these.
            </p>
          </Show>
        </form>
        <div class="flex items-center justify-end gap-2 border-t border-divider px-5 py-3.5">
          <Button variant="outline" size="sm" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy() || result().limits === null}
            onClick={() => void save()}
          >
            Save
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
