// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

// First-run setup (ADR 0007): while no credentials exist, the first client
// chooses them and is signed in. Built in the sign-in design's language
// (AGENTS.md 6.4): the mockups have no setup screen.

import { A, useNavigate } from "@solidjs/router";
import { createEffect, createSignal, Show } from "solid-js";

import { api, ApiError, unwrap } from "~/api/client";
import { Button } from "~/components/ui/button";
import {
  TextField,
  TextFieldDescription,
  TextFieldInput,
  TextFieldLabel,
} from "~/components/ui/text-field";

import { useAuth } from "./auth";
import { AuthScreen, FormError } from "./auth-screen";

export default function Setup() {
  const auth = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = createSignal("admin");
  const [password, setPassword] = createSignal("");
  const [confirm, setConfirm] = createSignal("");
  const [error, setError] = createSignal<string | null>(null);
  const [taken, setTaken] = createSignal(false);
  const [busy, setBusy] = createSignal(false);

  createEffect(() => {
    const s = auth.state();
    if (s.kind === "signed-in") navigate("/torrents", { replace: true });
    else if (s.kind === "signed-out" && !s.setupRequired && !taken()) {
      navigate("/sign-in", { replace: true });
    }
  });

  const validate = (): string | null => {
    const name = username().trim();
    if (!name || name.length > 128) return "Choose a user name of 1 to 128 characters.";
    if (password().length < 8) return "The password needs at least 8 characters.";
    if (password().length > 1024) return "The password can have at most 1024 characters.";
    if (password() !== confirm()) return "The passwords do not match.";
    return null;
  };

  const submit = async () => {
    if (busy()) return;
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await unwrap(
        api.POST("/api/v1/auth/setup", {
          body: { username: username().trim(), password: password() },
        }),
      );
      await auth.refresh();
    } catch (e) {
      if (e instanceof ApiError && e.code === "conflict") {
        setTaken(true);
        setError(null);
      } else {
        setError(e instanceof ApiError ? e.message : "Something went wrong. Try again.");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthScreen title="Set up urtorrent" onSubmit={() => void submit()}>
      <Show
        when={!taken()}
        fallback={
          <p role="alert" class="m-0 text-base text-muted-foreground">
            Someone else set up this daemon first.{" "}
            <A href="/sign-in" class="font-medium text-foreground underline underline-offset-4">
              Sign in
            </A>{" "}
            with the credentials they chose.
          </p>
        }
      >
        <p class="m-0 -mt-2 text-base text-muted-foreground">
          No account exists yet. Choose the user name and password for this daemon: whoever finishes
          this form first owns it.
        </p>
        <div class="flex flex-col gap-4">
          <TextField value={username()} onChange={setUsername}>
            <TextFieldLabel>Username</TextFieldLabel>
            <TextFieldInput size="lg" autocomplete="username" spellcheck={false} />
          </TextField>
          <TextField value={password()} onChange={setPassword}>
            <TextFieldLabel>Password</TextFieldLabel>
            <TextFieldInput
              size="lg"
              type="password"
              autocomplete="new-password"
              class="mono"
              autofocus
            />
            <TextFieldDescription>At least 8 characters.</TextFieldDescription>
          </TextField>
          <TextField value={confirm()} onChange={setConfirm}>
            <TextFieldLabel>Confirm password</TextFieldLabel>
            <TextFieldInput size="lg" type="password" autocomplete="new-password" class="mono" />
          </TextField>
        </div>
        <FormError message={error()} />
        <div class="flex flex-col gap-3">
          <Button type="submit" size="lg" class="w-full" disabled={busy()}>
            {busy() ? "Creating the account…" : "Create account"}
          </Button>
          <p class="m-0 text-center text-sm text-subtle">
            Or{" "}
            <A href="/sign-in" class="text-muted-foreground underline underline-offset-4">
              sign in
            </A>{" "}
            with the temporary password the daemon printed at start.
          </p>
        </div>
      </Show>
    </AuthScreen>
  );
}
