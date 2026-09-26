// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › Connection, as the design has it: whether peers reach us (the
// transfer state's `connection_status`, the listen port, the addresses
// peers see), then the listen port, interface and addresses with the
// machine's interfaces (`GET /app/interfaces`), and the peer transports.
// Edits are a draft saved with one `PATCH /settings`.

import { createQuery } from "@tanstack/solid-query";
import { createMemo, For, type JSX, Show } from "solid-js";

import { api, type Schemas, unwrap } from "~/api/client";
import { StatusDot } from "~/components/status-dot";
import { Button } from "~/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { useLive } from "~/features/shell/live";
import { formatCount } from "~/lib/format";
import { cn } from "~/lib/utils";

import { useAppInfo } from "./app-info";
import { RowSwitch, Segmented, SettingRow, SettingsGroup, UnitInput } from "./controls";
import { createSettingsForm, SettingsPage, WithSettings } from "./form";
import {
  type ConnectionDraft,
  connectionDiff,
  connectionDraft,
  type ConnectionField,
  randomPort,
} from "./network-form";

const TRANSPORTS: { value: Schemas["Transports"]; label: string }[] = [
  { value: "tcp_only", label: "TCP only" },
  { value: "prefer_tcp", label: "Prefer TCP" },
  { value: "prefer_utp", label: "Prefer µTP" },
  { value: "utp_only", label: "µTP only" },
];

/** The interface select's "none" (`listen_interface: null`). */
const ALL = "\u0000all";

function Box(props: { class?: string; children: JSX.Element }) {
  return (
    <div
      class={cn(
        "flex min-w-0 flex-col gap-[3px] rounded-lg border border-border bg-muted px-3 py-2.5",
        props.class,
      )}
    >
      {props.children}
    </div>
  );
}

function Arrow(props: { live: boolean }) {
  return (
    <svg
      width="44"
      height="14"
      viewBox="0 0 44 14"
      aria-hidden="true"
      class={cn("mx-auto rotate-90 sm:rotate-0", props.live ? "text-ok" : "text-faint")}
    >
      <path
        d="M0 7h38"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-dasharray={props.live ? "3 3" : undefined}
      />
      <path d="M36 3 43 7 36 11Z" fill="currentColor" />
    </svg>
  );
}

function Reachability(props: { listenInterface: string | null }) {
  const live = useLive();
  const app = useAppInfo();
  const t = () => live.state.transfer;
  const connected = () => t()?.connection_status === "connected";
  return (
    <section
      aria-label="Reachability"
      class="flex flex-col gap-3.5 rounded-tile border border-divider bg-card p-4"
    >
      <div class="flex items-center gap-2.5">
        <h2 class="m-0 text-base font-semibold">Reachability</h2>
        <Show when={t()}>
          <span
            class={cn(
              "inline-flex h-[18px] items-center rounded border px-1.5 mono text-2xs",
              connected() ? "border-ok/35 text-ok" : "border-warn/35 text-warn",
            )}
          >
            {connected() ? "connected" : "firewalled"}
          </span>
        </Show>
      </div>
      <div class="grid grid-cols-1 items-center gap-1.5 sm:grid-cols-[150px_44px_minmax(0,1fr)_44px_170px]">
        <Box>
          <span class="text-xs text-subtle">Internet</span>
          <span class="truncate mono text-sm">peers · trackers · DHT</span>
          <span class="text-xs text-subtle">
            {formatCount(t()?.peers ?? 0)} {t()?.peers === 1 ? "peer" : "peers"} connected
          </span>
        </Box>
        <Arrow live={connected()} />
        <Box class={cn("items-center text-center", connected() ? "border-ok" : "border-warn")}>
          <span class="relative my-1.5 flex size-3" aria-hidden="true">
            <Show when={connected()}>
              <span class="absolute inline-flex size-full animate-ping rounded-full bg-ok opacity-60 motion-reduce:animate-none" />
            </Show>
            <span
              class={cn(
                "relative inline-flex size-3 rounded-full",
                connected() ? "bg-ok" : "bg-warn",
              )}
            />
          </span>
          <span class="mono text-base font-semibold">
            {t()?.listen_port ?? "—"} <span class="font-normal text-subtle">TCP · UDP</span>
          </span>
          <span class="text-xs text-subtle">
            {connected() ? "peers connect in" : "no incoming connection yet"}
          </span>
        </Box>
        <Arrow live={false} />
        <Box>
          <span class="truncate text-xs text-subtle">
            {app.data?.instance_name ?? "This daemon"} is seen as
            {props.listenInterface ? ` (via ${props.listenInterface})` : ""}
          </span>
          <span class="truncate mono text-sm">{t()?.external_v4 ?? "IPv4: not known yet"}</span>
          <span class="truncate mono text-sm text-muted-foreground">
            {t()?.external_v6 ?? "IPv6: not known yet"}
          </span>
        </Box>
      </div>
      <p class="m-0 text-sm text-subtle">
        Detected from incoming peer connections (
        <span class="mono">GET /transfer · connection_status</span>). Firewalled means peers can
        only connect when you dial them first: fewer seeds find you, and private trackers may mark
        you unconnectable.
      </p>
    </section>
  );
}

