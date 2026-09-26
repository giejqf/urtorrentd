// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Trackers tab: each tracker with its tier and how it stands, to edit or
// remove; trackers to add (one per line, in one new tier), and for a public
// torrent the list new public torrents get; the trackerless sources; the
// web seeds. A tracker shows as its host (its URL can carry a passkey),
// the whole URL only while it is edited. Nothing is added to a private
// torrent but what is typed here (charter rule 2).

import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { createMemo, createSignal, For, type JSX, Show } from "solid-js";
import { toast } from "solid-sonner";

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
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useAppInfo } from "~/features/settings/app-info";
import { useLive } from "~/features/shell/live";
import { dash, formatCount, formatDuration } from "~/lib/format";
import { trackerHost } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { actions } from "../actions";
import { SectionHead, TabHeading, trackerTone } from "./parts";
import {
  missingTrackers,
  nextTier,
  trackerLine,
  trackerScheme,
  trackerUrlProblem,
  typedUrls,
} from "./trackers";

type TorrentSummary = Schemas["TorrentSummary"];
type Tracker = Schemas["TrackerInfo"];

const fieldClass =
  "w-full min-w-0 rounded-md border border-border bg-background px-2.5 mono text-sm text-foreground outline-none placeholder:text-subtle focus:border-ring focus:shadow-focus";

/** An address being edited: the whole of it, with Save and Cancel. */
function UrlEditor(props: {
  label: string;
  initial: string;
  action: string;
  problem: (url: string) => string | null;
  onSave: (url: string) => Promise<boolean>;
  onCancel: () => void;
}) {
  const [text, setText] = createSignal(props.initial);
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const save = async () => {
    const url = text().trim();
    const problem = props.problem(url);
    if (problem) return setError(problem);
    if (url === props.initial) return props.onCancel();
    setBusy(true);
    if (await props.onSave(url)) props.onCancel();
    setBusy(false);
  };
  return (
    <form
      class="flex flex-col gap-1.5"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <input
        class={cn(fieldClass, "h-[30px]", error() && "border-danger")}
        aria-label={props.label}
        value={text()}
        spellcheck={false}
        autofocus
        onInput={(e) => {
          setText(e.currentTarget.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            props.onCancel();
          }
        }}
      />
      <Show when={error()}>
        <span class="text-xs text-danger" role="alert">
          {error()}
        </span>
      </Show>
      <div class="flex justify-end gap-1.5">
        <Button type="button" variant="ghost" size="xs" onClick={() => props.onCancel()}>
          Cancel
        </Button>
        <Button type="submit" size="xs" disabled={busy()}>
          {props.action}
        </Button>
      </div>
    </form>
  );
}

function Source(props: { name: string; on: boolean; children: JSX.Element }) {
  return (
    <li class="flex h-7 items-center justify-between gap-2 text-sm">
      <span class="flex items-center gap-2">
        <StatusDot class={props.on ? "bg-ok" : "bg-border-strong"} small />
        {props.name}
      </span>
      <span class="mono text-xs text-subtle">{props.children}</span>
    </li>
  );
}

