// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Webhooks, as the design has it: every webhook with its health
// and last delivery, switched on and off at once; one opens to edit its
// URL, secret and events (saved together), see its last deliveries with a
// redelivery for failures, what the last one sent, send a test, or delete
// it. Webhook URLs often carry a token: lists show the origin only, the
// full URL only where it is edited (AGENTS.md rule 6).

import { createQuery, useQueryClient } from "@tanstack/solid-query";
import ChevronDown from "lucide-solid/icons/chevron-down";
import Plus from "lucide-solid/icons/plus";
import { createEffect, createMemo, createSignal, For, type JSX, on, Show, untrack } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { StatusDot } from "~/components/status-dot";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import { Button } from "~/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { Switch, SwitchControl, SwitchLabel } from "~/components/ui/switch";
import { useLive } from "~/features/shell/live";
import { formatDateTime } from "~/lib/format";
import { cn } from "~/lib/utils";

import { SettingRow } from "./controls";
import { SettingsFrame } from "./frame";
import {
  answer,
  EVENTS,
  health,
  jsonParts,
  lastLine,
  newSecret,
  shownUrl,
  webhookName,
} from "./webhooks-view";

type Webhook = Schemas["Webhook"];
type Event = Schemas["WebhookEvent"];

const HOOKS = ["webhooks"] as const;

function Tag(props: { children: JSX.Element; class?: string }) {
  return (
    <span
      class={cn(
        "inline-flex h-[18px] items-center rounded border border-border px-1.5 mono text-2xs whitespace-nowrap text-muted-foreground",
        props.class,
      )}
    >
      {props.children}
    </span>
  );
}

const TONES = { ok: "bg-ok", danger: "bg-danger", subtle: "bg-faint" } as const;

/** Event chips: none chosen = every event. */
function EventChips(props: { value: readonly Event[]; onChange: (v: Event[]) => void }) {
  const on = (e: Event) => props.value.length === 0 || props.value.includes(e);
  const toggle = (e: Event) => {
    const now = props.value.length === 0 ? [...EVENTS] : [...props.value];
    const next = now.includes(e) ? now.filter((x) => x !== e) : [...now, e];
    props.onChange(next.length === EVENTS.length ? [] : EVENTS.filter((x) => next.includes(x)));
  };
  return (
    <div role="group" aria-label="Events" class="flex max-w-[380px] flex-wrap justify-end gap-1.5">
      <For each={EVENTS}>
        {(e) => (
          <button
            type="button"
            aria-pressed={on(e)}
            class={cn(
              "inline-flex h-[26px] items-center rounded-full border px-[9px] text-sm font-medium transition-colors",
              on(e)
                ? "border-border-strong bg-accent text-foreground"
                : "border-border text-muted-foreground hover:text-foreground",
            )}
            onClick={() => toggle(e)}
          >
            {e}
          </button>
        )}
      </For>
    </div>
  );
}

const field =
  "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 mono text-sm text-foreground outline-none placeholder:text-subtle focus:border-ring focus:shadow-focus";

/** A secret field: a new one typed or generated, or the one set kept. */
function SecretField(props: {
  id: string;
  has: boolean;
  value: string | null | undefined;
  onChange: (v: string | null | undefined) => void;
}) {
  // `undefined` keeps the secret there is; `null` removes it; a text sets it.
  return (
    <div class="flex flex-wrap items-center justify-end gap-2">
      <input
        id={props.id}
        class={cn(field, "w-[240px]")}
        value={typeof props.value === "string" ? props.value : ""}
        placeholder={props.value === null ? "none (removed)" : props.has ? "•••••••• set" : "none"}
        spellcheck={false}
        autocomplete="off"
        onInput={(e) =>
          props.onChange(e.currentTarget.value === "" ? undefined : e.currentTarget.value)
        }
      />
      <Button variant="outline" size="sm" onClick={() => props.onChange(newSecret())}>
        {props.has ? "Rotate" : "Generate"}
      </Button>
      <Show when={props.has && props.value !== null}>
        <Button
          variant="ghost"
          size="sm"
          class="text-muted-foreground"
          onClick={() => props.onChange(null)}
        >
          Remove
        </Button>
      </Show>
    </div>
  );
}

