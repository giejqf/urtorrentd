// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// What every settings page shares: the settings loaded once, a draft of
// the page's fields over them, what changed, and saving it with one
// `PATCH /settings` (the save bar, Ctrl/⌘ S), discarding it, or asking
// before leaving with it. A page brings its own draft and diff (pure,
// tested next to it).

import { useBeforeLeave } from "@solidjs/router";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
import {
  createEffect,
  createMemo,
  createSignal,
  type JSX,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { createStore, reconcile, type SetStoreFunction } from "solid-js/store";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";

import { SaveBar } from "./controls";
import { SettingsFrame } from "./frame";

type Settings = Schemas["Settings"];

/** A draft against the saved settings. */
export interface FormDiff<F extends string> {
  /** What to send (only what changed). */
  patch: Schemas["SettingsPatch"];
  /** The draft fields that differ from the saved settings. */
  changed: Set<F>;
  /** Setting names that change, for the save bar (`alt_speed_schedule.days`). */
  names: string[];
  /** What is not valid, by field. */
  errors: Partial<Record<F, string>>;
}

export interface SettingsForm<D extends object, F extends keyof D & string> {
  draft: D;
  setDraft: SetStoreFunction<D>;
  /** Change one field (clears a failed save's message). */
  set: <K extends F>(field: K, value: D[K]) => void;
  diff: () => FormDiff<F>;
  changed: (field: F) => boolean;
  error: (field: F) => string | undefined;
  dirty: () => boolean;
  busy: () => boolean;
  /** Why the save bar cannot save: the daemon's answer, or the first invalid field. */
  problem: () => string | null;
  save: () => Promise<void>;
  discard: () => void;
}

export function createSettingsForm<D extends object, F extends keyof D & string>(
  saved: () => Settings,
  /** The draft of saved settings; `prev` is the draft they replace (texts of switches that are off). */
  draftOf: (s: Settings, prev?: D) => D,
  diffOf: (saved: Settings, draft: D) => FormDiff<F>,
): SettingsForm<D, F> {
  const client = useQueryClient();
  // Starts from the saved settings; the effect below follows later ones.
  const [draft, setDraft] = createStore<D>(untrack(() => draftOf(saved())));
  const [busy, setBusy] = createSignal(false);
  const [saveError, setSaveError] = createSignal<string | null>(null);

  // A save (or another client) brings new settings: start over from them.
  createEffect(
    on(
      saved,
      (s) =>
        setDraft(
          reconcile(
            draftOf(
              s,
              untrack(() => draft),
            ),
          ),
        ),
      { defer: true },
    ),
  );

  const diff = createMemo(() => diffOf(saved(), draft));
  const firstError = () => Object.values<string | undefined>(diff().errors)[0] ?? null;
  const dirty = () => diff().changed.size > 0;

  const save = async () => {
    if (busy() || !dirty() || firstError()) return;
    setBusy(true);
    try {
      const next = await unwrap(api.PATCH("/api/v1/settings", { body: diff().patch }));
      client.setQueryData(keys.settings(), next);
      void client.invalidateQueries({ queryKey: keys.app() });
      toast.success("Saved");
    } catch (e) {
      setSaveError(e instanceof ApiError ? e.message : "The settings could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  return {
    draft,
    setDraft,
    set: (field, value) => {
      setSaveError(null);
      // A store setter keyed by a generic field needs the widened form.
      (setDraft as (k: F, v: unknown) => void)(field, value);
    },
    diff,
    changed: (f) => diff().changed.has(f),
    error: (f) => diff().errors[f],
    dirty,
    busy,
    problem: () => saveError() ?? firstError(),
    save,
    discard: () => {
      setSaveError(null);
      setDraft(reconcile(draftOf(saved())));
    },
  };
}

/**
 * A settings page around a form: the frame, the save bar, Ctrl/⌘ S, and
 * the question before leaving with unsaved changes.
 */
export function SettingsPage<D extends object, F extends keyof D & string>(props: {
  title: string;
  description: string;
  form: SettingsForm<D, F>;
  children: JSX.Element;
}) {
  const [leaving, setLeaving] = createSignal<(() => void) | null>(null);
  const names = () => props.form.diff().names;

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "s" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void props.form.save();
    }
  };
  onMount(() => document.addEventListener("keydown", onKey));
  onCleanup(() => document.removeEventListener("keydown", onKey));
  useBeforeLeave((e) => {
    if (props.form.dirty() && !e.defaultPrevented) {
      e.preventDefault();
      setLeaving(() => () => e.retry(true));
    }
  });

  return (
    <SettingsFrame
      title={props.title}
      description={props.description}
      saved={!props.form.dirty()}
      overlay={
        <SaveBar
          names={names()}
          error={props.form.problem()}
          busy={props.form.busy()}
          onDiscard={() => props.form.discard()}
          onSave={() => void props.form.save()}
        />
      }
    >
      {props.children}
      <AlertDialog open={leaving() !== null} onOpenChange={(o) => !o && setLeaving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Leave without saving?</AlertDialogTitle>
            <AlertDialogDescription>
              {names().length === 1 ? "1 change is" : `${names().length} changes are`} not saved:{" "}
              {names().join(", ")}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setLeaving(null)}>
              Stay
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const go = leaving();
                setLeaving(null);
                props.form.discard();
                go?.();
              }}
            >
              Leave
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsFrame>
  );
}

function Loading() {
  return (
    <div class="h-40 animate-pulse rounded-tile bg-muted" role="status" aria-label="Loading" />
  );
}

/** The settings, read once for every page (`GET /settings`), then the page. */
export function WithSettings(props: {
  title: string;
  children: (saved: () => Settings) => JSX.Element;
}) {
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
  }));
  return (
    <Show
      when={settings.data}
      fallback={
        <SettingsFrame title={props.title}>
          <Show when={settings.isError} fallback={<Loading />}>
            <p class="m-0 text-danger" role="alert">
              {settings.error instanceof ApiError
                ? settings.error.message
                : "The settings could not be read."}
            </p>
          </Show>
        </SettingsFrame>
      }
    >
      {(s) => props.children(s)}
    </Show>
  );
}
