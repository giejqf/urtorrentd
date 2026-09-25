// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { createSignal, For } from "solid-js";

import { cn } from "~/lib/utils";

/**
 * The design's tags field: chips with a remove button, then a text input.
 * Enter or a comma adds what was typed; Backspace in the empty input
 * removes the last chip. Known tags are offered as suggestions.
 */
export function TagInput(props: {
  id?: string;
  label: string;
  value: readonly string[];
  suggestions: readonly string[];
  onChange: (tags: string[]) => void;
  class?: string;
}) {
  const [text, setText] = createSignal("");
  const listId = () => `${props.id ?? "tags"}-suggestions`;
  const add = (raw: string) => {
    const tags = raw
      .split(",")
      .map((t) => t.trim())
      .filter((t) => t !== "" && !props.value.includes(t));
    if (tags.length > 0) props.onChange([...props.value, ...tags]);
    setText("");
  };
  return (
    <div
      class={cn(
        "flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-lg border border-input bg-background px-2 py-1 focus-within:border-ring focus-within:shadow-focus",
        props.class,
      )}
    >
      <For each={props.value}>
        {(tag) => (
          <span class="inline-flex h-6 items-center gap-1.5 rounded-md border border-border bg-accent pr-1 pl-2 text-sm whitespace-nowrap">
            {tag}
            <button
              type="button"
              class="inline-flex size-4 items-center justify-center rounded-sm text-subtle hover:text-foreground"
              aria-label={`Remove tag ${tag}`}
              onClick={() => props.onChange(props.value.filter((t) => t !== tag))}
            >
              ×
            </button>
          </span>
        )}
      </For>
      <input
        id={props.id}
        aria-label={props.label}
        list={listId()}
        class="h-6 min-w-20 flex-1 bg-transparent text-base text-foreground outline-none placeholder:text-subtle"
        placeholder="Add tag…"
        value={text()}
        spellcheck={false}
        onInput={(e) => {
          const v = e.currentTarget.value;
          if (v.includes(",")) add(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(text());
          } else if (e.key === "Backspace" && text() === "" && props.value.length > 0) {
            props.onChange(props.value.slice(0, -1));
          }
        }}
        onBlur={() => add(text())}
      />
      <datalist id={listId()}>
        <For each={props.suggestions.filter((s) => !props.value.includes(s))}>
          {(s) => <option value={s} />}
        </For>
      </datalist>
    </div>
  );
}
