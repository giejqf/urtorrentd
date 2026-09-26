// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Settings › BitTorrent, as the design has it: peer discovery (DHT, PEX,
// LSD) with the last day's peer traffic by how the peer was found
// (`/stats/peers?dim=source`), the DHT's bootstrap routers, encryption and
// the identity peers and trackers see. Edits are a draft saved with one
// `PATCH /settings`.

import { createQuery } from "@tanstack/solid-query";
import { createMemo, For, type JSX, Show } from "solid-js";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
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
import { ChipList, RowSwitch, Segmented, SettingRow, SettingsGroup } from "./controls";
import { createSettingsForm, SettingsPage, WithSettings } from "./form";
import {
  type BitTorrentDraft,
  bitTorrentDiff,
  bitTorrentDraft,
  type BitTorrentField,
  hostPortProblem,
} from "./network-form";

const ENCRYPTION: { value: Schemas["Encryption"]; label: string }[] = [
  { value: "disabled", label: "Disabled" },
  { value: "enabled", label: "Enabled" },
  { value: "forced", label: "Forced" },
];

function Tag(props: { children: JSX.Element; warn?: boolean }) {
  // The space keeps a label's accessible name readable ("DHT BEP 5").
  return (
    <>
      {" "}
      <span
        class={cn(
          "ml-2 inline-flex h-[18px] items-center rounded border px-1.5 mono text-2xs font-normal",
          props.warn ? "border-warn/35 text-warn" : "border-border text-muted-foreground",
        )}
      >
        {props.children}
      </span>
    </>
  );
}

/** How a peer was found, as the mix groups it; `flag` = the switch that finds it. */
const SOURCES: {
  key: string;
  label: string;
  tone: string;
  flag?: "dht" | "pex" | "lsd";
  keys: (string | null)[];
}[] = [
  { key: "tracker", label: "Tracker", tone: "bg-muted-foreground", keys: ["tracker"] },
  { key: "dht", label: "DHT", tone: "bg-cat-1", flag: "dht", keys: ["dht"] },
  { key: "pex", label: "PEX", tone: "bg-cat-2", flag: "pex", keys: ["pex"] },
  { key: "lsd", label: "LSD", tone: "bg-cat-3", flag: "lsd", keys: ["lsd"] },
  { key: "incoming", label: "Incoming", tone: "bg-cat-4", keys: ["incoming"] },
  {
    key: "other",
    label: "Other",
    tone: "bg-border-strong",
    keys: ["manual", "resume", "other", null],
  },
];

const DAY = 86_400;

