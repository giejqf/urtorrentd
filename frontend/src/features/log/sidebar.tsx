// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Log screen's part of the sidebar, as the design has it: the main log
// and the peer log (its bans live on Settings › Banned addresses), the
// levels and the topics with their counts, and how much the daemon keeps.

import { A, useSearchParams } from "@solidjs/router";
import { createMemo, For, Show } from "solid-js";

import { StatusDot } from "~/components/status-dot";
import { FilterItem, Section } from "~/features/shell/sidebar";
import { formatCount, formatDateTime } from "~/lib/format";
import { cn } from "~/lib/utils";

import { useMainLog, usePeerLog } from "./use-log";
import { counts, isLevel, isTopic, LEVEL_LABELS, LEVELS, TOPIC_LABELS, TOPICS } from "./view";

export interface LogParams {
  level?: string;
  topic?: string;
  q?: string;
  [key: string]: string | undefined;
}

export const LEVEL_DOTS = { info: "bg-faint", warning: "bg-warn", error: "bg-danger" } as const;

export default function LogSidebar(props: { onNavigate?: () => void }) {
  const [params, setParams] = useSearchParams<LogParams>();
  const log = useMainLog();
  const peers = usePeerLog();
  const entries = () => log.data ?? [];
  const level = () => (isLevel(params.level) ? params.level : null);
  const topic = () => (isTopic(params.topic) ? params.topic : null);
  const n = createMemo(() => counts(entries(), { level: level(), topic: topic() }));
  const pick = (p: Partial<LogParams>) => {
    setParams(p);
    props.onNavigate?.();
  };
  return (
    <>
      <div class="flex min-h-0 flex-1 flex-col overflow-auto px-2 py-2">
        <Section title="Log">
          <FilterItem
            label="Main log"
            count={entries().length}
            active
            onClick={() => pick({ level: undefined, topic: undefined, q: undefined })}
          />
          <A
            href="/settings/bans"
            class="flex h-7 w-full min-w-0 items-center justify-between gap-2 rounded-md px-2 text-base text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            onClick={() => props.onNavigate?.()}
          >
            <span class="truncate">Peer log · bans</span>
            <span class="flex-none mono text-xs text-subtle">
              {formatCount(peers.data?.length ?? 0)}
            </span>
          </A>
        </Section>
        <Section title="Level">
          <FilterItem
            label={
              <>
                <StatusDot class="bg-foreground" />
                All
              </>
            }
            count={n().all}
            active={level() === null}
            onClick={() => pick({ level: undefined })}
          />
          <For each={LEVELS}>
            {(l) => (
              <FilterItem
                label={
                  <>
                    <StatusDot class={LEVEL_DOTS[l]} />
                    {LEVEL_LABELS[l]}
                  </>
                }
                count={n().levels[l]}
                active={level() === l}
                onClick={() => pick({ level: level() === l ? undefined : l })}
              />
            )}
          </For>
        </Section>
        <Section title="About">
          <FilterItem
            label="Everything"
            count={[...n().topics.values()].reduce((a, b) => a + b, 0)}
            active={topic() === null}
            onClick={() => pick({ topic: undefined })}
          />
          <For each={TOPICS.filter((t) => (n().topics.get(t) ?? 0) > 0 || topic() === t)}>
            {(t) => (
              <FilterItem
                label={<span class="truncate">{TOPIC_LABELS[t]}</span>}
                count={n().topics.get(t) ?? 0}
                active={topic() === t}
                onClick={() => pick({ topic: topic() === t ? undefined : t })}
              />
            )}
          </For>
        </Section>
      </div>
      <div class="flex flex-none flex-col gap-1.5 border-t border-divider px-3 py-2.5 mono text-xs text-subtle">
        <div class="flex justify-between gap-2">
          <span>kept in memory</span>
          <span>{formatCount(entries().length)} entries</span>
        </div>
        <div class={cn("flex justify-between gap-2")}>
          <span>oldest</span>
          <Show when={entries()[0]} fallback={<span>—</span>}>
            {(e) => <span>{formatDateTime(e().time)}</span>}
          </Show>
        </div>
      </div>
    </>
  );
}
