// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// The one client of the daemon's API (AGENTS.md 4.1). The UI is always
// served from the daemon's origin, so requests are relative and the session
// cookie goes along by default.

import createClient from "openapi-fetch";

import type { components, paths } from "~/api/schema";

export type Schemas = components["schemas"];
export type ErrorCode = Schemas["ErrorCode"];

/** `network`: no answer from the daemon (unreachable, or a proxy's own error page). */
export type ApiErrorCode = ErrorCode | "network";

/** A failed call: the daemon's `ErrorBody`, or `network` when there is none. */
export class ApiError extends Error {
  /** The HTTP status; 0 when no response arrived. */
  readonly status: number;
  /** Branch on this, never on the message. */
  readonly code: ApiErrorCode;

  constructor(status: number, code: ApiErrorCode, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

export const api = createClient<paths>({ baseUrl: "" });

function isErrorBody(body: unknown): body is Schemas["ErrorBody"] {
  if (typeof body !== "object" || body === null || !("error" in body)) return false;
  const e = (body as { error: unknown }).error;
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { code?: unknown }).code === "string" &&
    typeof (e as { message?: unknown }).message === "string"
  );
}

/** The `ApiError` for a failed response and its (parsed) body. */
export function toApiError(status: number, body: unknown): ApiError {
  if (isErrorBody(body)) {
    return new ApiError(status, body.error.code, body.error.message);
  }
  // Not the daemon's error shape: a reverse proxy answered for it.
  return new ApiError(status, "network", `The daemon did not answer (HTTP ${status}).`);
}

type Unauthorized = (error: ApiError) => void;
let unauthorized: Unauthorized | undefined;

/**
 * What to do when a call finds the session gone (`401`): the app sends the
 * user to sign-in. Wrong credentials at sign-in or setup are not that.
 */
export function onUnauthorized(handler: Unauthorized | undefined): void {
  unauthorized = handler;
}

const CREDENTIAL_PATHS = ["/api/v1/auth/login", "/api/v1/auth/setup"];

type Result<T> = { data?: T; error?: unknown; response: Response };
type Data<T> = [T] extends [never] ? undefined : T;

/**
 * The data of a call, or an `ApiError`: `unwrap(api.GET("/api/v1/app"))`.
 * Calls answered with `204 No Content` resolve to `undefined`.
 */
export async function unwrap<T>(pending: Promise<Result<T>>): Promise<Data<T>> {
  let result: Result<T>;
  try {
    result = await pending;
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "network", "The daemon cannot be reached.");
  }
  const { response } = result;
  if (response.ok) return result.data as Data<T>;
  const error = toApiError(response.status, result.error);
  if (error.status === 401 && unauthorized) {
    const path = new URL(response.url || "/", "http://x").pathname;
    if (!CREDENTIAL_PATHS.includes(path)) unauthorized(error);
  }
  throw error;
}