function DiscoveryMix(props: { draft: BitTorrentDraft }) {
  const mix = createQuery(() => ({
    queryKey: ["stats", "peers", "source", "day"],
    queryFn: () => {
      const to = Math.floor(Date.now() / 1000);
      return unwrap(
        api.GET("/api/v1/stats/peers", {
          params: { query: { dim: "source", from: to - DAY, to, step: "hour" } },
        }),
      );
    },
    retry: false,
    refetchInterval: 5 * 60_000,
  }));
  const parts = createMemo(() => {
    const rows = mix.data?.rows ?? [];
    const bytes = (keys: (string | null)[]) =>
      rows.filter((r) => keys.includes(r.key)).reduce((n, r) => n + r.downloaded + r.uploaded, 0);
    const total = rows.reduce((n, r) => n + r.downloaded + r.uploaded, 0);
    return {
      total,
      items: SOURCES.map((s) => ({
        ...s,
        bytes: bytes(s.keys),
        kept: s.flag === undefined || props.draft[s.flag],
      })),
    };
  });
  const share = (n: number) => (parts().total > 0 ? Math.round((n / parts().total) * 100) : 0);
  const kept = () =>
    parts()
      .items.filter((i) => i.kept)
      .reduce((n, i) => n + i.bytes, 0);
  const lost = () => parts().items.filter((i) => !i.kept && i.bytes > 0);
  const off = () =>
    mix.error instanceof ApiError && (mix.error.status === 503 || mix.error.code === "unavailable");
  return (
    <section
      aria-label="How peers were found"
      class="flex flex-col gap-2.5 border-t border-accent px-4 pt-3.5 pb-4"
    >
      <Show
        when={mix.data}
        fallback={
          <p class="m-0 text-sm text-subtle">
            {off()
              ? "Statistics are off, so there is no record of how peers were found. They are in Statistics & GeoIP."
              : mix.isError
                ? "The statistics could not be read."
                : "Reading the statistics…"}
          </p>
        }
      >
        <div class="flex flex-wrap items-center justify-between gap-x-4">
          <span class="text-sm text-subtle">
            The last day's peer traffic by how the peer was found, and what the switches above keep
          </span>
          <Show when={parts().total > 0}>
            <span class="mono text-sm text-subtle">{share(kept())}% kept</span>
          </Show>
        </div>
        <Show
          when={parts().total > 0}
          fallback={<p class="m-0 text-sm text-subtle">No peer traffic in the last day.</p>}
        >
          <div class="flex h-3.5 gap-0.5 overflow-hidden rounded bg-row-divider" aria-hidden="true">
            <For each={parts().items.filter((i) => i.bytes > 0)}>
              {(i) => (
                <div
                  class={cn("h-full", i.kept ? i.tone : "bg-border")}
                  style={{ width: `${(i.bytes / parts().total) * 100}%` }}
                />
              )}
            </For>
          </div>
          <ul class="m-0 flex list-none flex-wrap gap-3.5 p-0">
            <For each={parts().items}>
              {(i) => (
                <li
                  class={cn(
                    "flex items-center gap-1.5 text-xs",
                    i.kept ? "text-muted-foreground" : "text-subtle line-through",
                  )}
                >
                  <span
                    class={cn("size-2.5 flex-none rounded-[3px]", i.kept ? i.tone : "bg-border")}
                  />
                  {i.label} <span class="mono">{share(i.bytes)}%</span>
                </li>
              )}
            </For>
          </ul>
          <Show when={lost().length > 0}>
            <p class="m-0 text-sm text-warn" role="status">
              Turning off{" "}
              {lost()
                .map((i) => i.label)
                .join(" and ")}{" "}
              would lose the peers that brought {share(lost().reduce((n, i) => n + i.bytes, 0))}% of
              the last day's traffic, all on public torrents.
            </p>
          </Show>
        </Show>
      </Show>
    </section>
  );
}

function IdentityCard(props: { name: string; line: string; note: string; selected: boolean }) {
  return (
    <div
      class={cn(
        "flex min-w-0 flex-1 flex-col gap-1 rounded-lg border px-3 py-2.5",
        props.selected ? "border-border-strong bg-muted" : "border-border",
      )}
    >
      <span
        class={cn("flex items-center text-sm", props.selected ? "text-foreground" : "text-subtle")}
      >
        <span class="mono">{props.name}</span>
        <Show when={props.selected}>
          <Tag>selected</Tag>
        </Show>
      </span>
      <span class="truncate mono text-sm">{props.line}</span>
      <span class="text-sm text-subtle">{props.note}</span>
    </div>
  );
}