function Payload(props: { hook: Webhook }) {
  const last = () =>
    props.hook.deliveries.find((d) => d.event !== "test") ?? props.hook.deliveries[0];
  const payload = createQuery(() => ({
    queryKey: ["webhooks", props.hook.id, "delivery", last()?.id],
    queryFn: () =>
      unwrap(
        api.GET("/api/v1/webhooks/{id}/deliveries/{delivery}", {
          params: { path: { id: props.hook.id, delivery: last()?.id ?? "" } },
        }),
      ),
    enabled: last() !== undefined,
    retry: false,
  }));
  const tone = {
    key: "text-cat-2",
    string: "text-ok",
    number: "text-warn",
    literal: "text-warn",
    plain: "",
  };
  return (
    <div class="flex min-w-0 flex-col gap-2">
      <span class="text-sm text-subtle">
        <Show when={last()} fallback="What a delivery sends">
          {(d) => (
            <>
              What the last <span class="mono">{d().event}</span> sent
            </>
          )}
        </Show>
      </span>
      <pre
        tabIndex={0}
        aria-label="Payload"
        class="m-0 max-h-[320px] overflow-auto rounded-lg border border-divider bg-background px-3.5 py-3 mono text-xs leading-normal text-foreground-2 focus-visible:shadow-focus focus-visible:outline-none"
      >
        <Show
          when={payload.data}
          fallback={
            last() === undefined
              ? "Nothing sent yet. Send a test event to see one."
              : payload.isError
                ? "Not kept any more."
                : "…"
          }
        >
          {(p) => (
            <For each={jsonParts(p())}>
              {(part) => <span class={tone[part.kind]}>{part.text}</span>}
            </For>
          )}
        </Show>
      </pre>
    </div>
  );
}

