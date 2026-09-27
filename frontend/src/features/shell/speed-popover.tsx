// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Not designed: the session's limits from the sidebar's transfer footer, as
// qBittorrent's status bar has them: the global download and upload limits
// (applied on Enter or leaving the field) and the alternative limits'
// switch. Settings › Speed has the rest (the schedule, the budget).

import { A } from "@solidjs/router";
import { createQuery, useQueryClient } from "@tanstack/solid-query";
import { createEffect, createSignal, type JSX, on } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { Switch, SwitchControl, SwitchLabel } from "~/components/ui/switch";
import { UnitInput } from "~/features/settings/controls";
import { kbText, parseKb } from "~/features/settings/speed-form";
import { formatLimit } from "~/lib/format";

import { useLive } from "./live";

type Which = "download_limit" | "upload_limit";

export function SpeedPopover(props: { children: JSX.Element; class?: string; label: string }) {
  const live = useLive();
  const client = useQueryClient();
  const [open, setOpen] = createSignal(false);
  const settings = createQuery(() => ({
    queryKey: keys.settings(),
    queryFn: () => unwrap(api.GET("/api/v1/settings")),
    enabled: open(),
  }));
  const [down, setDown] = createSignal("");
  const [up, setUp] = createSignal("");
  // Each opening starts from the settings as they are.
  createEffect(
    on(
      () => [open(), settings.data] as const,
      ([o, s]) => {
        if (!o || !s) return;
        setDown(kbText(s.download_limit));
        setUp(kbText(s.upload_limit));
      },
    ),
  );
  const save = async (which: Which, text: string) => {
    const bytes = parseKb(text);
    if (bytes === undefined) {
      toast.error("A limit is a number of kB/s, or empty for none.");
      return;
    }
    if (settings.data && settings.data[which] === bytes) return;
    try {
      await unwrap(api.PATCH("/api/v1/settings", { body: { [which]: bytes } }));
      void client.invalidateQueries({ queryKey: keys.settings() });
      toast.success(
        `${which === "download_limit" ? "Download" : "Upload"} limit ${formatLimit(bytes)}`,
      );
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The limit was not saved.");
    }
  };
  const alt = () => live.state.transfer?.alt_speed_enabled ?? false;
  const switchAlt = async (enabled: boolean) => {
    try {
      await unwrap(api.PUT("/api/v1/transfer/alt-speed", { body: { enabled } }));
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "The alternative limits did not switch.");
    }
  };
  const field = (which: Which, label: string, value: () => string, set: (v: string) => void) => (
    <div class="flex items-center justify-between gap-3">
      <label for={`quick-${which}`} class="text-sm text-foreground-2">
        {label}
      </label>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save(which, value());
        }}
      >
        <UnitInput
          id={`quick-${which}`}
          value={value()}
          onInput={set}
          unit="kB/s"
          placeholder="∞"
          class="w-[130px]"
          muted={alt()}
        />
      </form>
    </div>
  );
  return (
    <Popover open={open()} onOpenChange={setOpen} placement="top-start">
      <PopoverTrigger as="button" type="button" class={props.class} aria-label={props.label}>
        {props.children}
      </PopoverTrigger>
      <PopoverContent class="flex w-[300px] flex-col gap-3 p-4">
        <PopoverTitle class="m-0 text-base font-semibold">Speed limits</PopoverTitle>
        <div
          class="flex flex-col gap-2"
          onFocusOut={(e) => {
            const t = e.target;
            if (t instanceof HTMLInputElement && t.id === "quick-download_limit") {
              void save("download_limit", down());
            } else if (t instanceof HTMLInputElement && t.id === "quick-upload_limit") {
              void save("upload_limit", up());
            }
          }}
        >
          {field("download_limit", "Download", down, setDown)}
          {field("upload_limit", "Upload", up, setUp)}
        </div>
        <Switch
          checked={alt()}
          onChange={(on) => void switchAlt(on)}
          class="flex items-center justify-between gap-3 border-t border-divider pt-3"
        >
          <SwitchLabel class="flex flex-col text-sm text-foreground-2">
            Alternative limits
            <span class="text-xs text-subtle">
              {settings.data
                ? `${formatLimit(settings.data.alt_download_limit)} down · ${formatLimit(settings.data.alt_upload_limit)} up${alt() ? ", in force" : ""}`
                : alt()
                  ? "in force"
                  : "off"}
            </span>
          </SwitchLabel>
          <SwitchControl />
        </Switch>
        <A
          href="/settings/speed"
          class="text-xs text-subtle hover:text-foreground"
          onClick={() => setOpen(false)}
        >
          Schedule and more in Settings › Speed
        </A>
      </PopoverContent>
    </Popover>
  );
}