function ConnectionForm(props: { saved: Schemas["Settings"] }) {
  const app = useAppInfo();
  const form = createSettingsForm<ConnectionDraft, ConnectionField>(
    () => props.saved,
    connectionDraft,
    connectionDiff,
  );
  const { draft, changed, error, set } = form;
  const interfaces = createQuery(() => ({
    queryKey: ["app", "interfaces"],
    queryFn: () => unwrap(api.GET("/api/v1/app/interfaces")),
    refetchInterval: 30_000,
  }));

  const listening = createMemo(() => new Set(app.data?.listen_addresses ?? []));
  const isListening = (i: Schemas["NetworkInterface"]) =>
    i.addresses.some(
      (a) =>
        listening().has(a) ||
        (listening().has("0.0.0.0") && a.includes(".")) ||
        (listening().has("::") && a.includes(":")),
    );
  const interfaceOptions = createMemo(() => {
    const names = (interfaces.data ?? []).map((i) => i.name);
    const current = draft.listen_interface;
    return [ALL, ...(current !== null && !names.includes(current) ? [current] : []), ...names];
  });
  const addressesOf = (name: string) =>
    (interfaces.data ?? []).find((i) => i.name === name)?.addresses ?? [];

  const familyRow = (family: "v4" | "v6") => {
    const field = family === "v4" ? "listen_v4" : "listen_v6";
    const on = () => (family === "v4" ? draft.listen_v4_on : draft.listen_v6_on);
    const name = family === "v4" ? "IPv4" : "IPv6";
    return (
      <SettingRow
        label={name}
        for={`c-${field}-switch-input`}
        description={
          draft.listen_interface === null
            ? `Listen address; off = no ${name} socket, no ${name} peers.`
            : `The interface's ${name} address; off = no ${name} peers.`
        }
        changed={changed(field)}
        error={error(field)}
      >
        <div class="flex items-center gap-3">
          <UnitInput
            id={`c-${field}`}
            label={`${name} listen address`}
            class="w-[200px]"
            align="left"
            value={draft[field]}
            muted={!on() || draft.listen_interface !== null}
            changed={changed(field)}
            invalid={error(field) !== undefined}
            onInput={(v) => set(field, v)}
          />
          <RowSwitch
            id={`c-${field}-switch`}
            checked={on()}
            onChange={(v) => set(`${field}_on`, v)}
          />
        </div>
      </SettingRow>
    );
  };

  return (
    <SettingsPage
      title="Connection"
      description="The port and addresses peers reach you on, and how connections are made."
      form={form}
    >
      <Reachability listenInterface={props.saved.listen_interface} />

      <SettingsGroup title="Listening">
        <SettingRow
          label="Listen port"
          for="c-listen_port"
          description="TCP and UDP. 0 picks a port at every start. Forward this one on your router if you are behind NAT."
          changed={changed("listen_port")}
          error={error("listen_port")}
        >
          <div class="flex items-center gap-2">
            <UnitInput
              id="c-listen_port"
              inputMode="numeric"
              value={draft.listen_port}
              changed={changed("listen_port")}
              invalid={error("listen_port") !== undefined}
              onInput={(v) => set("listen_port", v)}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => set("listen_port", String(randomPort()))}
            >
              Random
            </Button>
          </div>
        </SettingRow>
        <SettingRow
          label="New random port at every start"
          for="c-random_port-input"
          description={
            draft.random_port
              ? "On: peers learn each new port from trackers and the DHT; a port forward cannot follow it."
              : "Off: a fixed port is what a port forward needs."
          }
          changed={changed("random_port")}
        >
          <RowSwitch
            id="c-random_port"
            checked={draft.random_port}
            onChange={(v) => set("random_port", v)}
          />
        </SettingRow>
        <SettingRow
          label="Interface"
          description="Listen and send on one interface's addresses only, the usual way to pin traffic to a VPN tunnel; followed as they change."
          changed={changed("listen_interface")}
        >
          <Select<string>
            options={interfaceOptions()}
            value={draft.listen_interface ?? ALL}
            onChange={(v) => v !== null && set("listen_interface", v === ALL ? null : v)}
            itemComponent={(p) => (
              <SelectItem item={p.item}>
                <span class="flex items-center gap-2">
                  {p.item.rawValue === ALL ? "All interfaces" : p.item.rawValue}{" "}
                  <span class="mono text-xs text-subtle">
                    {p.item.rawValue === ALL ? "" : (addressesOf(p.item.rawValue)[0] ?? "")}
                  </span>
                </span>
              </SelectItem>
            )}
          >
            <SelectTrigger
              aria-label="Interface"
              class="h-8 w-auto min-w-[260px] rounded-md px-2.5 text-sm"
            >
              <SelectValue<string>>
                {(s) => {
                  const v = s.selectedOption();
                  if (v === ALL) return "All interfaces";
                  return (
                    <span class="flex items-center gap-2">
                      <StatusDot
                        class={
                          (interfaces.data ?? []).find((i) => i.name === v)?.up
                            ? "bg-ok"
                            : "bg-danger"
                        }
                      />
                      {v}
                      <span class="mono text-xs text-subtle">
                        {addressesOf(v)[0] ?? "no address"}
                      </span>
                    </span>
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </SettingRow>
        {familyRow("v4")}
        {familyRow("v6")}
        <section aria-label="Interfaces" class="flex flex-col border-t border-accent">
          <div class="flex flex-wrap items-center justify-between gap-x-4 px-4 pt-3 pb-1">
            <span class="text-sm text-subtle">
              Interfaces on the daemon's machine · <span class="mono">GET /app/interfaces</span>
            </span>
            <span class="flex items-center gap-1.5 text-sm text-subtle">
              <StatusDot class="bg-ok" /> listening
            </span>
          </div>
          <Show
            when={(interfaces.data ?? []).length > 0}
            fallback={
              <p class="m-0 px-4 pb-3 text-sm text-subtle">
                {interfaces.isError ? "The interfaces could not be read." : "Reading…"}
              </p>
            }
          >
            <ul class="m-0 list-none p-0">
              <For each={interfaces.data ?? []}>
                {(i) => (
                  <li class="grid h-9 grid-cols-[14px_80px_minmax(0,1fr)_90px] items-center gap-3 border-b border-accent px-4 text-sm last:border-b-0">
                    <StatusDot
                      class={isListening(i) ? "bg-ok" : i.up ? "bg-border-strong" : "bg-danger"}
                    />
                    <span class={cn("truncate mono", !isListening(i) && "text-muted-foreground")}>
                      {i.name}
                    </span>
                    <span class="truncate mono text-muted-foreground">
                      {i.addresses.length > 0 ? i.addresses.join(" · ") : "no address"}
                    </span>
                    <span class="text-right text-subtle">
                      {isListening(i) ? "listening" : i.up ? "" : "down"}
                    </span>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </section>
      </SettingsGroup>

      <SettingsGroup title="Transports">
        <SettingRow
          label="Peer transport"
          description="µTP yields to other traffic on your line; TCP is faster on a dedicated box."
          changed={changed("transports")}
        >
          <Segmented
            label="Peer transport"
            options={TRANSPORTS}
            value={draft.transports}
            onChange={(v) => set("transports", v)}
          />
        </SettingRow>
      </SettingsGroup>
    </SettingsPage>
  );
}

export default function Connection() {
  return (
    <WithSettings title="Connection">{(saved) => <ConnectionForm saved={saved()} />}</WithSettings>
  );
}
