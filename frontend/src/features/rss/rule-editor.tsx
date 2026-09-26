// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// A download rule in the screen's panel (not designed: built from the
// settings' pieces): its filters, the feeds it reads, how what it takes is
// added, and what it would take now (the list beside it is its dry run).
// Saved at once with Save (`PUT /rss/rules/{name}`, then a rename), or
// deleted.

import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { createEffect, createMemo, createSignal, For, type JSX, on, Show, untrack } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { FolderPicker } from "~/components/folder-picker";
import { TagInput } from "~/components/tag-input";
import { Button } from "~/components/ui/button";
import { Checkbox, CheckboxLabel } from "~/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "~/components/ui/select";
import { Switch, SwitchControl, SwitchLabel } from "~/components/ui/switch";
import { Segmented } from "~/features/settings/controls";
import { useLive } from "~/features/shell/live";
import { formatAgo } from "~/lib/format";
import { cn } from "~/lib/utils";

import { Heading } from "./article-panel";
import { ConfirmDialog } from "./dialogs";
import {
  type RuleDraft,
  ruleChanged,
  ruleDraft,
  ruleProblems,
  ruleRequest,
  ruleSavePath,
  type Start,
} from "./rule-form";
import { feedName } from "./view";

type Rule = Schemas["RssRule"];
type Feed = Schemas["RssFeed"];

const field =
  "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-subtle focus:border-ring focus:shadow-focus";

const NO_CATEGORY = "\u0000none";

const STARTS: { value: Start; label: string }[] = [
  { value: "default", label: "As the setting" },
  { value: "started", label: "Started" },
  { value: "stopped", label: "Stopped" },
];

function Field(props: {
  id: string;
  label: string;
  hint?: JSX.Element;
  error?: string;
  children: JSX.Element;
}) {
  return (
    <div class="flex flex-col gap-1.5">
      <label for={props.id} class="text-sm font-medium">
        {props.label}
      </label>
      {props.children}
      <Show when={props.error}>
        <span class="text-sm text-danger" role="alert">
          {props.error}
        </span>
      </Show>
      <Show when={props.hint && !props.error}>
        <span class="text-xs text-subtle">{props.hint}</span>
      </Show>
    </div>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <Switch
      class="flex items-center justify-between gap-3"
      checked={props.checked}
      onChange={props.onChange}
    >
      <SwitchLabel class="text-sm font-medium">{props.label}</SwitchLabel>
      <SwitchControl />
    </Switch>
  );
}

