// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Security & API, as the design has it: how the daemon sees this
// very request (`POST /auth/check`), the login and the API key, session
// and ban limits with the sessions open and the addresses banned, the HTTP
// layer, and the cookie jar the daemon's own requests carry. The limits and
// the HTTP layer are a draft saved with one `PATCH /settings`; credentials,
// the key, sessions, bans and cookies change at once.

import { createQuery, useQueryClient } from "@tanstack/solid-query";
import CircleAlert from "lucide-solid/icons/circle-alert";
import CircleCheck from "lucide-solid/icons/circle-check";
import Copy from "lucide-solid/icons/copy";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  on,
  onCleanup,
  Show,
  untrack,
} from "solid-js";
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
import { Button } from "~/components/ui/button";
import { Checkbox, CheckboxLabel } from "~/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "~/components/ui/dialog";
import { useAuth } from "~/features/auth/auth";
import { formatAgo, formatDate, formatDuration, formatMonth } from "~/lib/format";
import { cn } from "~/lib/utils";

import {
  ChipList,
  InfoBox,
  RowSwitch,
  SettingRow,
  SettingsGroup,
  UnitInput,
  UnitSelect,
} from "./controls";
import { createSettingsForm, SettingsPage, WithSettings } from "./form";
import type { TimeUnit } from "./queue-form";
import {
  blockProblem,
  hostProblem,
  keyAbbrev,
  maskValue,
  originProblem,
  parseCookie,
  sameCookie,
  type SecurityDraft,
  securityDiff,
  securityDraft,
  type SecurityField,
  shortAgent,
} from "./security-form";

type Check = Schemas["RequestCheck"];
type Cookie = Schemas["Cookie"];

const UNITS: { value: TimeUnit; label: string }[] = [
  { value: "minutes", label: "min" },
  { value: "hours", label: "hours" },
  { value: "days", label: "days" },
];

const field =
  "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 mono text-sm text-foreground outline-none placeholder:text-subtle focus:border-ring focus:shadow-focus";

/** Seconds since the epoch, ticking every 15 s. */
function useClock() {
  const [now, setNow] = createSignal(Math.floor(Date.now() / 1000));
  const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
  onCleanup(() => clearInterval(t));
  return now;
}

function failure(e: unknown, what: string): string {
  return e instanceof ApiError ? e.message : what;
}

// ---------------------------------------------------------------------------
// A request, as configured

function Mark(props: { ok: boolean }) {
  return (
    <Show
      when={props.ok}
      fallback={<CircleAlert size={12} class="flex-none text-warn" aria-hidden="true" />}
    >
      <CircleCheck size={12} class="flex-none text-ok" aria-hidden="true" />
    </Show>
  );
}

function Arrow() {
  return (
    <svg
      width="24"
      height="12"
      viewBox="0 0 24 12"
      aria-hidden="true"
      class="mx-auto rotate-90 self-center text-faint sm:rotate-0"
    >
      <path d="M0 6h18" stroke="currentColor" stroke-width="1.5" />
      <path d="M16 2 23 6 16 10Z" fill="currentColor" />
    </svg>
  );
}

