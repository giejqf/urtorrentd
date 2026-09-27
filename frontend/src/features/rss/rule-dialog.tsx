// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// A download rule, edited in the designed dialog: its filters, the feeds
// it reads and how what it takes is added on the left; on the right what
// the rule as typed would do with each article of those feeds, asked of
// the daemon as it changes (`POST /rss/dry-run`: take, already taken, or
// filtered out and why). Saved with `PUT /rss/rules/{name}` (then a
// rename), optionally forgetting what it took; deleted after a question.
// Beside the list, a short summary of the rule chosen opens it.

import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { createEffect, createMemo, createSignal, For, type JSX, on, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { toast } from "solid-sonner";

import { api, ApiError, type Schemas, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { ConfirmDialog } from "~/components/confirm-dialog";
import { FolderPicker } from "~/components/folder-picker";
import { StatusDot } from "~/components/status-dot";
import { TagInput } from "~/components/tag-input";
import { Button } from "~/components/ui/button";
import { Checkbox, CheckboxLabel } from "~/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "~/components/ui/dialog";
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
import { formatAgo, formatBytes, formatCount, formatShortDate } from "~/lib/format";
import { useSettled } from "~/lib/settled";
import { categoryTone } from "~/lib/torrent";
import { cn } from "~/lib/utils";

import { Heading } from "./article-panel";
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
type Verdict = Schemas["RssDryRunArticle"];

const field =
  "h-8 w-full min-w-0 rounded-md border border-border bg-background px-2.5 text-sm text-foreground outline-none placeholder:text-subtle focus:border-ring focus:shadow-focus";

const NO_CATEGORY = "\u0000none";

const STARTS: { value: Start; label: string }[] = [
  { value: "stopped", label: "Stopped" },
  { value: "started", label: "Started" },
  { value: "default", label: "Default" },
];

function Field(props: {
  id: string;
  label: string;
  hint?: JSX.Element;
  error?: string;
  children: JSX.Element;
  class?: string;
}) {
  return (
    <div class={cn("flex min-w-0 flex-col gap-1.5", props.class)}>
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

function Toggle(props: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <Switch
      class="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-0.5"
      checked={props.checked}
      onChange={props.onChange}
    >
      <SwitchControl />
      <SwitchLabel class="text-sm font-medium">
        {props.label} <span class="font-normal text-subtle">· {props.hint}</span>
      </SwitchLabel>
    </Switch>
  );
}

/** How old an article is, short: "13 h", "Sep 22". */
function age(t: number | null, now: number): string {
  if (t === null) return "";
  const s = now - t;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min`;
  if (s < 86_400) return `${Math.round(s / 3600)} h`;
  return formatShortDate(t);
}

function VerdictRow(props: { v: Verdict; feed: string; now: number }) {
  const filtered = () => props.v.verdict === "filtered";
  return (
    <li class="grid grid-cols-[8px_minmax(0,1fr)_auto] items-center gap-2.5 border-b border-row-divider px-4 py-2 text-sm">
      <StatusDot
        class={
          props.v.verdict === "take"
            ? "bg-ok"
            : props.v.verdict === "taken"
              ? "bg-muted-foreground"
              : "bg-faint"
        }
        small
      />
      <span class="flex min-w-0 flex-col leading-tight">
        <span
          class={cn("truncate mono", filtered() && "text-subtle line-through")}
          title={props.v.title}
        >
          {props.v.title}
        </span>
        <span class="truncate text-xs text-subtle">
          <Show
            when={filtered()}
            fallback={
              <>
                {props.v.verdict === "taken" ? "already taken · " : ""}
                {props.feed}
                {props.v.size !== null ? ` · ${formatBytes(props.v.size)}` : ""}
              </>
            }
          >
            {props.v.reason}
          </Show>
        </span>
      </span>
      <span class="mono text-xs text-subtle">{age(props.v.date, props.now)}</span>
    </li>
  );
}

export function RuleDialog(props: {
  /** The rule to edit; `undefined` closes the dialog. */
  rule: Rule | undefined;
  feeds: readonly Feed[];
  onClose: () => void;
  onRenamed: (name: string) => void;
  onDeleted: () => void;
}) {
  const client = useQueryClient();
  const live = useLive();
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
  }));
  const blank: Rule = {
    name: "",
    enabled: true,
    must_contain: "",
    must_not_contain: "",
    use_regex: false,
    episode_filter: "",
    smart_filter: false,
    feeds: [],
    ignore_days: 0,
    add_options: {},
    last_match: null,
    matched_episodes: [],
  };
  const rule = () => props.rule ?? blank;
  const [draft, setDraft] = createStore<RuleDraft>(ruleDraft(blank));
  const [reset, setReset] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [deleting, setDeleting] = createSignal(false);
  // Opening (or another rule): start from the rule as saved. The name is a
  // memo: the rules are read again now and then, and what is typed stays.
  const opened = createMemo(() => props.rule?.name);
  createEffect(
    on(opened, () => {
      setDraft(reconcile(ruleDraft(rule())));
      setReset(false);
      setError(null);
    }),
  );
  const problems = createMemo(() => ruleProblems(draft));
  const changed = () => ruleChanged(rule(), draft);
  const set = <K extends keyof RuleDraft>(k: K, v: RuleDraft[K]) => {
    setError(null);
    setDraft(k, v);
  };

  // The dry run of the rule as typed, once typing settles.
  const request = createMemo(() => JSON.stringify(ruleRequest(rule(), draft)));
  const settled = useSettled(request);
  const dry = createQuery(() => ({
    queryKey: [...keys.rss(), "dry-run", settled()],
    queryFn: () =>
      unwrap(
        api.POST("/api/v1/rss/dry-run", {
          body: JSON.parse(settled()) as Schemas["RssRuleRequest"],
        }),
      ),
    enabled: props.rule !== undefined,
    retry: false,
    placeholderData: (prev: Verdict[] | undefined) => prev,
  }));
  const verdicts = () => dry.data ?? [];
  const taking = () => verdicts().filter((v) => v.verdict === "take").length;
  const feedById = createMemo(() => new Map(props.feeds.map((f) => [f.id, feedName(f)])));
  const now = () => Math.floor(Date.now() / 1000);

  const categories = createMemo(() => {
    const names = Object.keys(live.state.categories).sort();
    const own = draft.category;
    return [NO_CATEGORY, ...(own !== null && !names.includes(own) ? [own] : []), ...names];
  });
  const tags = () => [...live.state.tags].sort();
  const followed = () => {
    const s = settings.data;
    if (!s) return "";
    return ruleSavePath(
      { category: draft.category, auto_management: rule().add_options.auto_management },
      live.state.categories,
      s,
    );
  };

  const refresh = () => client.invalidateQueries({ queryKey: keys.rss() });
  const save = async () => {
    const r = props.rule;
    if (!r || Object.keys(problems()).length > 0) return;
    setBusy(true);
    try {
      const body = { ...ruleRequest(r, draft), reset_history: reset() };
      await unwrap(
        api.PUT("/api/v1/rss/rules/{name}", { params: { path: { name: r.name } }, body }),
      );
      const to = draft.name.trim();
      if (to !== r.name) {
        await unwrap(
          api.POST("/api/v1/rss/rules/{name}/rename", {
            params: { path: { name: r.name } },
            body: { name: to },
          }),
        );
        props.onRenamed(to);
      }
      toast.success(reset() ? "Rule saved; what it took is forgotten" : "Rule saved");
      props.onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "The rule could not be saved.");
    } finally {
      setBusy(false);
      await refresh();
    }
  };
  const remove = async () => {
    const r = props.rule;
    if (!r) return;
    try {
      await unwrap(api.DELETE("/api/v1/rss/rules/{name}", { params: { path: { name: r.name } } }));
      toast.success(`Rule ${r.name} deleted`);
      props.onDeleted();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The rule could not be deleted.");
    }
    await refresh();
  };
  const autoDownload = () => settings.data?.rss_auto_download;

  return (
    <Dialog open={props.rule !== undefined} onOpenChange={(o) => !o && props.onClose()}>
      <DialogContent
        class="max-h-[calc(100vh-2rem)] max-w-[980px] grid-rows-[auto_minmax(0,1fr)_auto] gap-0 overflow-hidden p-0"
        noClose
      >
        <div class="flex items-start gap-4 px-5 pt-[18px] pb-3">
          <div class="flex min-w-0 flex-1 flex-col gap-0.5">
            <DialogTitle class="truncate">Edit rule — {rule().name}</DialogTitle>
            <DialogDescription class="text-sm text-subtle">
              {autoDownload()
                ? "Saving runs it over its feeds' articles at once: auto-download is on."
                : "Auto-download is off (Settings › RSS): it adds nothing until that is on."}
            </DialogDescription>
          </div>
          <Switch
            class="flex flex-none items-center gap-2"
            checked={draft.enabled}
            onChange={(v) => set("enabled", v)}
          >
            <SwitchLabel class="text-sm">Enabled</SwitchLabel>
            <SwitchControl />
          </Switch>
          <Button variant="ghost" size="icon" aria-label="Close" onClick={() => props.onClose()}>
            ×
          </Button>
        </div>
        <div class="grid min-h-0 grid-cols-[minmax(0,1fr)_380px] border-t border-divider">
          <form
            class="flex min-h-0 flex-col gap-4 overflow-auto px-5 py-4"
            aria-label={`Rule ${rule().name}`}
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <Field id="rule-name" label="Name" error={problems().name}>
              <input
                id="rule-name"
                class={cn(field, "mono")}
                value={draft.name}
                onInput={(e) => set("name", e.currentTarget.value)}
              />
            </Field>
            <div class="grid grid-cols-2 gap-4">
              <Field id="rule-must" label="Must contain">
                <input
                  id="rule-must"
                  class={cn(field, "mono")}
                  value={draft.must_contain}
                  placeholder="anything"
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
            </div>
            <Toggle
              label="Regular expressions"
              hint={
                draft.use_regex
                  ? "on: each field is one expression, case ignored"
                  : "off: * and ? wildcards, words are AND, | is OR"
              }
              checked={draft.use_regex}
              onChange={(v) => set("use_regex", v)}
            />
            <div class="grid grid-cols-2 gap-4">
              <Field id="rule-episodes" label="Episode filter" hint="Empty = any episode.">
                <input
                  id="rule-episodes"
                  class={cn(field, "mono")}
                  placeholder="1x2;1x8-15;2x1-;"
                  value={draft.episode_filter}
                  spellcheck={false}
                  onInput={(e) => set("episode_filter", e.currentTarget.value)}
                />
              </Field>
              <Field
                id="rule-ignore"
                label="After a match, ignore for"
                hint="0 = off."
                error={problems().ignore_days}
              >
                <div class="flex h-8 items-center overflow-hidden rounded-md border border-border bg-background focus-within:border-ring focus-within:shadow-focus">
                  <input
                    id="rule-ignore"
                    class="h-full min-w-0 flex-1 bg-transparent px-2.5 text-right mono text-sm outline-none"
                    inputMode="numeric"
                    value={draft.ignore_days}
                    onInput={(e) => set("ignore_days", e.currentTarget.value)}
                  />
                  <span class="flex h-full items-center border-l border-border bg-card px-2.5 text-xs text-subtle">
                    days
                  </span>
                </div>
              </Field>
            </div>
            <Toggle
              label="Smart episode filter"
              hint="each episode once; a repack once more with Settings › RSS"
              checked={draft.smart_filter}
              onChange={(v) => set("smart_filter", v)}
            />
            <fieldset class="m-0 flex flex-col gap-2 border-0 p-0">
              <legend class="mb-2 p-0 text-sm font-medium">Feeds it applies to</legend>
              <Show
                when={props.feeds.length > 0}
                fallback={<p class="m-0 text-sm text-subtle">There is no feed yet.</p>}
              >
                <div class="grid grid-cols-2 gap-x-4 gap-y-2">
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
                        <CheckboxLabel class="truncate text-sm text-foreground">
                          {feedName(f)}
                        </CheckboxLabel>
                      </Checkbox>
                    )}
                  </For>
                </div>
              </Show>
            </fieldset>

            <Heading>Added as</Heading>
            <div class="grid grid-cols-2 gap-4">
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
                      {(s) => (
                        <span class="flex items-center gap-1.5">
                          <StatusDot
                            class={categoryTone(
                              s.selectedOption() === NO_CATEGORY ? null : s.selectedOption(),
                            )}
                          />
                          {s.selectedOption() === NO_CATEGORY ? "None" : s.selectedOption()}
                        </span>
                      )}
                    </SelectValue>
                  </SelectTrigger>
                </div>
                <SelectContent />
              </Select>
              <div class="flex min-w-0 flex-col gap-1.5">
                <span class="text-sm font-medium" aria-hidden="true">
                  Tags
                </span>
                <TagInput
                  id="rule-tags"
                  label="Tags"
                  value={draft.tags}
                  suggestions={tags()}
                  onChange={(t) => set("tags", t)}
                />
              </div>
              <Field id="rule-save-path" label="Save path" error={problems().save_path}>
                <div class="flex gap-1.5">
                  <input
                    id="rule-save-path"
                    class={cn(field, "mono")}
                    value={draft.save_path_on ? draft.save_path : ""}
                    placeholder={
                      followed() ? `${followed()} (follows the category)` : "follows the category"
                    }
                    spellcheck={false}
                    onInput={(e) => {
                      const v = e.currentTarget.value;
                      set("save_path", v);
                      set("save_path_on", v.trim() !== "");
                    }}
                  />
                  <FolderPicker
                    inline
                    what="rule's save path"
                    purpose={`Used as the save path of what ${rule().name} adds`}
                    value={draft.save_path_on ? draft.save_path : followed()}
                    onPick={(p) => {
                      set("save_path", p);
                      set("save_path_on", true);
                    }}
                  />
                </div>
              </Field>
              <div class="flex flex-col gap-1.5">
                <span class="text-sm font-medium">Start</span>
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
          </form>
          <section
            aria-label="Matches right now"
            class="flex min-h-0 flex-col border-l border-divider bg-background/40"
          >
            <div class="flex h-11 flex-none items-center justify-between gap-2 border-b border-divider px-4">
              <h3 class="m-0 text-sm font-medium">Matches right now</h3>
              <span class="mono text-xs text-subtle">
                {dry.data ? `${formatCount(taking())} would be added · dry run` : "dry run"}
              </span>
            </div>
            <Show
              when={!dry.isError}
              fallback={
                <p class="m-0 p-4 text-sm text-danger" role="alert">
                  The filters cannot be read:{" "}
                  {dry.error instanceof ApiError ? dry.error.message : "the daemon did not answer."}
                </p>
              }
            >
              <ul class="m-0 min-h-0 flex-1 list-none overflow-auto p-0" aria-label="Articles">
                <For
                  each={verdicts()}
                  fallback={
                    <li class="p-4 text-sm text-subtle">
                      {dry.isLoading
                        ? "Asking the daemon…"
                        : draft.feeds.length === 0
                          ? "Choose a feed: without one it takes nothing."
                          : "Its feeds have no article."}
                    </li>
                  }
                >
                  {(v) => <VerdictRow v={v} feed={feedById().get(v.feed) ?? ""} now={now()} />}
                </For>
              </ul>
            </Show>
            <div class="flex flex-none flex-col gap-1 border-t border-divider px-4 py-2.5 text-xs text-subtle">
              <span class="flex flex-wrap items-center gap-2.5">
                <span class="flex items-center gap-1">
                  <StatusDot class="bg-ok" small /> would be added
                </span>
                <span class="flex items-center gap-1">
                  <StatusDot class="bg-muted-foreground" small /> already taken
                </span>
                <span class="flex items-center gap-1">
                  <StatusDot class="bg-faint" small /> filtered out
                </span>
              </span>
              <span>
                What it took before is not applied in a dry run
                <Show when={rule().last_match}>
                  {(t) => <> (it last took something {formatAgo(t(), now())})</>}
                </Show>
                . Saving with Reset match history takes everything again.
              </span>
            </div>
          </section>
        </div>
        <div class="flex items-center gap-2 border-t border-divider px-5 py-3.5">
          <Button
            variant="outline"
            size="sm"
            class="border-danger/40 text-danger hover:bg-danger/10 hover:text-danger"
            onClick={() => setDeleting(true)}
          >
            Delete rule
          </Button>
          <span class="flex-1" />
          <Checkbox class="flex items-center gap-2" checked={reset()} onChange={setReset}>
            <CheckboxLabel class="text-sm text-foreground-2">Reset match history</CheckboxLabel>
          </Checkbox>
          <Button variant="outline" size="sm" onClick={() => props.onClose()}>
            Cancel
          </Button>
          <Button
            size="sm"
            disabled={busy() || (!changed() && !reset()) || Object.keys(problems()).length > 0}
            onClick={() => void save()}
          >
            Save rule
          </Button>
        </div>
        <ConfirmDialog
          open={deleting()}
          title={`Delete the rule ${rule().name}?`}
          description="It takes nothing more. What it added stays."
          action="Delete"
          onClose={() => setDeleting(false)}
          onConfirm={() => void remove()}
        />
      </DialogContent>
    </Dialog>
  );
}

function Fact(props: { label: string; children: JSX.Element }) {
  return (
    <div class="grid min-h-7 grid-cols-[104px_minmax(0,1fr)] items-center gap-x-3 text-sm">
      <dt class="text-subtle">{props.label}</dt>
      <dd class="m-0 min-w-0 truncate">{props.children}</dd>
    </div>
  );
}

/** The rule chosen, beside what it would take: what it is, and Edit. */
export function RuleSummary(props: {
  rule: Rule;
  feeds: readonly Feed[];
  /** Articles its filters take now (the list); `undefined` while asked. */
  matches: number | undefined;
  onEdit: () => void;
}) {
  const feeds = () =>
    props.feeds.filter((f) => props.rule.feeds.includes(f.id)).map((f) => feedName(f));
  const o = () => props.rule.add_options;
  return (
    <div class="flex h-full min-h-0 flex-col bg-card">
      <div class="flex h-12 flex-none items-center gap-2 border-b border-divider pr-3 pl-4">
        <span class="min-w-0 flex-1 truncate text-sm text-subtle">
          Rule <span aria-hidden="true">›</span> {props.rule.name}
        </span>
        <Button variant="outline" size="sm" onClick={() => props.onEdit()}>
          Edit rule
        </Button>
      </div>
      <div class="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4">
        <p class="m-0 text-sm text-muted-foreground" role="status">
          {props.matches === undefined
            ? "Asking what it would take…"
            : props.matches === 1
              ? "Its filters take 1 of the articles kept (the list)."
              : `Its filters take ${formatCount(props.matches)} of the articles kept (the list).`}
        </p>
        <dl class="m-0 flex flex-col">
          <Fact label="Enabled">{props.rule.enabled ? "yes" : "no"}</Fact>
          <Fact label="Must contain">
            <span class="mono">{props.rule.must_contain || "anything"}</span>
          </Fact>
          <Show when={props.rule.must_not_contain}>
            <Fact label="Must not">
              <span class="mono">{props.rule.must_not_contain}</span>
            </Fact>
          </Show>
          <Show when={props.rule.episode_filter}>
            <Fact label="Episodes">
              <span class="mono">{props.rule.episode_filter}</span>
            </Fact>
          </Show>
          <Fact label="Feeds">{feeds().length > 0 ? feeds().join(", ") : "none"}</Fact>
          <Fact label="Category">{o().category ?? "none"}</Fact>
          <Show when={(o().tags ?? []).length > 0}>
            <Fact label="Tags">{(o().tags ?? []).join(", ")}</Fact>
          </Show>
          <Fact label="Last match">
            {props.rule.last_match === null
              ? "never"
              : formatAgo(props.rule.last_match, Math.floor(Date.now() / 1000))}
          </Fact>
        </dl>
      </div>
    </div>
  );
}
