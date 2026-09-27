// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Adding and editing a feed (its URL, name, folder and refresh interval:
// the one place its full URL shows, as the user edits it), and asking
// before something is removed.

import { createQuery } from "@tanstack/solid-query";
import { createEffect, createSignal, For, Match, on, Show, Switch } from "solid-js";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { StatusDot } from "~/components/status-dot";
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
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
import { Segmented, UnitInput } from "~/features/settings/controls";
import { formatCount } from "~/lib/format";
import { useSettled } from "~/lib/settled";

import { cookieFor } from "./view";

type Feed = Schemas["RssFeed"];

const field =
  "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-subtle focus:border-ring focus:shadow-focus";

/** Minutes typed as seconds; empty = the setting (`null`); `undefined` = not valid. */
export function intervalOf(text: string): number | null | undefined {
  const t = text.trim();
  if (t === "") return null;
  if (!/^\d+(\.\d+)?$/.test(t) || Number(t) < 1) return undefined;
  return Math.round(Number(t) * 60);
}

/** The host of a URL, lower-cased; "" when it is not one. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * A feed's form: a new one (`feed` null), or one to change. A URL typed is
 * read by the daemon at once (`POST /rss/feeds/probe`, nothing kept), to
 * show what it holds before it is added.
 */
export function FeedDialog(props: {
  open: boolean;
  feed: Feed | null;
  folders: readonly string[];
  /** The folder a new feed goes in. */
  folder?: string | null;
  onClose: () => void;
  onSaved: (f: Feed) => void;
}) {
  const [url, setUrl] = createSignal("");
  const [name, setName] = createSignal("");
  const [folder, setFolder] = createSignal("");
  const [own, setOwn] = createSignal(false);
  const [every, setEvery] = createSignal("");
  const [runRules, setRunRules] = createSignal(true);
  const [problem, setProblem] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        const f = props.feed;
        setUrl(f?.url ?? "");
        setName(f?.name ?? "");
        setFolder(f ? (f.folder ?? "") : (props.folder ?? ""));
        setOwn(f?.refresh_interval != null);
        setEvery(f?.refresh_interval != null ? String(f.refresh_interval / 60) : "");
        setRunRules(true);
        setProblem(null);
      },
    ),
  );
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
    enabled: props.open,
  }));
  const jar = createQuery(() => ({
    queryKey: keys.cookies(),
    queryFn: () => unwrap(api.GET("/api/v1/app/cookies")),
    enabled: props.open,
  }));
  // What the URL holds, once typing settles (a changed one when editing).
  const typed = () => url().trim();
  const settled = useSettled(typed);
  const web = (u: string) => /^https?:\/\/[^/]/i.test(u);
  const probe = createQuery(() => ({
    queryKey: ["rss", "probe", settled()],
    queryFn: () => unwrap(api.POST("/api/v1/rss/feeds/probe", { body: { url: settled() } })),
    enabled: props.open && web(settled()) && settled() !== (props.feed?.url ?? ""),
    retry: false,
    staleTime: 60_000,
  }));
  const cookies = () => {
    const host = hostOf(typed());
    return host !== "" && (jar.data ?? []).some((c) => cookieFor(c.domain, host)) ? host : null;
  };
  const globalMinutes = () => {
    const s = settings.data?.rss_refresh_interval;
    return s === undefined ? null : Math.round(s / 60);
  };
  const submit = async () => {
    const interval = own() ? intervalOf(every()) : null;
    if (interval === undefined || (own() && interval === null)) {
      setProblem("Minutes, at least 1.");
      return;
    }
    const body = {
      url: typed(),
      name: name().trim() === "" ? null : name().trim(),
      folder:
        folder().trim() === ""
          ? null
          : folder()
              .trim()
              .replace(/^\/+|\/+$/g, ""),
      refresh_interval: interval,
    };
    setBusy(true);
    try {
      const f = props.feed;
      const saved = f
        ? await unwrap(
            api.PATCH("/api/v1/rss/feeds/{id}", { params: { path: { id: f.id } }, body }),
          )
        : await unwrap(
            api.POST("/api/v1/rss/feeds", {
              body: { ...body, skip_existing: !runRules() },
            }),
          );
      props.onSaved(saved);
      props.onClose();
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "The feed could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const label = "text-sm font-medium";
  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="max-w-[540px] gap-0 p-0">
        <form
          class="flex flex-col"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div class="flex flex-col gap-0.5 px-5 pt-[18px] pr-12">
            <DialogTitle>{props.feed ? "Edit feed" : "Add feed"}</DialogTitle>
            <DialogDescription class="text-sm text-subtle">
              {props.feed ? "A new URL is read at once." : "Refreshed at once after adding."}
            </DialogDescription>
          </div>
          <div class="flex flex-col gap-4 px-5 pt-4 pb-4">
            <div class="flex flex-col gap-1.5">
              <label for="feed-url" class={label}>
                Feed URL
              </label>
              <input
                id="feed-url"
                class={`${field} mono`}
                placeholder="https://indexer.example/rss"
                value={url()}
                spellcheck={false}
                autocomplete="off"
                autofocus
                onInput={(e) => setUrl(e.currentTarget.value)}
              />
              <span class="flex items-start gap-1.5 text-sm text-subtle" role="status">
                <Switch>
                  <Match when={typed() === "" || typed() === (props.feed?.url ?? "")}>{""}</Match>
                  <Match when={!web(typed())}>An http or https URL.</Match>
                  <Match when={probe.isFetching || settled() !== typed()}>Reading the feed…</Match>
                  <Match when={probe.isError}>
                    <StatusDot class="mt-1 bg-danger" small />
                    <span>
                      {probe.error instanceof ApiError
                        ? probe.error.message
                        : "The feed could not be read."}
                    </span>
                  </Match>
                  <Match when={probe.data}>
                    {(p) => (
                      <>
                        <StatusDot class="mt-1 bg-ok" small />
                        <span>
                          Fetched
                          {p().title ? ` · “${p().title ?? ""}”` : ""} · {formatCount(p().articles)}{" "}
                          {p().articles === 1 ? "article" : "articles"}
                          {cookies() ? ` · cookies for ${cookies() ?? ""} will be sent` : ""}
                        </span>
                      </>
                    )}
                  </Match>
                </Switch>
              </span>
            </div>
            <div class="grid grid-cols-[minmax(0,1fr)_180px] gap-3">
              <div class="flex flex-col gap-1.5">
                <label for="feed-name" class={label}>
                  Label
                </label>
                <input
                  id="feed-name"
                  class={field}
                  placeholder={
                    probe.data?.title
                      ? `${probe.data.title} (from the feed)`
                      : (props.feed?.title ?? "the feed's own title")
                  }
                  value={name()}
                  onInput={(e) => setName(e.currentTarget.value)}
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <label for="feed-folder" class={label}>
                  Folder
                </label>
                <input
                  id="feed-folder"
                  class={field}
                  placeholder="none"
                  list="feed-folders"
                  value={folder()}
                  spellcheck={false}
                  onInput={(e) => setFolder(e.currentTarget.value)}
                />
                <datalist id="feed-folders">
                  <For each={props.folders}>{(f) => <option value={f} />}</For>
                </datalist>
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <span class={label}>Refresh interval</span>
              <div class="flex items-center gap-1.5">
                <Segmented
                  label="Refresh interval"
                  compact
                  options={[
                    {
                      value: "global",
                      label:
                        globalMinutes() === null
                          ? "Global"
                          : `Global · ${globalMinutes() ?? 0} min`,
                    },
                    { value: "own", label: "Own" },
                  ]}
                  value={own() ? "own" : "global"}
                  onChange={(v) => setOwn(v === "own")}
                />
                <UnitInput
                  id="feed-every"
                  label="Refresh interval in minutes"
                  class="h-[30px] w-[120px]"
                  value={own() ? every() : ""}
                  placeholder={own() ? "" : String(globalMinutes() ?? "")}
                  muted={!own()}
                  unit="min"
                  inputMode="decimal"
                  onInput={(v) => {
                    setEvery(v);
                    if (v.trim() !== "") setOwn(true);
                  }}
                />
              </div>
              <span class="text-sm text-subtle">
                At least 1 minute. Requests to one host are spaced by the delay in Settings › RSS
                {settings.data ? ` (${formatCount(settings.data.rss_fetch_delay)} s)` : ""}.
              </span>
            </div>
            <Show when={!props.feed}>
              <div class="flex flex-col gap-1">
                <Checkbox
                  class="flex items-center gap-2"
                  checked={runRules()}
                  disabled={settings.data?.rss_auto_download === false}
                  onChange={setRunRules}
                >
                  <CheckboxLabel class="text-sm text-foreground-2">
                    Run download rules on its articles now
                  </CheckboxLabel>
                </Checkbox>
                <span class="pl-[26px] text-sm text-subtle">
                  {settings.data?.rss_auto_download === false
                    ? "Auto-download is off (Settings › RSS): nothing is downloaded either way."
                    : runRules()
                      ? "What it has now can be downloaded by the rules."
                      : "What it has now is kept without the rules; only later articles are downloaded."}
                </span>
              </div>
            </Show>
            <Show when={problem()}>
              <p class="m-0 text-sm text-danger" role="alert">
                {problem()}
              </p>
            </Show>
          </div>
          <div class="flex items-center justify-end gap-2 border-t border-divider px-5 py-3.5">
            <Button variant="outline" size="sm" type="button" onClick={() => props.onClose()}>
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={busy() || typed() === ""}>
              {props.feed ? "Save feed" : "Add feed"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  description: string;
  action: string;
  onClose: () => void;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{props.title}</AlertDialogTitle>
          <AlertDialogDescription>{props.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose as={Button} variant="outline" aria-label="Cancel">
            Cancel
          </AlertDialogClose>
          <Button
            variant="destructive"
            onClick={() => {
              props.onConfirm();
              props.onClose();
            }}
          >
            {props.action}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