function RequestPath(props: { check: Check | undefined; error: unknown }) {
  const c = () => props.check;
  const proxyBox = (c: Check) =>
    c.proxy === "trusted" ? (
      <InfoBox
        tone="strong"
        label={
          <>
            <Mark ok /> Trusted proxy
          </>
        }
        value={c.peer ?? "unknown"}
        note="its headers are believed"
      />
    ) : c.proxy === "untrusted" ? (
      <InfoBox
        tone="warn"
        label={
          <>
            <Mark ok={false} /> Proxy not trusted
          </>
        }
        value={c.peer ?? "unknown"}
        note="its forwarding headers are ignored: list it below"
      />
    ) : (
      <InfoBox label="Proxy" value="none" note="a direct connection" />
    );
  const auth = (c: Check): [string, string] => {
    switch (c.auth) {
      case "session":
        return ["session", "a signed-in cookie: not exempt"];
      case "api_key":
        return ["API key", "a bearer token"];
      case "loopback":
        return ["none needed", "loopback needs no sign-in"];
      case "whitelist":
        return ["none needed", "in a block that needs no sign-in"];
    }
  };
  const csrf = (c: Check): [string, string] => {
    switch (c.csrf) {
      case "same_origin":
        return ["same origin", "state changes allowed"];
      case "listed_origin":
        return ["listed origin", "state changes allowed"];
      case "no_origin":
        return ["no origin sent", "state changes allowed"];
      case "not_applied":
        return ["not checked", "API keys never are"];
      case "off":
        return ["off", "any page may change things"];
    }
  };
  return (
    <section
      aria-label="A request, as configured"
      class="flex flex-col gap-3 rounded-tile border border-divider bg-card p-4"
    >
      <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 class="m-0 text-base font-semibold">A request, as configured</h2>
        <Show when={c()}>
          {(c) => (
            <span class="text-sm text-subtle">
              this browser · {c().client ?? "unknown address"}
              {c().proxy === "trusted" ? " via the proxy" : ""}
            </span>
          )}
        </Show>
      </div>
      <Show
        when={c()}
        fallback={
          <p class="m-0 text-sm text-subtle" role={props.error ? "alert" : undefined}>
            {props.error ? failure(props.error, "The daemon did not answer.") : "Asking…"}
          </p>
        }
      >
        {(c) => (
          <div class="grid grid-cols-1 items-stretch gap-1.5 sm:grid-cols-[minmax(0,1fr)_24px_minmax(0,1fr)_24px_minmax(0,1fr)_24px_minmax(0,1fr)_24px_minmax(0,1fr)]">
            <InfoBox
              label="Client"
              value={c().client ?? "unknown"}
              note={
                c().proxy === "trusted"
                  ? "seen through X-Forwarded-For"
                  : "the connection's own address"
              }
            />
            <Arrow />
            {proxyBox(c())}
            <Arrow />
            <InfoBox
              tone="strong"
              label={
                <>
                  <Mark ok /> Host check
                </>
              }
              value={c().host ?? "none"}
              title={c().host ?? undefined}
              note={
                c().host_check === "allowed"
                  ? "in allowed hosts"
                  : c().host_check === "address"
                    ? "an IP address: always accepted"
                    : "no Host header"
              }
            />
            <Arrow />
            <InfoBox
              tone="strong"
              label={
                <>
                  <Mark ok /> Authentication
                </>
              }
              value={auth(c())[0]}
              note={auth(c())[1]}
            />
            <Arrow />
            <InfoBox
              tone={c().csrf === "off" ? "warn" : "ok"}
              label={
                <>
                  <Mark ok={c().csrf !== "off"} /> CSRF
                </>
              }
              value={csrf(c())[0]}
              note={csrf(c())[1]}
            />
          </div>
        )}
      </Show>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Credentials and the API key

function CredentialsDialog(props: { open: boolean; username: string; onClose: () => void }) {
  const auth = useAuth();
  const [name, setName] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [again, setAgain] = createSignal("");
  const [problem, setProblem] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  // A fresh form each time it opens (not when the account is read again).
  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setName(untrack(() => props.username));
        setPassword("");
        setAgain("");
        setProblem(null);
      },
    ),
  );
  const check = () =>
    name().trim() === ""
      ? "A user name is needed."
      : password().length < 8
        ? "The password needs at least 8 characters."
        : password() !== again()
          ? "The passwords differ."
          : null;
  const submit = async () => {
    const p = check();
    if (p) {
      setProblem(p);
      return;
    }
    setBusy(true);
    try {
      await unwrap(
        api.PUT("/api/v1/auth/credentials", {
          body: { username: name().trim(), password: password() },
        }),
      );
      setPassword("");
      setAgain("");
      props.onClose();
      toast.success("Changed: sign in with the new password");
      await auth.sessionEnded();
    } catch (e) {
      setProblem(failure(e, "The credentials could not be changed."));
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
            <DialogTitle>Change the user name and password</DialogTitle>
            <DialogDescription>
              Every login session ends, this one included: you sign in again with them.
            </DialogDescription>
          </DialogHeader>
          <div class="flex flex-col gap-1.5">
            <label for="cred-user" class={label}>
              User name
            </label>
            <input
              id="cred-user"
              class={field}
              autocomplete="username"
              value={name()}
              onInput={(e) => setName(e.currentTarget.value)}
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="cred-pass" class={label}>
              New password
            </label>
            <input
              id="cred-pass"
              type="password"
              class={field}
              autocomplete="new-password"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <label for="cred-again" class={label}>
              The new password again
            </label>
            <input
              id="cred-again"
              type="password"
              class={field}
              autocomplete="new-password"
              value={again()}
              onInput={(e) => setAgain(e.currentTarget.value)}
            />
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
            <Button type="submit" disabled={busy()}>
              Change and sign in again
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * A new API key, shown once: it is dropped when the dialog closes. Done
 * waits for "I have copied it" (a copy ticks it).
 */
function NewKeyDialog(props: {
  apiKey: string | null;
  /** It replaced a key, which stopped working. */
  replaced: boolean;
  onClose: () => void;
}) {
  const [copied, setCopied] = createSignal(false);
  createEffect(
    on(
      () => props.apiKey,
      () => setCopied(false),
    ),
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(props.apiKey ?? "");
      setCopied(true);
      toast.success("Copied");
    } catch {
      toast.error("The browser did not allow copying: select the key and copy it.");
    }
  };
  return (
    <Dialog open={props.apiKey !== null} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent class="max-w-[540px] gap-0 p-0">
        <div class="flex flex-col gap-0.5 px-5 pt-[18px] pr-12">
          <DialogTitle>Your new API key</DialogTitle>
          <DialogDescription class="text-sm text-subtle">
            Shown once.{props.replaced ? " The old key stopped working just now." : ""}
          </DialogDescription>
        </div>
        <div class="flex flex-col gap-3 px-5 pt-4 pb-4">
          <div class="flex gap-2">
            <input
              aria-label="API key"
              class={cn(field, "h-10 mono")}
              readOnly
              value={props.apiKey ?? ""}
              onFocus={(e) => e.currentTarget.select()}
            />
            <Button class="h-10" onClick={() => void copy()}>
              <Copy />
              Copy
            </Button>
          </div>
          <div class="flex flex-col gap-1.5">
            <span class="text-sm text-subtle">Send it as</span>
            <div class="rounded-md border border-border bg-background px-3 py-2.5 mono text-sm">
              Authorization: Bearer {keyAbbrev(props.apiKey ?? "")}
            </div>
            <span class="text-sm text-subtle">
              Requests with it skip the CSRF check and never make a session. Revoke it any time from
              Settings › Security &amp; API.
            </span>
          </div>
        </div>
        <div class="flex items-center gap-2 border-t border-divider px-5 py-3.5">
          <Checkbox class="flex items-center gap-2" checked={copied()} onChange={setCopied}>
            <CheckboxLabel class="text-sm text-foreground-2">
              I have copied it somewhere safe
            </CheckboxLabel>
          </Checkbox>
          <span class="flex-1" />
          <Button disabled={!copied()} onClick={() => props.onClose()}>
            Done
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Sessions and bans

function Who(props: {
  tone: "ok" | "warn" | "danger";
  address: string | null;
  what: string;
  agent: string;
  when: string;
  action?: JSX.Element;
}) {
  return (
    <li class="grid min-h-9 grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 border-b border-accent px-4 py-1.5 text-sm last:border-b-0 sm:grid-cols-[8px_minmax(0,1fr)_150px_110px_76px] sm:py-0">
      <StatusDot
        class={props.tone === "ok" ? "bg-ok" : props.tone === "warn" ? "bg-warn" : "bg-danger"}
      />
      <span class="truncate">
        <span class="mono">{props.address ?? "unknown address"}</span>{" "}
        <span class="text-subtle">{props.what}</span>
      </span>
      <span class="col-start-2 truncate text-subtle sm:col-start-auto" title={props.agent}>
        {props.agent}
      </span>
      <span class="col-start-2 mono text-subtle sm:col-start-auto">{props.when}</span>
      <span class="col-start-3 row-start-1 text-right sm:col-start-auto sm:row-start-auto">
        {props.action}
      </span>
    </li>
  );
}

function SessionsAndBans(props: { account: Schemas["Account"] | undefined; onRevoke: () => void }) {
  const client = useQueryClient();
  const now = useClock();
  const sessions = createQuery(() => ({
    queryKey: keys.sessions(),
    queryFn: () => unwrap(api.GET("/api/v1/auth/sessions")),
    refetchInterval: 10_000,
  }));
  const bans = createQuery(() => ({
    queryKey: keys.loginBans(),
    queryFn: () => unwrap(api.GET("/api/v1/auth/bans")),
    refetchInterval: 10_000,
  }));
  const others = () => (sessions.data ?? []).filter((s) => !s.current).length;
  const act = async (what: Promise<unknown>, done: string, fail: string) => {
    try {
      await what;
      toast.success(done);
    } catch (e) {
      toast.error(failure(e, fail));
    }
    await client.invalidateQueries({ queryKey: keys.sessions() });
    await client.invalidateQueries({ queryKey: keys.loginBans() });
  };
  const endOthers = () =>
    act(
      unwrap(api.DELETE("/api/v1/auth/sessions")),
      "Every other session ended",
      "The sessions could not be ended.",
    );
  const end = (s: Schemas["LoginSession"]) =>
    act(
      unwrap(api.DELETE("/api/v1/auth/sessions/{id}", { params: { path: { id: s.id } } })),
      "Session ended",
      "The session could not be ended.",
    );
  const unban = (b: Schemas["LoginBan"]) =>
    act(
      unwrap(
        api.DELETE("/api/v1/auth/bans/{address}", { params: { path: { address: b.address } } }),
      ),
      b.banned_until === null ? "Forgotten" : "Unbanned",
      "The ban could not be lifted.",
    );
  const user = () => props.account?.username ?? "";
  const key = () => props.account?.api_key?.last_used ?? null;
  const empty = () =>
    (sessions.data ?? []).length === 0 && (bans.data ?? []).length === 0 && key() === null;
  return (
    <section
      aria-label="Active sessions and sign-in bans"
      class="flex flex-col border-t border-accent"
    >
      <div class="flex flex-wrap items-center justify-between gap-2 px-4 pt-3 pb-1">
        <span class="text-sm text-subtle">Active sessions and sign-in bans</span>
        <Button
          variant="outline"
          size="sm"
          disabled={others() === 0}
          onClick={() => void endOthers()}
        >
          End all other sessions
        </Button>
      </div>
      <Show
        when={!empty()}
        fallback={<p class="m-0 px-4 pb-3 text-sm text-subtle">Nobody else is signed in.</p>}
      >
        <ul class="m-0 list-none p-0">
          <For each={sessions.data ?? []}>
            {(s) => (
              <Who
                tone="ok"
                address={s.last_used.address}
                what={s.current ? `this session · ${user()}` : user()}
                agent={shortAgent(s.last_used.user_agent)}
                when={
                  s.current || now() - s.last_used.time < 60
                    ? "active now"
                    : `idle ${formatDuration(now() - s.last_used.time)}`
                }
                action={
                  <Show when={!s.current}>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`End the session from ${s.last_used.address ?? "an unknown address"}`}
                      onClick={() => void end(s)}
                    >
                      End
                    </Button>
                  </Show>
                }
              />
            )}
          </For>
          <Show when={key()}>
            {(k) => (
              <Who
                tone="ok"
                address={k().address}
                what="API key"
                agent={shortAgent(k().user_agent)}
                when={formatAgo(k().time, now())}
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label="Revoke the API key"
                    onClick={() => props.onRevoke()}
                  >
                    Revoke
                  </Button>
                }
              />
            )}
          </Show>
          <For each={bans.data ?? []}>
            {(b) => (
              <Who
                tone={b.banned_until === null ? "warn" : "danger"}
                address={b.address}
                what={
                  b.banned_until === null
                    ? `${b.failures} failed sign-in${b.failures === 1 ? "" : "s"}`
                    : `banned · ${b.failures} failed sign-ins`
                }
                agent={shortAgent(b.user_agent)}
                when={
                  b.banned_until === null
                    ? formatAgo(b.last_failure, now())
                    : `${formatDuration(Math.max(b.banned_until - now(), 0))} left`
                }
                action={
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`${b.banned_until === null ? "Forget" : "Unban"} ${b.address}`}
                    onClick={() => void unban(b)}
                  >
                    {b.banned_until === null ? "Forget" : "Unban"}
                  </Button>
                }
              />
            )}
          </For>
        </ul>
      </Show>
    </section>
  );
}

