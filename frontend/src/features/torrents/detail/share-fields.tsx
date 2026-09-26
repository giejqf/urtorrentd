// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Rows of the Options tab, and its share limits (ratio, seeding time,
// inactive seeding, what happens when one is reached), which the Share
// limits dialog uses for several torrents too. Global shows what it stands
// for (the category's limits, else the settings') when that is known.

import { createQuery } from "@tanstack/solid-query";
import { createMemo, type JSX, Show } from "solid-js";

import { api, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { ChangeDot, Segmented, UnitInput, UnitSelect } from "~/features/settings/controls";
import { ratioText, type TimeUnit } from "~/features/settings/queue-form";
import { type Effective, effectiveLimits } from "~/features/settings/share";
import { useLive } from "~/features/shell/live";
import { formatDays } from "~/lib/format";

import type { ActionChoice, Mode, ShareDraft } from "./options";

const MODES: { value: Mode; label: string }[] = [
  { value: "global", label: "Global" },
  { value: "unlimited", label: "∞" },
  { value: "limit", label: "Own" },
];
const UNITS: { value: TimeUnit; label: string }[] = [
  { value: "minutes", label: "min" },
  { value: "hours", label: "h" },
  { value: "days", label: "d" },
];
export const ACTION_LABELS: Record<Schemas["ShareLimitAction"], string> = {
  stop: "Stop",
  remove: "Remove",
  remove_with_files: "Remove + files",
};
const ALL_GLOBAL: Schemas["ShareLimits"] = {
  ratio: { mode: "global" },
  seeding_time: { mode: "global" },
  inactive_seeding_time: { mode: "global" },
  action: null,
};

export function OptionHeading(props: { children: string }) {
  return <h3 class="m-0 mt-2.5 section-label first:mt-0">{props.children}</h3>;
}

export function OptionRow(props: {
  label: JSX.Element;
  /** The control's id, so the label names it. */
  for?: string;
  changed?: boolean;
  error?: string;
  children: JSX.Element;
}) {
  const label = () => (
    <>
      {props.label}
      <Show when={props.changed}>
        <ChangeDot />
      </Show>
    </>
  );
  return (
    <div class="flex min-h-9 flex-wrap items-center justify-between gap-x-3 gap-y-1 text-sm">
      <Show
        when={props.for}
        fallback={<span class="flex items-center text-foreground-2">{label()}</span>}
      >
        <label for={props.for} class="flex items-center text-foreground-2">
          {label()}
        </label>
      </Show>
      {props.children}
      <Show when={props.error}>
        <span class="w-full text-right text-xs text-danger" role="alert">
          {props.error}
        </span>
      </Show>
    </div>
  );
}

/**
 * What Global stands for, for torrents in `category` (`undefined`: they
 * are in different ones, so nothing is shown).
 */
export function useInherited(category: () => string | null | undefined) {
  const live = useLive();
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
  }));
  return createMemo((): Effective | null => {
    const s = settings.data;
    const c = category();
    if (!s || c === undefined) return null;
    const limits = c === null || c === "" ? undefined : live.state.categories[c]?.share_limits;
    return effectiveLimits(ALL_GLOBAL, limits, {
      ratio: s.max_ratio,
      seeding: s.max_seeding_time,
      inactive: s.max_inactive_seeding_time,
      action: s.share_limit_action,
    });
  });
}

function limitText(v: number | null, unit: "ratio" | "time"): string {
  if (v === null) return "none";
  return unit === "ratio" ? ratioText(v) : formatDays(v);
}

export function ShareFields(props: {
  draft: ShareDraft;
  set: <K extends keyof ShareDraft>(field: K, value: ShareDraft[K]) => void;
  inherited: Effective | null;
  /** Prefix of the fields' ids. */
  id: string;
  changed?: (row: "ratio" | "seeding" | "inactive" | "action") => boolean;
  error?: (row: "ratio" | "seeding" | "inactive") => string | undefined;
}) {
  const limit = (field: "ratio" | "seeding" | "inactive", label: string) => {
    const modeKey = `${field}_mode` as const;
    const placeholder = () => {
      const i = props.inherited;
      const m = props.draft[modeKey];
      if (m === "unlimited") return "∞";
      if (m === "limit" || !i) return "";
      return field === "ratio"
        ? limitText(i.ratio, "ratio")
        : limitText(field === "seeding" ? i.seeding : i.inactive, "time");
    };
    return (
      <OptionRow label={label} changed={props.changed?.(field)} error={props.error?.(field)}>
        <span class="flex items-center gap-1.5">
          <Segmented
            label={`${label}: where the limit comes from`}
            compact
            options={MODES}
            value={props.draft[modeKey]}
            onChange={(m) => props.set(modeKey, m)}
          />
          <UnitInput
            id={`${props.id}-${field}`}
            label={`${label} limit`}
            class={field === "ratio" ? "h-[30px] w-16" : "h-[30px] w-[108px]"}
            value={props.draft[field]}
            placeholder={placeholder()}
            muted={props.draft[modeKey] !== "limit"}
            changed={props.changed?.(field)}
            invalid={props.error?.(field) !== undefined}
            onInput={(v) => {
              props.set(field, v);
              // Typing a value makes the limit their own.
              if (v.trim() !== "") props.set(modeKey, "limit");
            }}
            trailing={
              field === "ratio" ? undefined : (
                <UnitSelect
                  label={`${label} unit`}
                  options={UNITS}
                  value={props.draft[field === "seeding" ? "seeding_unit" : "inactive_unit"]}
                  onChange={(u) =>
                    props.set(field === "seeding" ? "seeding_unit" : "inactive_unit", u)
                  }
                />
              )
            }
          />
        </span>
      </OptionRow>
    );
  };
  const actions = createMemo(() => {
    const global = props.inherited?.action;
    return [
      {
        value: "global" as ActionChoice,
        label: global ? `Global · ${ACTION_LABELS[global].toLowerCase()}` : "Global",
      },
      ...(["stop", "remove", "remove_with_files"] as const).map((a) => ({
        value: a as ActionChoice,
        label: ACTION_LABELS[a],
        danger: a === "remove_with_files",
      })),
    ];
  });
  return (
    <>
      {limit("ratio", "Ratio")}
      {limit("seeding", "Seeding time")}
      {limit("inactive", "Inactive seeding")}
      <OptionRow label="When reached" changed={props.changed?.("action")}>
        <Segmented
          label="When a limit is reached"
          compact
          options={actions()}
          value={props.draft.action}
          onChange={(a) => props.set("action", a)}
          changed={props.changed?.("action")}
        />
      </OptionRow>
    </>
  );
}
