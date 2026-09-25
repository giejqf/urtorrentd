// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, onUnauthorized, toApiError, unwrap } from "./client";

function response(status: number, url = "http://localhost/api/v1/app"): Response {
  const r = new Response(null, { status });
  Object.defineProperty(r, "url", { value: url });
  return r;
}

const body = (code: string, message: string) => ({ error: { code, message } });

afterEach(() => onUnauthorized(undefined));

describe("toApiError", () => {
  it("keeps the daemon's code and message", () => {
    const e = toApiError(409, body("conflict", "the credentials are already set; log in"));
    expect(e).toBeInstanceOf(ApiError);
    expect(e.status).toBe(409);
    expect(e.code).toBe("conflict");
    expect(e.message).toBe("the credentials are already set; log in");
  });

  it("calls anything else a network failure", () => {
    const e = toApiError(502, "<html>Bad Gateway</html>");
    expect(e.code).toBe("network");
    expect(e.status).toBe(502);
    expect(toApiError(500, { error: "nope" }).code).toBe("network");
    expect(toApiError(500, null).code).toBe("network");
  });
});

describe("unwrap", () => {
  it("returns the data of a success", async () => {
    const data = await unwrap(Promise.resolve({ data: { a: 1 }, response: response(200) }));
    expect(data).toEqual({ a: 1 });
  });

  it("returns undefined for no content", async () => {
    const data = await unwrap(Promise.resolve({ data: undefined, response: response(204) }));
    expect(data).toBeUndefined();
  });

  it("throws the daemon's error", async () => {
    const pending = unwrap(
      Promise.resolve({
        error: body("torrent_not_found", "no such torrent"),
        response: response(404),
      }),
    );
    await expect(pending).rejects.toMatchObject({ status: 404, code: "torrent_not_found" });
  });

  it("turns a failed fetch into a network error", async () => {
    const pending = unwrap(Promise.reject(new TypeError("fetch failed")));
    await expect(pending).rejects.toMatchObject({ status: 0, code: "network" });
  });

  it("lets aborts through", async () => {
    const abort = new DOMException("aborted", "AbortError");
    await expect(unwrap(Promise.reject(abort))).rejects.toBe(abort);
  });

  it("reports an ended session, but not wrong credentials", async () => {
    const handler = vi.fn();
    onUnauthorized(handler);
    const expired = body("unauthorized", "the session has expired; log in again");
    await expect(
      unwrap(Promise.resolve({ error: expired, response: response(401) })),
    ).rejects.toMatchObject({ code: "unauthorized" });
    expect(handler).toHaveBeenCalledTimes(1);

    const wrong = body("unauthorized", "wrong user name or password");
    const login = response(401, "http://localhost/api/v1/auth/login");
    await expect(unwrap(Promise.resolve({ error: wrong, response: login }))).rejects.toMatchObject({
      code: "unauthorized",
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
