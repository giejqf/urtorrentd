// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { describe, expect, it } from "vitest";

import type { Schemas } from "~/api/client";

import { isDbIp, releaseMonth } from "./geoip-view";

const db = (type: string | null): Schemas["GeoDatabaseInfo"] => ({
  path: "/x.mmdb",
  database_type: type,
  built: 1_788_226_365,
  loaded: 1_790_513_987,
  error: null,
});

describe("geoip", () => {
  it("knows DB-IP's databases, which need their credit", () => {
    expect(isDbIp({ country: db("DBIP-Country-Lite"), asn: null })).toBe(true);
    expect(isDbIp({ country: null, asn: db("DBIP-ASN-Lite (compat=GeoLite2-ASN)") })).toBe(true);
    expect(isDbIp({ country: db("GeoLite2-Country"), asn: db("GeoLite2-ASN") })).toBe(false);
    expect(isDbIp({ country: db(null), asn: null })).toBe(false);
    expect(isDbIp(undefined)).toBe(false);
  });

  it("names a release by its month, in UTC", () => {
    expect(releaseMonth(1_788_226_365)).toBe("September 2026");
    expect(releaseMonth(Date.UTC(2027, 0, 1) / 1000)).toBe("January 2027");
  });
});