export function RuleEditor(props: {
  rule: Rule;
  feeds: readonly Feed[];
  /** Articles its filters take now (the dry run); `undefined` while asked. */
  matches: number | undefined;
  onRenamed: (name: string) => void;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const live = useLive();
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
  }));
  const [draft, setDraft] = createStore<RuleDraft>(untrack(() => ruleDraft(props.rule)));
  createEffect(
    on(
      () => props.rule,
      (r) => setDraft(reconcile(ruleDraft(r))),
      { defer: true },
    ),
  );
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  const problems = createMemo(() => ruleProblems(draft));
  const changed = () => ruleChanged(props.rule, draft);
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => {
    setError(null);
    setDraft(k, v);
  };

  const categories = createMemo(() => {
    const names = Object.keys(live.state.categories).sort();
    const own = draft.category;
    return [NO_CATEGORY, ...(own !== null && !names.includes(own) ? [own] : []), ...names];
  });
  const tags = () => [...live.state.tags].sort();
  const savePath = () => {
    const s = settings.data;
    if (!s) return "";
    return ruleSavePath(
      { category: draft.category, auto_management: props.rule.add_options.auto_management },
      live.state.categories,
      s,
    );
  };

  const refresh = () => client.invalidateQueries({ queryKey: keys.rss() });
  const save = async (reset = false) => {
    if (Object.keys(problems()).length > 0) return;
    setBusy(true);
    try {
      const body = { ...ruleRequest(props.rule, draft), reset_history: reset };
      await unwrap(
        api.PUT("/api/v1/rss/rules/{name}", { params: { path: { name: props.rule.name } }, body }),
      );
      const to = draft.name.trim();
      if (to !== props.rule.name) {
        await unwrap(
          api.POST("/api/v1/rss/rules/{name}/rename", {
            params: { path: { name: props.rule.name } },
            body: { name: to },
          }),
        );
        props.onRenamed(to);
      }
      toast.success(reset ? "What the rule took is forgotten" : "Rule saved");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The rule could not be saved.");
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const remove = async () => {
    try {
      await unwrap(
        api.DELETE("/api/v1/rss/rules/{name}", { params: { path: { name: props.rule.name } } }),
      );
      toast.success(`Rule ${props.rule.name} deleted`);
      props.onDeleted();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The rule could not be deleted.");
    }
    await refresh();
  };

  return (
    <div class="flex h-full min-h-0 flex-col bg-card">
      <div class="flex h-12 flex-none items-center gap-1 border-b border-divider pr-3 pl-4">
        <span class="min-w-0 flex-1 truncate text-sm text-subtle">
          Rule <span aria-hidden="true">›</span> {props.rule.name}
        </span>
      </div>
      <form
        class="flex min-h-0 flex-1 flex-col gap-5 overflow-auto p-4"
        aria-label={`Rule ${props.rule.name}`}
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <p class="m-0 text-sm text-muted-foreground" role="status">
          {props.matches === undefined
            ? "Asking what it would take…"
            : props.matches === 1
              ? "Its filters take 1 of the articles kept (the list)."
              : `Its filters take ${props.matches} of the articles kept (the list).`}
          <Show when={props.rule.last_match}>
            {(t) => <> Last took something {formatAgo(t(), Math.floor(Date.now() / 1000))}.</>}
          </Show>
        </p>

        <div class="flex flex-col gap-3">
          <Field id="rule-name" label="Name" error={problems().name}>
            <input
              id="rule-name"
              class={field}
              value={draft.name}
              onInput={(e) => set("name", e.currentTarget.value)}
            />
          </Field>
          <Toggle label="On" checked={draft.enabled} onChange={(v) => set("enabled", v)} />
        </div>

        <div class="flex flex-col gap-3">
          <Heading>Filters</Heading>
          <Field
            id="rule-must"
            label="Must contain"
            hint={
              draft.use_regex
                ? "A regular expression; case ignored."
                : "Words in any order; * any text, ? one character, | or. Empty takes all."
            }
          >
            <input
              id="rule-must"
              class={cn(field, "mono")}
              value={draft.must_contain}
              spellcheck={false}
              onInput={(e) => set("must_contain", e.currentTarget.value)}
            />
          </Field>
          <Field id="rule-must-not" label="Must not contain">
            <input
              id="rule-must-not"
              class={cn(field, "mono")}
              value={draft.must_not_contain}
              spellcheck={false}
              onInput={(e) => set("must_not_contain", e.currentTarget.value)}
            />
          </Field>
          <Toggle
            label="Regular expressions"
            checked={draft.use_regex}
            onChange={(v) => set("use_regex", v)}
          />
          <Field id="rule-episodes" label="Episodes" hint="1x2;1x8-15;2x1-; — empty takes any.">
            <input
              id="rule-episodes"
              class={cn(field, "mono")}
              placeholder="any"
              value={draft.episode_filter}
              spellcheck={false}
              onInput={(e) => set("episode_filter", e.currentTarget.value)}
            />
          </Field>
          <Toggle
            label="Smart filter: each episode once"
            checked={draft.smart_filter}
            onChange={(v) => set("smart_filter", v)}
          />
          <Field
            id="rule-ignore"
            label="After a match, take nothing for (days)"
            error={problems().ignore_days}
          >
            <input
              id="rule-ignore"
              class={cn(field, "mono")}
              inputMode="numeric"
              value={draft.ignore_days}
              onInput={(e) => set("ignore_days", e.currentTarget.value)}
            />
          </Field>
        </div>

        <fieldset class="m-0 flex flex-col gap-2 border-0 p-0">
          <legend class="mb-2 p-0">
            <Heading>Feeds it reads</Heading>
          </legend>
          <Show
            when={props.feeds.length > 0}
            fallback={<p class="m-0 text-sm text-subtle">There is no feed yet.</p>}
          >
            <For each={props.feeds}>
              {(f) => (
                <Checkbox
                  class="flex items-center gap-2.5"
                  checked={draft.feeds.includes(f.id)}
                  onChange={(on) =>
                    set(
                      "feeds",
                      on ? [...draft.feeds, f.id] : draft.feeds.filter((id) => id !== f.id),
                    )
                  }
                >
                  <CheckboxLabel class="text-sm">{feedName(f)}</CheckboxLabel>
                </Checkbox>
              )}
            </For>
          </Show>
          <Show when={draft.feeds.length === 0}>
            <p class="m-0 text-xs text-subtle">Without a feed it takes nothing.</p>
          </Show>
        </fieldset>

        <div class="flex flex-col gap-3">
          <Heading>How it adds</Heading>
          <Select<string>
            options={categories()}
            value={draft.category ?? NO_CATEGORY}
            onChange={(v) => v !== null && set("category", v === NO_CATEGORY ? null : v)}
            itemComponent={(p) => (
              <SelectItem item={p.item}>
                {p.item.rawValue === NO_CATEGORY ? "None" : p.item.rawValue}
              </SelectItem>
            )}
          >
            <div class="flex flex-col gap-1.5">
              <span class="text-sm font-medium">Category</span>
              <SelectTrigger aria-label="Category" class="h-8 w-full rounded-md px-2.5 text-sm">
                <SelectValue<string>>
                  {(s) => (s.selectedOption() === NO_CATEGORY ? "None" : s.selectedOption())}
                </SelectValue>
              </SelectTrigger>
            </div>
            <SelectContent />
          </Select>
          <TagInput
            id="rule-tags"
            label="Tags"
            value={draft.tags}
            suggestions={tags()}
            onChange={(t) => set("tags", t)}
          />
          <Toggle
            label="A save path of its own"
            checked={draft.save_path_on}
            onChange={(v) => set("save_path_on", v)}
          />
          <Show
            when={draft.save_path_on}
            fallback={
              <p class="m-0 text-xs text-subtle">
                Saved in <span class="mono">{savePath()}</span>
              </p>
            }
          >
            <Field id="rule-save-path" label="Save path" error={problems().save_path}>
              <div class="flex gap-2">
                <input
                  id="rule-save-path"
                  class={cn(field, "mono")}
                  value={draft.save_path}
                  spellcheck={false}
                  onInput={(e) => set("save_path", e.currentTarget.value)}
                />
                <FolderPicker
                  what="rule's save path"
                  value={draft.save_path}
                  onPick={(p) => set("save_path", p)}
                />
              </div>
            </Field>
          </Show>
          <div class="flex flex-col gap-1.5">
            <span class="text-sm font-medium">Start what it adds</span>
            <Segmented
              label="Start what it adds"
              options={STARTS}
              value={draft.start}
              onChange={(v) => set("start", v)}
            />
          </div>
        </div>

        <Show when={error()}>
          <p class="m-0 text-sm text-danger" role="alert">
            {error()}
          </p>
        </Show>
        <div class="flex flex-wrap gap-2">
          <Button
            type="submit"
            disabled={busy() || !changed() || Object.keys(problems()).length > 0}
          >
            Save rule
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!changed()}
            onClick={() => {
              setError(null);
              setDraft(reconcile(ruleDraft(props.rule)));
            }}
          >
            Discard
          </Button>
          <div class="flex-1" />
          <Button
            type="button"
            variant="outline"
            class="text-danger"
            onClick={() => setDeleting(true)}
          >
            Delete rule
          </Button>
        </div>
        <Show when={props.rule.matched_episodes.length > 0 || props.rule.last_match !== null}>
          <div class="flex items-center justify-between gap-3 border-t border-divider pt-4">
            <span class="text-sm text-subtle">
              {props.rule.matched_episodes.length > 0
                ? `It took ${props.rule.matched_episodes.length} episodes (smart filter).`
                : "It remembers when it last took something."}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy() || changed()}
              onClick={() => void save(true)}
            >
              Forget
            </Button>
          </div>
        </Show>
      </form>
      <ConfirmDialog
        open={deleting()}
        title={`Delete the rule ${props.rule.name}?`}
        description="It takes nothing more. What it added stays."
        action="Delete"
        onClose={() => setDeleting(false)}
        onConfirm={() => void remove()}
      />
    </div>
  );
}
