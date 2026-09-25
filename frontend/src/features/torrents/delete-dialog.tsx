// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Deleting always asks; deleting the files too is a separate, red choice
// (AGENTS.md 4.4).

import { createEffect, createSignal, Show } from "solid-js";

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import { Checkbox, CheckboxLabel } from "~/components/ui/checkbox";

import { actions } from "./actions";

export function DeleteDialog(props: {
  /** The torrents to delete; empty closes the dialog. */
  hashes: readonly string[];
  /** What to call them: the name of one, or "3 torrents". */
  label: string;
  onClose: (deleted: boolean) => void;
}) {
  const [files, setFiles] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  createEffect(() => {
    if (props.hashes.length > 0) setFiles(false);
  });
  const confirm = async () => {
    setBusy(true);
    const r = await actions.remove(props.hashes, files());
    setBusy(false);
    props.onClose(r !== null);
  };
  return (
    <AlertDialog
      open={props.hashes.length > 0}
      onOpenChange={(open) => {
        if (!open) props.onClose(false);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete {props.label}?</AlertDialogTitle>
          <AlertDialogDescription>
            The torrent leaves the list. Its files stay on disk unless you choose otherwise.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Checkbox checked={files()} onChange={setFiles} class="flex items-center gap-2.5">
          <CheckboxLabel class="text-base text-muted-foreground">
            Also delete the files on disk
          </CheckboxLabel>
        </Checkbox>
        <AlertDialogFooter>
          <AlertDialogClose as={Button} variant="outline">
            Cancel
          </AlertDialogClose>
          <Button variant="destructive" disabled={busy()} onClick={() => void confirm()}>
            <Show when={files()} fallback="Delete">
              Delete with files
            </Show>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
