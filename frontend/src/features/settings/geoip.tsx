// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Not designed: DB-IP Lite in one click (ADR 0009), and DB-IP's credit. The
// daemon downloads their country and ASN databases when asked, never on its
// own; their licence (CC BY 4.0) asks for a link to DB-IP wherever their
// data is shown, so every place that shows peers' countries or networks
// carries the credit while the loaded database is theirs.

import { useQueryClient } from "@tanstack/solid-query";
import { createSignal, Show } from "solid-js";
import { toast } from "solid-sonner";

import { api, ApiError, unwrap } from "~/api/client";
import { keys } from "~/api/keys";
import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

import { useAppInfo } from "./app-info";
import { isDbIp, releaseMonth } from "./geoip-view";

const link = "underline decoration-divider underline-offset-2 hover:text-foreground";

/** DB-IP's credit as their licence asks: a link to them, and the licence. */
export function DbIpCredit(props: { class?: string }) {
  return (
    <span class={cn("text-subtle", props.class)}>
      <a href="https://db-ip.com" target="_blank" rel="noopener noreferrer" class={link}>
        IP Geolocation by DB-IP
      </a>{" "}
      ·{" "}
      <a
        href="https://creativecommons.org/licenses/by/4.0/"
        target="_blank"
        rel="noopener noreferrer"
        class={link}
      >
        CC BY 4.0
      </a>
    </span>
  );
}

/** The credit, while the daemon's GeoIP data is DB-IP's. */
export function GeoCredit(props: { class?: string }) {
  const app = useAppInfo();
  return (
    <Show when={isDbIp(app.data?.geoip)}>
      <DbIpCredit class={props.class} />
    </Show>
  );
}

/**
 * Download DB-IP Lite's country and ASN databases now and use them; with
 * theirs loaded, the same fetches the newest month.
 */
export function DownloadGeoIp(props: {
  size?: "xs" | "sm";
  class?: string;
  /** Why it cannot run now (unsaved settings it would replace). */
  blocked?: string;
}) {
  const app = useAppInfo();
  const client = useQueryClient();
  const [busy, setBusy] = createSignal(false);
  const run = async () => {
    setBusy(true);
    try {
      const info = await unwrap(
        api.POST("/api/v1/app/geoip/download", { body: { source: "dbip_lite" } }),
      );
      const built = info.country?.built ?? null;
      toast.success(`DB-IP Lite${built === null ? "" : ` of ${releaseMonth(built)}`} is in use`);
    } catch (e) {
      toast.error(`GeoIP download: ${e instanceof ApiError ? e.message : "failed"}`);
    } finally {
      setBusy(false);
      await Promise.all([
        client.invalidateQueries({ queryKey: keys.app() }),
        client.invalidateQueries({ queryKey: keys.settings() }),
      ]);
    }
  };
  return (
    <Button
      variant="outline"
      size={props.size ?? "sm"}
      class={props.class}
      disabled={busy() || props.blocked !== undefined}
      title={props.blocked}
      onClick={() => void run()}
    >
      {busy()
        ? "Downloading…"
        : isDbIp(app.data?.geoip)
          ? "Update DB-IP Lite"
          : "Download DB-IP Lite"}
    </Button>
  );
}