export function TrackersTab(props: { torrent: TorrentSummary }) {
  const client = useQueryClient();
  const live = useLive();
  const app = useAppInfo();
  const hash = () => props.torrent.hash;
  const trackers = createQuery(() => ({
    queryKey: keys.torrentPart(hash(), "trackers"),
    queryFn: () =>
      unwrap(api.GET("/api/v1/torrents/{hash}/trackers", { params: { path: { hash: hash() } } })),
    refetchInterval: 5_000,
  }));
  const seeds = createQuery(() => ({
    queryKey: keys.torrentPart(hash(), "webseeds"),
    queryFn: () =>
      unwrap(api.GET("/api/v1/torrents/{hash}/webseeds", { params: { path: { hash: hash() } } })),
    refetchInterval: 10_000,
  }));
  // The trackers new public torrents get: typed in the settings, and fetched.
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
    enabled: !props.torrent.private,
  }));
  const list = () => trackers.data?.trackers ?? [];
  const offered = createMemo(() =>
    props.torrent.private
      ? []
      : missingTrackers(list(), [
          settings.data?.add_trackers ?? [],
          app.data?.fetched_trackers?.trackers ?? [],
        ]),
  );

  const [editing, setEditing] = createSignal<string | null>(null);
  const [removing, setRemoving] = createSignal<Tracker | null>(null);
  const [typed, setTyped] = createSignal("");
  const [typedError, setTypedError] = createSignal<string | null>(null);
  const [seedEditing, setSeedEditing] = createSignal<string | null>(null);
  const [seedAdding, setSeedAdding] = createSignal(false);

  const refresh = () => {
    void client.invalidateQueries({ queryKey: keys.torrentPart(hash(), "trackers") });
    void client.invalidateQueries({ queryKey: keys.torrentPart(hash(), "webseeds") });
    void client.invalidateQueries({ queryKey: keys.trackerHosts() });
  };
  /** Runs one change of this torrent's (given its hash), then reads again. */
  const call = async (what: string, run: (h: string) => Promise<unknown>): Promise<boolean> => {
    try {
      await run(hash());
      refresh();
      return true;
    } catch (e) {
      toast.error(`${what}: ${e instanceof ApiError ? e.message : "failed"}`);
      return false;
    }
  };
  const path = (h: string) => ({ params: { path: { hash: h } } });
  const addTrackers = (urls: string[], tier: number | null) =>
    call("Add trackers", (h) =>
      unwrap(
        api.POST("/api/v1/torrents/{hash}/trackers", {
          ...path(h),
          body: tier === null ? { urls } : { urls, tier },
        }),
      ),
    );
  const addTyped = async () => {
    const urls = typedUrls(typed());
    if (urls.length === 0) return;
    const bad = urls.map((u) => [u, trackerUrlProblem(u)] as const).find(([, p]) => p !== null);
    if (bad) return setTypedError(`${trackerHost(bad[0]) ?? bad[0]}: ${bad[1] ?? ""}`);
    if (await addTrackers(urls, nextTier(list()))) setTyped("");
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col gap-2.5 px-4 pt-3 pb-4">
      <TabHeading torrent={props.torrent} />
      <div class="flex min-h-0 flex-1 flex-col gap-2.5 overflow-auto pt-1">
        <section aria-label="Trackers" class="flex flex-col gap-2">
          <SectionHead title={`Trackers · ${formatCount(list().length)}`}>
            <Button
              variant="outline"
              size="xs"
              disabled={list().length === 0}
              onClick={() => void actions.reannounce([hash()]).then(refresh)}
            >
              Reannounce all
            </Button>
          </SectionHead>
          <Show when={trackers.isPending}>
            <div class="h-16 animate-pulse rounded-lg bg-muted" />
          </Show>
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            <For each={list()}>
              {(t) => {
                const line = () => trackerLine(t);
                return (
                  <li
                    class="flex flex-col gap-1.5 rounded-lg border border-divider bg-background px-3 py-2.5"
                    aria-label={trackerHost(t.url) ?? "tracker"}
                  >
                    <Show
                      when={editing() === t.url}
                      fallback={
                        <>
                          <div class="flex min-w-0 items-center gap-2">
                            <StatusDot class={trackerTone(t.status)} small />
                            <span class="min-w-0 flex-1 truncate mono text-sm">
                              {trackerHost(t.url) ?? "?"}
                            </span>
                            <Show when={trackerScheme(t.url)}>
                              {(s) => <Badge class="uppercase">{s()}</Badge>}
                            </Show>
                            <Badge>tier {t.tier}</Badge>
                          </div>
                          <div class="flex items-center justify-between gap-2 text-xs">
                            <span
                              class={cn(
                                "min-w-0 truncate",
                                line().tone === "danger"
                                  ? "text-danger"
                                  : line().tone === "ok"
                                    ? "text-muted-foreground"
                                    : "text-subtle",
                              )}
                              title={line().text}
                            >
                              {line().text}
                            </span>
                            <span class="flex-none mono text-subtle">
                              <Show when={t.next_announce_in !== null && !t.updating}>
                                next in {formatDuration(t.next_announce_in ?? 0)}
                              </Show>
                            </span>
                          </div>
                          <div class="flex gap-1.5">
                            <Button
                              variant="outline"
                              size="xs"
                              class="h-[22px]"
                              onClick={() => setEditing(t.url)}
                            >
                              Edit URL
                            </Button>
                            <Button
                              variant="outline"
                              size="xs"
                              class="h-[22px] text-muted-foreground"
                              onClick={() => setRemoving(t)}
                            >
                              Remove
                            </Button>
                          </div>
                        </>
                      }
                    >
                      <UrlEditor
                        label={`URL of ${trackerHost(t.url) ?? "the tracker"}`}
                        initial={t.url}
                        action="Save"
                        problem={trackerUrlProblem}
                        onCancel={() => setEditing(null)}
                        onSave={(url) =>
                          call("Edit tracker", (h) =>
                            unwrap(
                              api.POST("/api/v1/torrents/{hash}/trackers/edit", {
                                ...path(h),
                                body: { url: t.url, new_url: url },
                              }),
                            ),
                          )
                        }
                      />
                    </Show>
                  </li>
                );
              }}
            </For>
          </ul>
          <form
            class="flex items-start gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              void addTyped();
            }}
          >
            <textarea
              class={cn(
                fieldClass,
                "min-h-[30px] resize-y py-1.5",
                typedError() && "border-danger",
              )}
              rows={typed().includes("\n") ? 3 : 1}
              aria-label="Tracker URLs to add"
              placeholder="Add tracker URL… (one per line, same tier)"
              spellcheck={false}
              value={typed()}
              onInput={(e) => {
                setTyped(e.currentTarget.value);
                setTypedError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  void addTyped();
                }
              }}
            />
            <Show when={typed().trim() !== ""}>
              <Button type="submit" size="xs" class="h-[30px]">
                Add
              </Button>
            </Show>
          </form>
          <Show when={typedError()}>
            <span class="text-xs text-danger" role="alert">
              {typedError()}
            </span>
          </Show>
          <Show when={offered().length > 0}>
            <div class="flex items-center justify-between gap-2 text-xs text-subtle">
              <span>Public torrent: the trackers new public torrents get can be added.</span>
              <Button
                variant="outline"
                size="xs"
                class="h-[22px] flex-none"
                onClick={() => void addTrackers(offered(), null)}
              >
                Add {formatCount(offered().length)}{" "}
                {offered().length === 1 ? "tracker" : "trackers"}
              </Button>
            </div>
          </Show>
        </section>

        <section aria-label="Other sources" class="mt-1 flex flex-col">
          <SectionHead title="Other sources" />
          <Show when={trackers.data}>
            {(d) => {
              const off = () => (props.torrent.private ? "off · private torrent" : "off");
              const found = (n: number) => `${formatCount(n)} ${n === 1 ? "peer" : "peers"} found`;
              return (
                <ul class="m-0 list-none p-0">
                  <Source name="DHT" on={d().dht.enabled}>
                    {d().dht.enabled
                      ? `${formatCount(live.state.transfer?.dht_nodes ?? 0)} nodes · ${found(d().dht.peers)}`
                      : off()}
                  </Source>
                  <Source name="PEX" on={d().pex.enabled}>
                    {d().pex.enabled ? found(d().pex.peers) : off()}
                  </Source>
                  <Source name="LSD" on={d().lsd.enabled}>
                    {d().lsd.enabled ? found(d().lsd.peers) : off()}
                  </Source>
                </ul>
              );
            }}
          </Show>
        </section>

        <section aria-label="Web seeds" class="mt-1 flex flex-col gap-2">
          <SectionHead title={`Web seeds · ${formatCount(seeds.data?.length ?? 0)}`}>
            <Button variant="outline" size="xs" onClick={() => setSeedAdding(true)}>
              Add
            </Button>
          </SectionHead>
          <Show when={seedAdding()}>
            <UrlEditor
              label="Web seed URL to add"
              initial=""
              action="Add"
              problem={(u) => (/^https?:\/\//i.test(u) ? null : "An http or https URL.")}
              onCancel={() => setSeedAdding(false)}
              onSave={(url) =>
                call("Add web seed", (h) =>
                  unwrap(
                    api.POST("/api/v1/torrents/{hash}/webseeds", {
                      ...path(h),
                      body: { urls: [url] },
                    }),
                  ),
                )
              }
            />
          </Show>
          <ul class="m-0 flex list-none flex-col gap-2 p-0">
            <For each={seeds.data ?? []}>
              {(url) => (
                <li class="flex flex-col gap-1.5 rounded-lg border border-divider bg-background px-3 py-2">
                  <Show
                    when={seedEditing() === url}
                    fallback={
                      <div class="flex items-center justify-between gap-2">
                        <span class="min-w-0 truncate mono text-xs" title={url}>
                          {url}
                        </span>
                        <span class="flex flex-none gap-1">
                          <Button
                            variant="outline"
                            size="xs"
                            class="h-[22px]"
                            onClick={() => setSeedEditing(url)}
                          >
                            Edit
                          </Button>
                          <Button
                            variant="outline"
                            size="xs"
                            class="h-[22px] text-muted-foreground"
                            aria-label={`Remove web seed ${url}`}
                            onClick={() =>
                              void call("Remove web seed", (h) =>
                                unwrap(
                                  api.POST("/api/v1/torrents/{hash}/webseeds/remove", {
                                    ...path(h),
                                    body: { urls: [url] },
                                  }),
                                ),
                              )
                            }
                          >
                            Remove
                          </Button>
                        </span>
                      </div>
                    }
                  >
                    <UrlEditor
                      label="Web seed URL"
                      initial={url}
                      action="Save"
                      problem={(u) => (/^https?:\/\//i.test(u) ? null : "An http or https URL.")}
                      onCancel={() => setSeedEditing(null)}
                      onSave={(next) =>
                        call("Edit web seed", (h) =>
                          unwrap(
                            api.POST("/api/v1/torrents/{hash}/webseeds/edit", {
                              ...path(h),
                              body: { url, new_url: next },
                            }),
                          ),
                        )
                      }
                    />
                  </Show>
                </li>
              )}
            </For>
          </ul>
          <Show when={seeds.data?.length === 0 && !seedAdding()}>
            <p class="m-0 text-sm text-subtle">{dash} none</p>
          </Show>
        </section>
      </div>

      <AlertDialog open={removing() !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove the tracker at {trackerHost(removing()?.url ?? null) ?? "this host"}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The torrent stops announcing to it. Adding it back needs its whole URL
              {props.torrent.private ? ", passkey included" : ""}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose as={Button} variant="outline">
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const t = removing();
                setRemoving(null);
                if (t)
                  void call("Remove tracker", (h) =>
                    unwrap(
                      api.POST("/api/v1/torrents/{hash}/trackers/remove", {
                        ...path(h),
                        body: { urls: [t.url] },
                      }),
                    ),
                  );
              }}
            >
              Remove
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
