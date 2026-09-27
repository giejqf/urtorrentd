// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// GeoIP in one click (ADR 0009): Settings › Statistics & GeoIP downloads
// DB-IP Lite's country and ASN databases from a local stand-in for
// db-ip.com, the daemon uses them, DB-IP is credited where their data is
// shown, and a bad download changes nothing.

import { gzipSync } from "node:zlib";

import { expect, expectAccessible, test } from "./fixtures";
import { asn, country, mmdbBytes } from "./mmdb";

/** This month (UTC), as DB-IP names its files. */
function month(): string {
  return new Date().toISOString().slice(0, 7);
}

test("DB-IP Lite is downloaded from the settings, used and credited", async ({
  signedIn: page,
  daemon,
  mirror,
}) => {
  const countryFile = `dbip-country-lite-${month()}.mmdb.gz`;
  mirror.files.set(
    countryFile,
    gzipSync(mmdbBytes("DBIP-Country-Lite", [["127.0.0.0/8", country("NZ", "New Zealand")]])),
  );
  mirror.files.set(
    `dbip-asn-lite-${month()}.mmdb.gz`,
    gzipSync(
      mmdbBytes("DBIP-ASN-Lite (compat=GeoLite2-ASN)", [["127.0.0.0/8", asn(64500, "Test Net")]]),
    ),
  );

  await page.goto(`${daemon.url}/settings/statistics`);
  const geo = page.getByRole("region", { name: "GeoIP" });
  await expect(geo).toContainText("Country · none");
  await geo.getByRole("button", { name: "Download DB-IP Lite" }).click();
  await expect(geo).toContainText("Country · loaded");
  await expect(geo).toContainText("DBIP-Country-Lite");
  await expect(geo).toContainText("DBIP-ASN-Lite");
  await expect(geo.getByRole("button", { name: "Update DB-IP Lite" })).toBeVisible();
  const credit = geo.getByRole("link", { name: "IP Geolocation by DB-IP" });
  await expect(credit).toHaveAttribute("href", "https://db-ip.com");
  await expect(geo.getByRole("link", { name: "CC BY 4.0" })).toHaveAttribute(
    "href",
    "https://creativecommons.org/licenses/by/4.0/",
  );
  await expectAccessible(page);
  const settings = (await daemon.api.GET("/api/v1/settings")).data;
  expect(settings?.geoip_database).toMatch(/\/geoip\/dbip-country-lite\.mmdb$/);
  expect(settings?.geoip_asn_database).toMatch(/\/geoip\/dbip-asn-lite\.mmdb$/);

  // A download that is not a database is refused; the one in use stays.
  mirror.files.set(countryFile, gzipSync(Buffer.from("not a database")));
  await geo.getByRole("button", { name: "Update DB-IP Lite" }).click();
  await expect(page.getByText(/GeoIP download: .*not a MaxMind DB/)).toBeVisible();
  await expect(geo).toContainText("DBIP-Country-Lite");

  // Credited where their data is shown.
  await page.goto(`${daemon.url}/stats/peers`);
  await expect(page.getByRole("link", { name: "IP Geolocation by DB-IP" }).first()).toBeVisible();
  await page.goto(`${daemon.url}/settings/about`);
  await expect(page.getByRole("link", { name: "IP Geolocation by DB-IP" })).toBeVisible();
});

test("without GeoIP, Stats › Peers offers DB-IP Lite", async ({
  signedIn: page,
  daemon,
  mirror,
}) => {
  // Nothing published at the stand-in: the error says so, nothing changes.
  mirror.files.clear();
  await page.goto(`${daemon.url}/stats/peers`);
  await page.getByRole("button", { name: "Download DB-IP Lite" }).click();
  await expect(page.getByText(/GeoIP download: .*nothing published/)).toBeVisible();
  expect((await daemon.api.GET("/api/v1/settings")).data?.geoip_database).toBeNull();
});
