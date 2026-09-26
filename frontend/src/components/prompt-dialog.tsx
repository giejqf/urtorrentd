// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { createEffect, createSignal, untrack } from "solid-js";

import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { TextField, TextFieldInput, TextFieldLabel } from "~/components/ui/text-field";

/** Ask for one line of text: a new tag, a new category, a new name. */
export function PromptDialog(props: {
  open: boolean;
  title: string;
  label: string;
  action: string;
  /** The text to start from (a rename). */
  initial?: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = createSignal("");
  createEffect(() => {
    if (props.open) setValue(untrack(() => props.initial ?? ""));
  });
  const submit = () => {
    const v = value().trim();
    if (v === "") return;
    props.onSubmit(v);
    props.onClose();
  };
  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogContent class="max-w-sm">
        <form
          class="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{props.title}</DialogTitle>
          </DialogHeader>
          <TextField value={value()} onChange={setValue}>
            <TextFieldLabel>{props.label}</TextFieldLabel>
            <TextFieldInput autofocus spellcheck={false} />
          </TextField>
          <DialogFooter>
            <Button type="submit" disabled={value().trim() === ""}>
              {props.action}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
