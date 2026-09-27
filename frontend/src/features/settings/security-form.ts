// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The Security & API page's form (sign-in limits and the HTTP layer), the
// checks its lists need (address blocks, host names, origins, the host this
// page is on), a client's user agent in a word or two, and the cookie jar's
// text. Pure and tested.

import type { Schemas } from "~/api/client";

import type { FormDiff } from "./form";
import { isIp, isIpv4, isIpv6 } from "./network-form";
import { parseTime, timeText, type TimeUnit } from "./queue-form";
import { countText, parseCount } from "./speed-form";

type Settings = Schemas["Settings"];
type SettingsPatch = Schemas["SettingsPatch"];
type Cookie = Schemas["Cookie"];

export interface SecurityDraft {
  api_session_timeout: string;
  api_session_timeout_unit: TimeUnit;
  api_max_auth_failures: string;
  api_ban_duration: string;
  api_ban_duration_unit: TimeUnit;
  api_bypass_local_auth: boolean;
  api_auth_whitelist: string[];
  api_trusted_proxies: string[];
  api_allowed_hosts: string[];
  api_csrf_protection: boolean;
  api_cors_origins: string[];
}

export type SecurityField = keyof SecurityDraft;

export function securityDraft(s: Settings): SecurityDraft {
  const timeout = timeText(s.api_session_timeout);
  const ban = timeText(s.api_ban_duration);
  return {
    api_session_timeout: timeout.text,
    api_session_timeout_unit: timeout.unit,
    api_max_auth_failures: countText(s.api_max_auth_failures),
    api_ban_duration: ban.text,
    api_ban_duration_unit: ban.unit,
    api_bypass_local_auth: s.api_bypass_local_auth,
    api_auth_whitelist: [...s.api_auth_whitelist],
    api_trusted_proxies: [...s.api_trusted_proxies],
    api_allowed_hosts: [...s.api_allowed_hosts],
    api_csrf_protection: s.api_csrf_protection,
    api_cors_origins: [...s.api_cors_origins],
  };
}

/** Why a text is not an address or a block (`10.0.0.0/8`, `fd00::/8`); `null` = it is. */
export function blockProblem(text: string): string | null {
  const [ip, bits, extra] = text.split("/");
  const ok =
    ip !== undefined &&
    extra === undefined &&
    (bits === undefined
      ? isIp(ip)
      : /^\d{1,3}$/.test(bits) &&
        ((isIpv4(ip) && Number(bits) <= 32) || (isIpv6(ip) && Number(bits) <= 128)));
  return ok ? null : "An address or a block, such as 10.0.0.0/8.";
}

/** Why a text is not a host name pattern (`*`, `*.example.com`, `seedbox.lan`). */
export function hostProblem(text: string): string | null {
  const name = text.startsWith("*.") ? text.slice(2) : text;
  const ok =
    text === "*" || /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9-]+)*$/.test(name);
  return ok ? null : "A host name, *.domain for its subdomains, or * for any.";
}

/** Why a text is not an origin (`https://ui.example.com`, `http://localhost:5173`). */
export function originProblem(text: string): string | null {
  const ok = /^https?:\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9.-]+)(:\d{1,5})?$/.test(text);
  return ok ? null : "An origin: http(s)://host, and :port if not the default.";
}

/** The host of a `Host` value, without its port. */
function hostPart(authority: string): string {
  const v6 = /^\[([^\]]*)\]/.exec(authority);
  if (v6?.[1] !== undefined) return v6[1];
  const m = /^(.*):(\d*)$/.exec(authority);
  return m?.[1] ?? authority;
}