// ---------------------------------------------------------------------------
// The cookie jar

function CookieJar() {
  const client = useQueryClient();
  const now = useClock();
  const [text, setText] = createSignal("");
  const [problem, setProblem] = createSignal<string | null>(null);
  const jar = createQuery(() => ({
    queryKey: keys.cookies(),
    queryFn: () => unwrap(api.GET("/api/v1/app/cookies")),
  }));
  const store = async (next: Cookie[], done: string) => {
    try {
      await unwrap(api.PUT("/api/v1/app/cookies", { body: next }));
      client.setQueryData(keys.cookies(), next);
      toast.success(done);
      return true;
    } catch (e) {
      setProblem(failure(e, "The cookies could not be stored."));
      return false;
    }
  };
  const add = async () => {
    const c = parseCookie(text().trim(), now());
    if (typeof c === "string") {
      setProblem(c);
      return;
    }
    const rest = (jar.data ?? []).filter((x) => !sameCookie(x, c));
    if (await store([...rest, c], `Cookie ${c.name} stored`)) setText("");
  };
  const remove = (c: Cookie) =>
    void store(
      (jar.data ?? []).filter((x) => !sameCookie(x, c)),
      `Cookie ${c.name} removed`,
    );
  return (
    <SettingsGroup
      title="Cookie jar"
      aside="Sent with the daemon's own requests: .torrent downloads, RSS feeds, the tracker list · at most 1000"
    >
      <Show
        when={(jar.data ?? []).length > 0}
        fallback={
          <p class="m-0 border-b border-accent px-4 py-3 text-sm text-subtle">
            {jar.isLoading ? "Reading…" : "No cookie. Private trackers that want one say so."}
          </p>
        }
      >
        <ul class="m-0 list-none p-0" aria-label="Cookies">
          <For each={jar.data ?? []}>
            {(c) => (
              <li class="grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-accent px-4 py-1.5 text-sm sm:grid-cols-[minmax(0,1fr)_170px_90px_76px] sm:py-0">
                <span class="truncate">
                  <span class="mono">{c.name}</span>
                  <span class="text-subtle"> = </span>
                  <span class="mono text-subtle">{maskValue(c.value)}</span>
                </span>
                <span class="truncate mono text-subtle" title={`${c.domain}${c.path ?? ""}`}>
                  {c.domain}
                  {c.path && c.path !== "/" ? c.path : ""}
                </span>
                <span
                  class={cn(
                    "mono",
                    c.expires != null && c.expires < now() ? "text-warn" : "text-subtle",
                  )}
                >
                  {c.expires == null
                    ? "no expiry"
                    : c.expires < now()
                      ? "expired"
                      : formatMonth(c.expires)}
                </span>
                <span class="col-start-2 row-start-1 text-right sm:col-start-auto sm:row-start-auto">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Remove the cookie ${c.name} for ${c.domain}`}
                    onClick={() => remove(c)}
                  >
                    Remove
                  </Button>
                </span>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <form
        class="flex flex-col gap-1.5 px-4 py-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <div class="flex gap-2">
          <input
            aria-label="New cookie"
            class={field}
            placeholder="name=value; Domain=tracker.example; Path=/; Expires=…"
            value={text()}
            spellcheck={false}
            autocomplete="off"
            aria-invalid={problem() ? "true" : undefined}
            onInput={(e) => {
              setText(e.currentTarget.value);
              setProblem(null);
            }}
          />
          <Button variant="outline" type="submit" disabled={text().trim() === ""}>
            Add
          </Button>
        </div>
        <Show when={problem()}>
          <span class="text-sm text-danger" role="alert">
            {problem()}
          </span>
        </Show>
      </form>
    </SettingsGroup>
  );
}

// ---------------------------------------------------------------------------
// The page

function SecurityForm(props: { saved: Schemas["Settings"] }) {
  const client = useQueryClient();
  const now = useClock();
  const [changing, setChanging] = createSignal(false);
  const [newKey, setNewKey] = createSignal<string | null>(null);
  const [replaced, setReplaced] = createSignal(false);
  /** The key action waiting for a yes: deleting it, or replacing it. */
  const [asking, setAsking] = createSignal<"delete" | "rotate" | null>(null);

  const account = createQuery(() => ({
    queryKey: keys.account(),
    queryFn: () => unwrap(api.GET("/api/v1/auth/account")),
    refetchInterval: 15_000,
  }));
  // Asked again whenever the saved settings change what it shows.
  const check = createQuery(() => ({
    queryKey: [
      ...keys.requestCheck(),
      JSON.stringify([
        props.saved.api_trusted_proxies,
        props.saved.api_allowed_hosts,
        props.saved.api_auth_whitelist,
        props.saved.api_bypass_local_auth,
        props.saved.api_csrf_protection,
        props.saved.api_cors_origins,
      ]),
    ],
    queryFn: () => unwrap(api.POST("/api/v1/auth/check")),
    retry: false,
  }));
  const host = createMemo(() =>
    check.data?.host_check === "allowed" ? (check.data.host ?? null) : null,
  );
  const form = createSettingsForm<SecurityDraft, SecurityField>(
    () => props.saved,
    securityDraft,
    (saved, d) => securityDiff(saved, d, host()),
  );
  const { draft, changed, error, set } = form;

  const rotate = async () => {
    try {
      const had = apiKey() !== null;
      const k = await unwrap(api.POST("/api/v1/auth/api-key"));
      setReplaced(had);
      setNewKey(k.api_key);
    } catch (e) {
      toast.error(failure(e, "No key was made."));
    }
    await client.invalidateQueries({ queryKey: keys.account() });
  };
  const revoke = async () => {
    try {
      await unwrap(api.DELETE("/api/v1/auth/api-key"));
      toast.success("API key deleted");
    } catch (e) {
      toast.error(failure(e, "The key could not be deleted."));
    }
    await client.invalidateQueries({ queryKey: keys.account() });
  };
  const apiKey = () => account.data?.api_key ?? null;

  const chips = (
    id: SecurityField &
      ("api_auth_whitelist" | "api_trusted_proxies" | "api_allowed_hosts" | "api_cors_origins"),
    what: string,
    placeholder: string,
    problem: (v: string) => string | null,
  ) => (
    <ChipList
      id={`s-${id}`}
      what={what}
      values={draft[id]}
      onChange={(v) => set(id, v)}
      problem={problem}
      placeholder={placeholder}
      layout="wrap"
      changed={changed(id)}
    />
  );

  return (
    <SettingsPage
      title="Security & API"
      description="Who can talk to the daemon, how they prove it, and what the HTTP layer checks on the way in."
      form={form}
    >
      <RequestPath check={check.data} error={check.error} />

      <SettingsGroup title="Sign-in">
        <SettingRow
          label="User name and password"
          description="Changing either ends every login session, this one included. At least 8 characters."
        >
          <div class="flex items-center gap-2">
            <span class="max-w-[200px] truncate rounded-md border border-border bg-background px-2.5 py-1.5 mono text-sm">
              {account.data?.username ?? "…"}
            </span>
            <Button variant="outline" size="sm" onClick={() => setChanging(true)}>
              Change password
            </Button>
          </div>
        </SettingRow>
        <SettingRow
          label="API key"
          description={
            <>
              For scripts and other clients: <span class="mono">Authorization: Bearer …</span>.
              Shown once, on creation. Making a new one replaces the old.
            </>
          }
        >
          <div class="flex flex-col items-end gap-1">
            <div class="flex gap-1.5">
              <Button
                variant="outline"
                size="sm"
                onClick={() => (apiKey() ? setAsking("rotate") : void rotate())}
              >
                {apiKey() ? "Regenerate" : "Create"}
              </Button>
              <Show when={apiKey()}>
                <Button
                  variant="outline"
                  size="sm"
                  class="text-danger"
                  onClick={() => setAsking("delete")}
                >
                  Delete
                </Button>
              </Show>
            </div>
            <span class="text-sm text-subtle">
              <Show when={apiKey()} fallback="No key: only sign-in works.">
                {(k) => (
                  <>
                    {k().created !== null ? `created ${formatDate(k().created)}` : "made earlier"}
                    {" · "}
                    {k().last_used
                      ? `last used ${formatAgo(k().last_used?.time ?? null, now())}${k().last_used?.address ? ` from ${k().last_used?.address}` : ""}`
                      : "not used since the daemon started"}
                  </>
                )}
              </Show>
            </span>
          </div>
        </SettingRow>
        <SettingRow
          label="Sessions expire after"
          for="s-api_session_timeout"
          description="Idle time. Every request extends a session, and so does an open page."
          changed={changed("api_session_timeout")}
          error={error("api_session_timeout")}
        >
          <UnitInput
            id="s-api_session_timeout"
            value={draft.api_session_timeout}
            changed={changed("api_session_timeout")}
            invalid={error("api_session_timeout") !== undefined}
            onInput={(v) => set("api_session_timeout", v)}
            trailing={
              <UnitSelect
                label="Session timeout unit"
                options={UNITS}
                value={draft.api_session_timeout_unit}
                onChange={(u) => set("api_session_timeout_unit", u)}
              />
            }
          />
        </SettingRow>
        <SettingRow
          label="Failed sign-ins before an address is banned"
          for="s-api_max_auth_failures"
          changed={changed("api_max_auth_failures") || changed("api_ban_duration")}
          error={error("api_max_auth_failures") ?? error("api_ban_duration")}
        >
          <div class="flex items-center gap-2">
            <UnitInput
              id="s-api_max_auth_failures"
              class="w-[110px]"
              inputMode="numeric"
              unit="tries"
              value={draft.api_max_auth_failures}
              changed={changed("api_max_auth_failures")}
              invalid={error("api_max_auth_failures") !== undefined}
              onInput={(v) => set("api_max_auth_failures", v)}
            />
            <span class="text-sm text-subtle">then</span>
            <UnitInput
              id="s-api_ban_duration"
              label="Banned for"
              class="w-[140px]"
              value={draft.api_ban_duration}
              changed={changed("api_ban_duration")}
              invalid={error("api_ban_duration") !== undefined}
              onInput={(v) => set("api_ban_duration", v)}
              trailing={
                <UnitSelect
                  label="Ban unit"
                  options={UNITS}
                  value={draft.api_ban_duration_unit}
                  onChange={(u) => set("api_ban_duration_unit", u)}
                />
              }
            />
          </div>
        </SettingRow>
        <SessionsAndBans account={account.data} onRevoke={() => setAsking("delete")} />
      </SettingsGroup>

      <SettingsGroup title="HTTP layer">
        <SettingRow
          label="Loopback needs no sign-in"
          for="s-api_bypass_local_auth-input"
          description="Clients on 127.0.0.1 / ::1 skip authentication, for local scripts. Off if anything untrusted runs on this machine."
          changed={changed("api_bypass_local_auth")}
        >
          <RowSwitch
            id="s-api_bypass_local_auth"
            checked={draft.api_bypass_local_auth}
            onChange={(v) => set("api_bypass_local_auth", v)}
          />
        </SettingRow>
        <SettingRow
          class="items-start"
          label="Address blocks that need no sign-in"
          for="s-api_auth_whitelist"
          description="Your LAN or VPN. Evaluated after trusted proxies, so it applies to the real client address."
          changed={changed("api_auth_whitelist")}
        >
          {chips("api_auth_whitelist", "block", "10.0.0.0/8", blockProblem)}
        </SettingRow>
        <SettingRow
          class="items-start"
          label="Trusted reverse proxies"
          for="s-api_trusted_proxies"
          description={
            <>
              Only these may tell the daemon the client's address, host and scheme (
              <span class="mono">X-Forwarded-For</span>, <span class="mono">-Host</span>,{" "}
              <span class="mono">-Proto</span>).
            </>
          }
          changed={changed("api_trusted_proxies")}
        >
          {chips("api_trusted_proxies", "proxy", "address or block", blockProblem)}
        </SettingRow>
        <SettingRow
          class="items-start"
          label="Allowed hosts"
          for="s-api_allowed_hosts"
          description={
            <>
              Host names accepted in the <span class="mono">Host</span> header; IP addresses always
              are. <span class="mono">*</span> = any, <span class="mono">*.example.com</span> =
              subdomains. Stops DNS rebinding.
            </>
          }
          changed={changed("api_allowed_hosts")}
          error={error("api_allowed_hosts")}
        >
          {chips("api_allowed_hosts", "host", "host", hostProblem)}
        </SettingRow>
        <SettingRow
          label="CSRF protection"
          for="s-api_csrf_protection-input"
          description="Refuse changes from pages on another origin, for sessions and for clients that need no sign-in. Requests with the API key are never affected."
          changed={changed("api_csrf_protection")}
        >
          <RowSwitch
            id="s-api_csrf_protection"
            checked={draft.api_csrf_protection}
            onChange={(v) => set("api_csrf_protection", v)}
          />
        </SettingRow>
        <SettingRow
          class="items-start"
          label="Browser origins allowed (CORS)"
          for="s-api_cors_origins"
          description="Pages on these origins may call the API: another UI, a dashboard. Exact origins, no wildcard; they sign in with an API key."
          changed={changed("api_cors_origins")}
        >
          {chips("api_cors_origins", "origin", "https://…", originProblem)}
        </SettingRow>
      </SettingsGroup>

      <CookieJar />

      <CredentialsDialog
        open={changing()}
        username={account.data?.username ?? ""}
        onClose={() => setChanging(false)}
      />
      <NewKeyDialog apiKey={newKey()} replaced={replaced()} onClose={() => setNewKey(null)} />
      <AlertDialog open={asking() !== null} onOpenChange={(o) => !o && setAsking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {asking() === "rotate" ? "Replace the API key?" : "Delete the API key?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              Scripts and clients that use it stop working until they get the new one
              {asking() === "rotate" ? ", shown next" : ""}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose as={Button} variant="outline" aria-label="Cancel">
              Cancel
            </AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                const what = asking();
                setAsking(null);
                void (what === "rotate" ? rotate() : revoke());
              }}
            >
              {asking() === "rotate" ? "Replace" : "Delete"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsPage>
  );
}

export default function Security() {
  return (
    <WithSettings title="Security & API">
      {(saved) => <SecurityForm saved={saved()} />}
    </WithSettings>
  );
}
