// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// Sign-in, as the design has it (AGENTS.md 6.4): user name and password,
// no "stay signed in" (the session length is the daemon's
// `api_session_timeout`), and the real way to reset a password.

import { A, useNavigate, useSearchParams } from "@solidjs/router";
import { createEffect, createSignal, Show } from "solid-js";

import { api, ApiError, unwrap } from "~/api/client";
import { Button } from "~/components/ui/button";
import { TextField, TextFieldInput, TextFieldLabel } from "~/components/ui/text-field";

import { safeNext, useAuth } from "./auth";
import { AuthScreen, FormError } from "./auth-screen";

function explain(e: unknown): string {
  if (!(e instanceof ApiError)) return "Something went wrong. Try again.";
  switch (e.code) {
    case "unauthorized":
      return "Wrong user name or password.";
    case "banned":
      return "Too many failed sign-ins from this address. Try again later.";
    case "network":
      return "The daemon cannot be reached.";
    default:
      return e.message;
  }
}

export default function SignIn() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [params] = useSearchParams<{ next?: string }>();
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);

  createEffect(() => {
    if (auth.state().kind === "signed-in") navigate(safeNext(params.next), { replace: true });
  });

  const expired = () => {
    const s = auth.state();
    return s.kind === "signed-out" && s.expired;
  };
  const setupOpen = () => {
    const s = auth.state();
    return s.kind === "signed-out" && s.setupRequired;
  };

  const submit = async () => {
    if (busy()) return;
    if (!username().trim() || !password()) {
      setError("Enter your user name and password.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/api/v1/auth/login", {
          body: { username: username().trim(), password: password() },
        }),
      );
      await auth.refresh();
    } catch (e) {
      setError(explain(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreen title="Sign in to urtorrent" onSubmit={() => void submit()}>
      <Show when={expired()}>
        <p class="m-0 -mt-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
          Your session ended. Sign in again.
        </p>
      </Show>
      <Show when={setupOpen()}>
        <p class="m-0 -mt-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
          No account exists yet.{" "}
          <A href="/setup" class="font-medium text-foreground underline underline-offset-4">
            Create one
          </A>
          , or sign in with the temporary password the daemon printed at start.
        </p>
      </Show>
      <div class="flex flex-col gap-4">
        <TextField value={username()} onChange={setUsername}>
          <TextFieldLabel>Username</TextFieldLabel>
          <TextFieldInput size="lg" autocomplete="username" autofocus spellcheck={false} />
        </TextField>
        <TextField value={password()} onChange={setPassword}>
          <div class="flex items-center justify-between">
            <TextFieldLabel>Password</TextFieldLabel>
            <span class="text-sm text-subtle">
              Reset with <span class="mono">urtorrentd passwd</span>
            </span>
          </div>
          <TextFieldInput size="lg" type="password" autocomplete="current-password" class="mono" />
        </TextField>
      </div>
      <FormError message={error()} />
      <div class="flex flex-col gap-3">
        <Button type="submit" size="lg" class="w-full" disabled={busy()}>
          {busy() ? "Signing in…" : "Sign in"}
        </Button>
        <p class="m-0 text-center text-sm text-subtle">
          Scripts and other clients can use an <span class="text-muted-foreground">API key</span>{" "}
          instead (Settings → Security).
        </p>
      </div>
    </AuthScreen>
  );
}
