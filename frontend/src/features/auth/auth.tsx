// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Who is signed in (AGENTS.md 4.1). The public `GET /auth/status` says
// whether first-run setup is open; `GET /app` answers when the browser has
// a session (or the daemon exempts its address). The session itself is the
// daemon's HttpOnly cookie: the UI never sees or stores a credential.

import {
  createContext,
  createSignal,
  onCleanup,
  onMount,
  type ParentComponent,
  untrack,
  useContext,
} from "solid-js";

import { api, ApiError, onUnauthorized, type Schemas, unwrap } from "~/api/client";

export type AuthState =
  | { kind: "loading" }
  | { kind: "signed-in"; app: Schemas["AppInfo"] }
  | {
      kind: "signed-out";
      /** No credentials yet: first-run setup is open. */
      setupRequired: boolean;
      /** The session ended while the UI was open. */
      expired: boolean;
    }
  | { kind: "unreachable"; message: string };

interface Auth {
  state: () => AuthState;
  /** Ask the daemon again. */
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
  /** The daemon is shutting down at the user's request. */
  stopped: () => void;
}

const AuthContext = createContext<Auth>();

function message(e: unknown): string {
  return e instanceof ApiError ? e.message : "The daemon cannot be reached.";
}

async function probe(): Promise<AuthState> {
  let setupRequired: boolean;
  try {
    setupRequired = (await unwrap(api.GET("/api/v1/auth/status"))).setup_required;
  } catch (e) {
    return { kind: "unreachable", message: message(e) };
  }
  try {
    return { kind: "signed-in", app: await unwrap(api.GET("/api/v1/app")) };
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) {
      return { kind: "signed-out", setupRequired, expired: false };
    }
    return { kind: "unreachable", message: message(e) };
  }
}

export const AuthProvider: ParentComponent = (props) => {
  const [state, setState] = createSignal<AuthState>({ kind: "loading" });
  const refresh = async () => {
    setState(await probe());
  };
  onUnauthorized(() => {
    if (untrack(state).kind === "signed-in") {
      setState({ kind: "signed-out", setupRequired: false, expired: true });
    }
  });
  onCleanup(() => onUnauthorized(undefined));
  onMount(() => void refresh());
  const auth: Auth = {
    state,
    refresh,
    async signOut() {
      await unwrap(api.POST("/api/v1/auth/logout")).catch(() => undefined);
      setState({ kind: "signed-out", setupRequired: false, expired: false });
    },
    stopped() {
      setState({ kind: "unreachable", message: "The daemon is shutting down." });
    },
  };
  return <AuthContext.Provider value={auth}>{props.children}</AuthContext.Provider>;
};

export function useAuth(): Auth {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("useAuth outside AuthProvider");
  return auth;
}

/** Where to go after signing in: a path of this app, never another origin. */
export function safeNext(next: string | undefined): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) {
    return "/torrents";
  }
  return next;
}