function BitTorrentForm(props: { saved: Schemas["Settings"] }) {
  const live = useLive();
  const app = useAppInfo();
  const form = createSettingsForm<BitTorrentDraft, BitTorrentField>(
    () => props.saved,
    bitTorrentDraft,
    bitTorrentDiff,
  );
  const { draft, changed, set, setDraft } = form;

  const native = () => app.data?.library ?? "urtorrent";
  const identities = (): Record<Schemas["Identity"], { title: string; line: string }> => ({
    native: { title: "urtorrent (native)", line: native() },
    qbt_5_2_3_lt2_0_14: { title: "qBittorrent 5.2.3", line: "libtorrent 2.0.14, as qBittorrent" },
  });

  const flagRow = (
    field: "dht" | "pex" | "lsd",
    label: string,
    bep: string,
    description: () => string,
  ) => (
    <SettingRow
      label={
        <>
          {label}
          <Tag>{bep}</Tag>
        </>
      }
      for={`b-${field}-input`}
      description={description()}
      changed={changed(field)}
    >
      <RowSwitch id={`b-${field}`} checked={draft[field]} onChange={(v) => set(field, v)} />
    </SettingRow>
  );

  return (
    <SettingsPage
      title="BitTorrent"
      description="How peers are found, how connections are protected, and what the daemon calls itself."
      form={form}
    >
      <SettingsGroup
        title="Peer discovery"
        aside="Private torrents never use these, only their trackers"
      >
        {flagRow("dht", "DHT", "BEP 5", () =>
          props.saved.dht && live.state.transfer
            ? `Trackerless peer lookup. ${formatCount(live.state.transfer.dht_nodes)} nodes in the routing table now.`
            : "Trackerless peer lookup.",
        )}
        {flagRow("pex", "Peer exchange", "BEP 11", () => "Peers tell each other about peers.")}
        {flagRow(
          "lsd",
          "Local service discovery",
          "BEP 14",
          () => "Finds peers on your own network by multicast. Pointless on a hosted box.",
        )}
        <DiscoveryMix draft={draft} />
        <SettingRow
          label={
            <>
              DHT bootstrap routers
              <Tag warn>restart</Tag>
            </>
          }
          for="b-dht_bootstrap_nodes"
          class="items-start"
          description={
            draft.dht_bootstrap_custom
              ? "Where the DHT starts from with an empty table. None: it starts only from the nodes it saved. Applies after a restart."
              : "Where the DHT starts from with an empty table: the identity's own routers. Add one to use your own list. Applies after a restart."
          }
          changed={changed("dht_bootstrap_nodes")}
        >
          <div class="flex w-full max-w-[340px] flex-col items-end gap-1.5">
            <ChipList
              id="b-dht_bootstrap_nodes"
              what="router"
              layout="stack"
              placeholder="host:port"
              values={draft.dht_bootstrap_custom ? draft.dht_bootstrap_nodes : []}
              problem={hostPortProblem}
              onChange={(v) => {
                setDraft({ dht_bootstrap_custom: true, dht_bootstrap_nodes: v });
              }}
            />
            <Show when={draft.dht_bootstrap_custom}>
              <Button
                variant="ghost"
                size="sm"
                class="text-muted-foreground"
                onClick={() => set("dht_bootstrap_custom", false)}
              >
                Use the identity's routers
              </Button>
            </Show>
          </div>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Protocol">
        <SettingRow
          label={
            <>
              Encryption
              <Tag>MSE / PE</Tag>
            </>
          }
          description="Enabled accepts both; Forced drops peers that cannot encrypt. Hides the traffic's shape from an ISP, not your address."
          changed={changed("encryption")}
        >
          <Segmented
            label="Encryption"
            options={ENCRYPTION}
            value={draft.encryption}
            onChange={(v) => set("encryption", v)}
          />
        </SettingRow>
        <SettingRow
          label="Identity"
          description="What peers and trackers see in the handshake and the user agent. Some private trackers only allow known clients."
          changed={changed("identity")}
        >
          <Select<Schemas["Identity"]>
            options={["native", "qbt_5_2_3_lt2_0_14"]}
            value={draft.identity}
            onChange={(v) => v !== null && set("identity", v)}
            itemComponent={(p) => (
              <SelectItem item={p.item}>
                <span class="flex flex-col leading-tight">
                  <span>{identities()[p.item.rawValue].title}</span>
                  <span class="mono text-xs text-subtle">{identities()[p.item.rawValue].line}</span>
                </span>
              </SelectItem>
            )}
          >
            <SelectTrigger
              aria-label="Identity"
              class="h-10 w-auto min-w-[300px] rounded-md px-2.5 text-sm"
            >
              <SelectValue<Schemas["Identity"]>>
                {(s) => {
                  const i = identities()[s.selectedOption()];
                  return (
                    <span class="flex flex-col leading-tight">
                      <span>{i.title}</span>
                      <span class="mono text-xs text-subtle">{i.line}</span>
                    </span>
                  );
                }}
              </SelectValue>
            </SelectTrigger>
            <SelectContent />
          </Select>
        </SettingRow>
        <div class="flex flex-col gap-2 border-t border-accent px-4 py-3 sm:flex-row">
          <IdentityCard
            name="native"
            line={native()}
            note="Honest. Works everywhere except trackers with a client whitelist."
            selected={draft.identity === "native"}
          />
          <IdentityCard
            name="qbt_5_2_3_lt2_0_14"
            line="qBittorrent 5.2.3 · libtorrent 2.0.14"
            note="Matches a whitelisted client, its extension bits included."
            selected={draft.identity === "qbt_5_2_3_lt2_0_14"}
          />
        </div>
      </SettingsGroup>
    </SettingsPage>
  );
}

export default function BitTorrent() {
  return (
    <WithSettings title="BitTorrent">{(saved) => <BitTorrentForm saved={saved()} />}</WithSettings>
  );
}
