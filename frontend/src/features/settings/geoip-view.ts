// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// What the GeoIP download and DB-IP's credit go by (geoip.tsx).

import type { Schemas } from "~/api/client";

type GeoIpInfo = Schemas["GeoIpInfo"];

/** Whether a loaded GeoIP database is DB-IP's (their credit is then due). */
export function isDbIp(g: GeoIpInfo | null | undefined): boolean {
  return [g?.country, g?.asn].some((d) => d?.database_type?.startsWith("DBIP") ?? false);
}

/** A database's month, as DB-IP names its releases ("September 2026"). */
export function releaseMonth(built: number): string {
  return new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" }).format(
    built * 1000,
  );
}