/** Whether the daemon lets a `Host` through with these names (IP addresses always pass). */
export function hostAllowed(host: string, allowed: readonly string[]): boolean {
  const h = hostPart(host.trim());
  if (isIp(h)) return true;
  const name = h.toLowerCase();
  return allowed.some((a) => {
    const p = a.trim().toLowerCase();
    return p === "*" || p === name || (p.startsWith("*.") && name.endsWith(p.slice(1)));
  });
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * The form's diff. `host` is the host this page is on (`POST /auth/check`):
 * a list of allowed hosts without it would lock the page out.
 */
export function securityDiff(
  saved: Settings,
  d: SecurityDraft,
  host: string | null,
): FormDiff<SecurityField> {
  const patch: Record<string, unknown> = {};
  const changed = new Set<SecurityField>();
  const names: string[] = [];
  const errors: Partial<Record<SecurityField, string>> = {};
  const note = (field: SecurityField, value: unknown) => {
    patch[field] = value;
    changed.add(field);
    names.push(field);
  };
  const fail = (field: SecurityField, problem: string) => {
    errors[field] = problem;
    changed.add(field);
  };

  const timeout = parseTime(d.api_session_timeout, d.api_session_timeout_unit);
  if (timeout === undefined || timeout === null || timeout < 60) {
    fail("api_session_timeout", "At least a minute.");
  } else if (timeout !== saved.api_session_timeout) note("api_session_timeout", timeout);

  const tries = parseCount(d.api_max_auth_failures, false);
  if (tries === undefined || tries === null || tries < 1) {
    fail("api_max_auth_failures", "A whole number, at least 1.");
  } else if (tries !== saved.api_max_auth_failures) note("api_max_auth_failures", tries);

  const ban = parseTime(d.api_ban_duration, d.api_ban_duration_unit);
  if (ban === undefined || ban === null) fail("api_ban_duration", "How long, such as 15 min.");
  else if (ban !== saved.api_ban_duration) note("api_ban_duration", ban);

  for (const f of ["api_bypass_local_auth", "api_csrf_protection"] as const) {
    if (d[f] !== saved[f]) note(f, d[f]);
  }
  for (const f of [
    "api_auth_whitelist",
    "api_trusted_proxies",
    "api_allowed_hosts",
    "api_cors_origins",
  ] as const) {
    if (!sameList(d[f], saved[f])) note(f, [...d[f]]);
  }
  if (host !== null && !hostAllowed(host, d.api_allowed_hosts)) {
    fail(
      "api_allowed_hosts",
      `This page is on ${hostPart(host)}: keep it, or a pattern that covers it.`,
    );
  }
  return { patch: patch as SettingsPatch, changed, names, errors };
}

const BROWSERS: [RegExp, string][] = [
  [/\bEdg(?:e|A|iOS)?\//, "Edge"],
  [/\bOPR\//, "Opera"],
  [/\bFirefox\//, "Firefox"],
  [/\bFxiOS\//, "Firefox"],
  [/\bCriOS\//, "Chrome"],
  [/\bChrom(?:e|ium)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/\biPhone\b/, "iPhone"],
  [/\biPad\b/, "iPad"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

/**
 * A user agent in a word or two: `Firefox · Linux`, `Safari · iPhone`,
 * `curl/8.9`, `python-requests/2.32`. Anything else: its first product.
 */
export function shortAgent(ua: string | null): string {
  if (ua === null || ua.trim() === "") return "unknown client";
  const browser = BROWSERS.find(([re]) => re.test(ua))?.[1];
  if (browser) {
    const system = SYSTEMS.find(([re]) => re.test(ua))?.[1];
    return system ? `${browser} · ${system}` : browser;
  }
  return ua.trim().split(/\s+/)[0] ?? ua;
}

/** A cookie's value as the jar shows it: short ones whole, longer ones cut (they are often passkeys). */
export function maskValue(value: string): string {
  return value.length <= 6 ? value : `${value.slice(0, 4)}…${value.slice(-2)}`;
}

/**
 * A cookie typed as a `Set-Cookie` line: `name=value; Domain=tracker.example;
 * Path=/; Expires=…` (or `Max-Age`). The domain is needed: the jar sends a
 * cookie only to it. A string is what is wrong.
 */
export function parseCookie(text: string, now: number): Cookie | string {
  const [first, ...attrs] = text.split(";");
  const eq = first?.indexOf("=") ?? -1;
  const name = first?.slice(0, eq).trim() ?? "";
  const value = first?.slice(eq + 1).trim() ?? "";
  if (eq < 1 || name === "" || /[\s,;=]/.test(name)) return "Start with name=value.";
  const cookie: Cookie = { name, value, domain: "" };
  for (const a of attrs) {
    const i = a.indexOf("=");
    const key = (i < 0 ? a : a.slice(0, i)).trim().toLowerCase();
    const v = i < 0 ? "" : a.slice(i + 1).trim();
    if (key === "domain") cookie.domain = v.replace(/^\./, "").toLowerCase();
    else if (key === "path") cookie.path = v === "" ? "/" : v;
    else if (key === "expires") {
      const t = Date.parse(v);
      if (Number.isNaN(t)) return `The expiry ${JSON.stringify(v)} is not a date.`;
      cookie.expires = Math.max(Math.floor(t / 1000), 0);
    } else if (key === "max-age") {
      if (!/^-?\d+$/.test(v)) return "Max-Age is a number of seconds.";
      cookie.expires = Math.max(now + Number(v), 0);
    }
  }
  if (cookie.domain === "") return "Add the tracker's domain: Domain=tracker.example.";
  if (!/^[a-z0-9.-]+$/.test(cookie.domain)) return "The domain is a host name.";
  return cookie;
}

/** A jar's key: a cookie with the same name, domain and path replaces the old one. */
export function sameCookie(a: Cookie, b: Cookie): boolean {
  return a.name === b.name && a.domain === b.domain && (a.path ?? "/") === (b.path ?? "/");
}

/** A key as it may be shown beside it: its start and end. */
export function keyAbbrev(key: string): string {
  return key.length <= 16 ? key : `${key.slice(0, 9)}…${key.slice(-4)}`;
}