function Deliveries(props: { hook: Webhook; onChanged: () => void }) {
  const live = useLive();
  const [busy, setBusy] = createSignal<string | null>(null);
  const torrentName = (hash: string | null) =>
    hash === null ? "—" : (live.state.torrents[hash]?.name ?? `${hash.slice(0, 12)}…`);
  const redeliver = async (delivery: string) => {
    setBusy(delivery);
    try {
      const d = await unwrap(
        api.POST("/api/v1/webhooks/{id}/deliveries/{delivery}/redeliver", {
          params: { path: { id: props.hook.id, delivery } },
        }),
      );
      if (d.error === null) toast.success(`Delivered: ${answer(d)}`);
      else toast.error(`Not delivered: ${d.error}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The delivery could not be sent again.");
    } finally {
      setBusy(null);
      props.onChanged();
    }
  };
  const status = (d: Schemas["WebhookDelivery"]) =>
    d.status === null
      ? "bg-danger/15 text-danger"
      : d.status >= 200 && d.status < 300
        ? "bg-ok/15 text-ok"
        : "bg-warn/15 text-warn";
  return (
    <div class="flex flex-col rounded-lg border border-divider bg-card">
      <Show
        when={props.hook.deliveries.length > 0}
        fallback={
          <p class="m-0 px-4 py-3 text-sm text-subtle">No delivery since the daemon started.</p>
        }
      >
        <table class="w-full table-fixed border-collapse text-sm">
          <caption class="sr-only">Last deliveries, newest first</caption>
          <colgroup>
            <col class="w-[112px]" />
            <col class="w-[78px]" />
            <col />
            <col class="w-[82px]" />
            <col class="w-[40px]" />
            <col class="w-[92px]" />
          </colgroup>
          <tbody>
            <For each={props.hook.deliveries}>
              {(d) => (
                <tr class="h-[34px] border-b border-accent last:border-b-0">
                  <td class="pl-4 mono text-subtle">{formatDateTime(d.time)}</td>
                  <td class="px-1">
                    <Tag>{d.event}</Tag>
                  </td>
                  <td class="truncate px-1 text-subtle" title={d.error ?? undefined}>
                    {torrentName(d.hash)}
                  </td>
                  <td class="px-1">
                    <span
                      class={cn(
                        "inline-flex h-[18px] items-center rounded px-1.5 mono text-2xs font-semibold",
                        status(d),
                      )}
                      title={d.error ?? undefined}
                    >
                      {answer(d)}
                    </span>
                  </td>
                  <td class="px-1 mono text-subtle">{d.attempts}×</td>
                  <td class="pr-2 text-right">
                    <Show when={d.error !== null}>
                      <Button
                        variant="ghost"
                        size="sm"
                        class="text-muted-foreground"
                        disabled={busy() !== null}
                        aria-label={`Redeliver the ${d.event} of ${formatDateTime(d.time)}`}
                        onClick={() => void redeliver(d.id)}
                      >
                        Redeliver
                      </Button>
                    </Show>
                  </td>
                </tr>
              )}
            </For>
          </tbody>
        </table>
      </Show>
    </div>
  );
}

interface Edit {
  name: string;
  url: string;
  events: Event[];
  /** `undefined` = keep, `null` = remove, a text = set. */
  secret: string | null | undefined;
}

const editOf = (h: Webhook): Edit => ({
  name: h.name ?? "",
  url: h.url,
  events: [...h.events.filter((e) => e !== "test")],
  secret: undefined,
});

function HookPanel(props: { hook: Webhook; onChanged: () => void; onDeleted: () => void }) {
  // Starts from the webhook as it is; the effect below follows later changes.
  const [edit, setEdit] = createSignal<Edit>(untrack(() => editOf(props.hook)));
  const [busy, setBusy] = createSignal(false);
  const [asking, setAsking] = createSignal(false);
  // Another client's change starts the form over (not while typing here).
  createEffect(
    on(
      () => [props.hook.name, props.hook.url, props.hook.events.join(), props.hook.has_secret],
      () => {
        if (!dirty()) setEdit(editOf(props.hook));
      },
      { defer: true },
    ),
  );
  const patch = (): Schemas["WebhookPatch"] => {
    const e = edit();
    const p: Schemas["WebhookPatch"] = {};
    if (e.name.trim() !== (props.hook.name ?? ""))
      p.name = e.name.trim() === "" ? null : e.name.trim();
    if (e.url.trim() !== props.hook.url) p.url = e.url.trim();
    if (e.events.join() !== props.hook.events.join()) p.events = e.events;
    if (e.secret !== undefined) p.secret = e.secret;
    return p;
  };
  const dirty = () => Object.keys(patch()).length > 0;
  const urlProblem = () =>
    /^https?:\/\/./i.test(edit().url.trim()) ? null : "An http or https URL.";
  const save = async () => {
    setBusy(true);
    try {
      await unwrap(
        api.PATCH("/api/v1/webhooks/{id}", {
          params: { path: { id: props.hook.id } },
          body: patch(),
        }),
      );
      toast.success("Saved");
      setEdit((e) => ({ ...e, secret: undefined }));
      props.onChanged();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The webhook could not be saved.");
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    try {
      const d = await unwrap(
        api.POST("/api/v1/webhooks/{id}/test", { params: { path: { id: props.hook.id } } }),
      );
      if (d.error === null) toast.success(`Test delivered: ${answer(d)}`);
      else toast.error(`Test not delivered: ${d.error}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The test could not be sent.");
    } finally {
      setBusy(false);
      props.onChanged();
    }
  };
  const remove = async () => {
    try {
      await unwrap(
        api.DELETE("/api/v1/webhooks/{id}", { params: { path: { id: props.hook.id } } }),
      );
      toast.success("Webhook deleted");
      props.onDeleted();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The webhook could not be deleted.");
    }
  };
  const id = (f: string) => `hook-${props.hook.id}-${f}`;
  const last = () => props.hook.deliveries[0];
  return (
    <div class="flex flex-col border-b border-accent bg-card">
      <SettingRow
        label="Name"
        for={id("name")}
        description="A label for lists; empty shows the host."
      >
        <input
          id={id("name")}
          class={cn(field, "w-[340px] font-sans")}
          value={edit().name}
          placeholder={webhookName({ name: null, url: props.hook.url })}
          onInput={(e) => setEdit({ ...edit(), name: e.currentTarget.value })}
        />
      </SettingRow>
      <SettingRow
        label="URL"
        for={id("url")}
        error={urlProblem() ?? undefined}
        description={
          <>
            http or https. Deliveries carry <span class="mono">X-Urtorrentd-Delivery</span> and,
            when signed, <span class="mono">X-Urtorrentd-Signature</span>. Redirects are not
            followed.
          </>
        }
      >
        <input
          id={id("url")}
          class={cn(field, "w-[340px]", urlProblem() && "border-danger")}
          value={edit().url}
          spellcheck={false}
          onInput={(e) => setEdit({ ...edit(), url: e.currentTarget.value })}
        />
      </SettingRow>
      <SettingRow
        label="Secret"
        for={id("secret")}
        description={
          typeof edit().secret === "string"
            ? "Copy it now for the receiver: it is not shown again once saved."
            : "Signs each delivery (HMAC-SHA256 over the timestamp and body). Never shown once saved; replace it to rotate."
        }
      >
        <SecretField
          id={id("secret")}
          has={props.hook.has_secret}
          value={edit().secret}
          onChange={(v) => setEdit({ ...edit(), secret: v })}
        />
      </SettingRow>
      <SettingRow
        label="Events"
        class="items-start"
        description={
          <>
            None chosen = every event. <span class="mono">test</span> is always delivered.
          </>
        }
      >
        <EventChips value={edit().events} onChange={(v) => setEdit({ ...edit(), events: v })} />
      </SettingRow>
      <Show when={dirty()}>
        <div class="flex justify-end gap-2 border-b border-accent px-4 py-2.5">
          <Button variant="ghost" size="sm" onClick={() => setEdit(editOf(props.hook))}>
            Discard
          </Button>
          <Button size="sm" disabled={busy() || urlProblem() !== null} onClick={() => void save()}>
            Save webhook
          </Button>
        </div>
      </Show>
      <div class="grid grid-cols-1 gap-4 px-4 pt-3.5 pb-4 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div class="flex min-w-0 flex-col gap-2">
          <div class="flex items-center justify-between gap-3">
            <span class="text-sm text-subtle">Last deliveries, newest first</span>
            <Button variant="outline" size="sm" disabled={busy()} onClick={() => void test()}>
              Send test event
            </Button>
          </div>
          <Deliveries hook={props.hook} onChanged={props.onChanged} />
          <div class="flex items-center gap-2.5 pt-1 text-sm text-subtle">
            <span class="max-w-[150px]">Retries on no answer, 429 or 5xx:</span>
            <For each={["at once", "+2 s", "+10 s", "+60 s"]}>
              {(label, i) => (
                <span class="flex items-center gap-1.5">
                  <Tag
                    class={
                      last()?.error !== null &&
                      last() !== undefined &&
                      i() < (last()?.attempts ?? 0)
                        ? "border-danger/35 text-danger"
                        : undefined
                    }
                  >
                    {label}
                  </Tag>
                  <Show when={i() < 3}>
                    <span aria-hidden="true">→</span>
                  </Show>
                </span>
              )}
            </For>
          </div>
        </div>
        <Payload hook={props.hook} />
      </div>
      <div class="flex justify-end px-4 pb-3.5">
        <Button
          variant="ghost"
          size="sm"
          class="text-danger hover:text-danger"
          onClick={() => setAsking(true)}
        >
          Delete webhook
        </Button>
      </div>
      <AlertDialog open={asking()} onOpenChange={setAsking}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {webhookName(props.hook)}?</AlertDialogTitle>
            <AlertDialogDescription>
              It gets no more events, and its deliveries are forgotten.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setAsking(false)}>
              Keep it
            </Button>
            <Button variant="destructive" onClick={() => void remove()}>
              Delete
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function AddWebhook(props: { open: boolean; onClose: () => void; onAdded: (id: number) => void }) {
  const [url, setUrl] = createSignal("");
  const [name, setName] = createSignal("");
  const [events, setEvents] = createSignal<Event[]>([]);
  const [secret, setSecret] = createSignal("");
  const [problem, setProblem] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  createEffect(() => {
    if (props.open) {
      setUrl("");
      setName("");
      setEvents([]);
      setSecret("");
      setProblem(null);
    }
  });
  const submit = async () => {
    setBusy(true);
    try {
      const h = await unwrap(
        api.POST("/api/v1/webhooks", {
          body: {
            url: url().trim(),
            name: name().trim() === "" ? null : name().trim(),
            events: events(),
            secret: secret() === "" ? null : secret(),
          },
        }),
      );
      toast.success("Webhook added");
      props.onAdded(h.id);
    } catch (e) {
      setProblem(e instanceof ApiError ? e.message : "The webhook could not be added.");
    } finally {
      setBusy(false);
    }
  };
  const label = "text-sm font-medium";
  return (
    <Dialog open={props.open} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="max-w-md">
        <form
          class="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>Add webhook</DialogTitle>
            <DialogDescription>
              A POST with the event and the torrent's row, for every event it asks for.
            </DialogDescription>
          </DialogHeader>
          <div class="flex flex-col gap-1.5">
            <label for="new-hook-url" class={label}>
              URL
            </label>
            <input
              id="new-hook-url"
              class={field}
              placeholder="https://example.org/hooks/urtorrentd"
              value={url()}
              spellcheck={false}
              autofocus
              onInput={(e) => setUrl(e.currentTarget.value)}
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="new-hook-name" class={label}>
              Name
            </label>
            <input
              id="new-hook-name"
              class={cn(field, "font-sans")}
              placeholder="optional"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <span class={label}>Events</span>
            <div class="flex">
              <EventChips value={events()} onChange={setEvents} />
            </div>
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="new-hook-secret" class={label}>
              Secret
            </label>
            <div class="flex gap-2">
              <input
                id="new-hook-secret"
                class={field}
                placeholder="none: deliveries are not signed"
                value={secret()}
                spellcheck={false}
                autocomplete="off"
                onInput={(e) => setSecret(e.currentTarget.value)}
              />
              <Button
                variant="outline"
                size="sm"
                class="h-8"
                onClick={() => setSecret(newSecret())}
              >
                Generate
              </Button>
            </div>
            <p class="m-0 text-sm text-subtle">
              Give it to the receiver now: it is not shown again.
            </p>
          </div>
          <Show when={problem()}>
            <p class="m-0 text-sm text-danger" role="alert">
              {problem()}
            </p>
          </Show>
          <DialogFooter>
            <Button variant="outline" type="button" onClick={() => props.onClose()}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy() || url().trim() === ""}>
              Add webhook
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default function Webhooks() {
  const client = useQueryClient();
  const [open, setOpen] = createSignal<number | null>(null);
  const [adding, setAdding] = createSignal(false);
  const hooks = createQuery(() => ({
    queryKey: HOOKS,
    queryFn: () => unwrap(api.GET("/api/v1/webhooks")),
    refetchInterval: 10_000,
  }));
  const refresh = () => void client.invalidateQueries({ queryKey: HOOKS });
  const list = createMemo(() => hooks.data ?? []);
  const toggle = async (h: Webhook, enabled: boolean) => {
    try {
      await unwrap(
        api.PATCH("/api/v1/webhooks/{id}", { params: { path: { id: h.id } }, body: { enabled } }),
      );
      refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The webhook could not be switched.");
    }
  };
  return (
    <SettingsFrame
      title="Webhooks"
      description="A POST for every torrent event, to anything that speaks HTTP: a script, Sonarr, a chat bot. Signed when a secret is set."
      saved
      action={
        <Button onClick={() => setAdding(true)}>
          <Plus />
          Add webhook
        </Button>
      }
    >
      <section
        aria-label="Webhooks"
        class="flex flex-col overflow-hidden rounded-tile border border-divider bg-card"
      >
        <Show
          when={list().length > 0}
          fallback={
            <p class="m-0 px-4 py-3 text-sm text-subtle">
              {hooks.isLoading ? "Reading…" : "No webhook yet."}
            </p>
          }
        >
          <For each={list()}>
            {(h) => {
              const expanded = () => open() === h.id;
              const hs = () => health(h);
              return (
                <div>
                  <div
                    class={cn(
                      "grid grid-cols-[34px_minmax(0,1fr)_auto_16px] items-center gap-3 border-b border-accent px-4 py-3",
                      expanded() && "bg-muted",
                    )}
                  >
                    <Switch
                      class="flex items-center"
                      checked={h.enabled}
                      onChange={(v) => void toggle(h, v)}
                    >
                      <SwitchLabel class="sr-only">{webhookName(h)} enabled</SwitchLabel>
                      <SwitchControl />
                    </Switch>
                    <button
                      type="button"
                      class="col-span-3 grid min-w-0 grid-cols-[minmax(0,1fr)_auto_16px] items-center gap-3 text-left"
                      aria-expanded={expanded()}
                      onClick={() => setOpen(expanded() ? null : h.id)}
                    >
                      <span class="flex min-w-0 flex-col gap-1">
                        <span class="flex min-w-0 items-center gap-2">
                          <span class="truncate font-medium">{webhookName(h)}</span>
                          <Show when={h.has_secret}>
                            <Tag>signed</Tag>
                          </Show>
                          <Tag>{h.events.length > 0 ? h.events.join(", ") : "all events"}</Tag>
                        </span>
                        <span class="truncate mono text-sm text-subtle">{shownUrl(h.url)}</span>
                      </span>
                      <span class="flex flex-col items-end gap-1">
                        <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
                          <StatusDot class={TONES[hs().tone]} />
                          {hs().label}
                        </span>
                        <span class="mono text-sm text-subtle">
                          {lastLine(h, Date.now() / 1000)}
                        </span>
                      </span>
                      <ChevronDown
                        class={cn(
                          "size-4 text-subtle transition-transform",
                          expanded() && "rotate-180",
                        )}
                      />
                    </button>
                  </div>
                  <Show when={expanded()}>
                    <HookPanel
                      hook={h}
                      onChanged={refresh}
                      onDeleted={() => {
                        setOpen(null);
                        refresh();
                      }}
                    />
                  </Show>
                </div>
              );
            }}
          </For>
        </Show>
      </section>
      <AddWebhook
        open={adding()}
        onClose={() => setAdding(false)}
        onAdded={(id) => {
          setAdding(false);
          setOpen(id);
          refresh();
        }}
      />
    </SettingsFrame>
  );
}
