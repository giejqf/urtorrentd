// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// A download rule as the RSS screen edits it: the filters, the feeds it
// reads, and how what it takes is added (category, tags, save path,
// started or not). Saving replaces the rule (`PUT /rss/rules/{name}`) and
// keeps the add options this form does not show. Where its downloads go.
// Pure and tested.

import type { Schemas } from "~/api/client";
import { pathProblem } from "~/features/settings/downloads-form";
import { categorySavePath } from "~/features/settings/paths";

type Rule = Schemas["RssRule"];
type AddOptions = Schemas["AddOptions"];

export type Start = "default" | "started" | "stopped";

export interface RuleDraft {
  name: string;
  enabled: boolean;
  must_contain: string;
  must_not_contain: string;
  use_regex: boolean;
  episode_filter: string;
  smart_filter: boolean;
  ignore_days: string;
  feeds: number[];
  category: string | null;
  tags: string[];
  /** A save path of its own. */
  save_path_on: boolean;
  save_path: string;
  start: Start;
}

export function ruleDraft(r: Rule): RuleDraft {
  const o = r.add_options;
  return {
    name: r.name,
    enabled: r.enabled,
    must_contain: r.must_contain,
    must_not_contain: r.must_not_contain,
    use_regex: r.use_regex,
    episode_filter: r.episode_filter,
    smart_filter: r.smart_filter,
    ignore_days: String(r.ignore_days),
    feeds: [...r.feeds],
    category: o.category ?? null,
    tags: [...(o.tags ?? [])],
    save_path_on: (o.save_path ?? null) !== null,
    save_path: o.save_path ?? "",
    start: o.stopped === true ? "stopped" : o.stopped === false ? "started" : "default",
  };
}

/** Why the draft cannot be saved, by field; empty = it can. */
export function ruleProblems(d: RuleDraft): Partial<Record<keyof RuleDraft, string>> {
  const out: Partial<Record<keyof RuleDraft, string>> = {};
  if (d.name.trim() === "") out.name = "A rule needs a name.";
  if (!/^\d{1,4}$/.test(d.ignore_days.trim())) out.ignore_days = "Days, 0 for none.";
  if (d.save_path_on) {
    const p = pathProblem(d.save_path.trim());
    if (p) out.save_path = p;
  }
  return out;
}

/** The request that saves the draft over the rule (its other add options kept). */
export function ruleRequest(r: Rule, d: RuleDraft): Schemas["RssRuleRequest"] {
  const add: AddOptions = {
    ...r.add_options,
    category: d.category,
    tags: [...d.tags],
    save_path: d.save_path_on ? d.save_path.trim() : null,
    stopped: d.start === "default" ? null : d.start === "stopped",
  };
  return {
    enabled: d.enabled,
    must_contain: d.must_contain,
    must_not_contain: d.must_not_contain,
    use_regex: d.use_regex,
    episode_filter: d.episode_filter.trim(),
    smart_filter: d.smart_filter,
    feeds: [...d.feeds],
    ignore_days: Number(d.ignore_days.trim()) || 0,
    add_options: add,
    reset_history: false,
  };
}

const sameList = <T>(a: readonly T[], b: readonly T[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Whether the draft differs from the rule. */
export function ruleChanged(r: Rule, d: RuleDraft): boolean {
  const o = ruleDraft(r);
  return (Object.keys(o) as (keyof RuleDraft)[]).some((k) => {
    const a = o[k];
    const b = d[k];
    return Array.isArray(a) && Array.isArray(b)
      ? !sameList<unknown>(a, b)
      : k === "save_path"
        ? d.save_path_on && a !== b
        : a !== b;
  });
}

/** A new rule: it reads no feed, so it takes nothing until it is given some. */
export function newRule(): Schemas["RssRuleRequest"] {
  return {
    enabled: true,
    must_contain: "",
    must_not_contain: "",
    use_regex: false,
    episode_filter: "",
    smart_filter: false,
    feeds: [],
    ignore_days: 0,
    add_options: {},
    reset_history: false,
  };
}

/** Where what a rule takes is saved, as the daemon decides it. */
export function ruleSavePath(
  o: AddOptions,
  categories: Record<string, Schemas["Category"]>,
  s: Pick<Schemas["Settings"], "save_path" | "auto_management" | "category_paths_in_manual_mode">,
): string {
  const name = o.category ?? null;
  // A category the add creates has no paths of its own yet.
  const category = (n: string) =>
    categorySavePath(s.save_path, n, categories[n] ?? { save_path: null, download_path: null });
  const managed = o.auto_management ?? s.auto_management;
  if (name !== null && managed) return category(name);
  if (o.save_path) return o.save_path;
  if (name !== null && s.category_paths_in_manual_mode) return category(name);
  return s.save_path;
}
