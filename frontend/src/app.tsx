// SPDX-License-Identifier: Apache-2.0
// Copyright (c) 2026 urtorrentd contributors

import { Router } from "@solidjs/router";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import type { ParentComponent } from "solid-js";

import { Toaster } from "~/components/ui/sonner";
import { AuthProvider } from "~/features/auth/auth";
import { routes } from "~/routes";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Live data comes from the event stream; queries refetch on purpose.
      refetchOnWindowFocus: false,
      retry: false,
      staleTime: 5_000,
    },
  },
});

const Root: ParentComponent = (props) => (
  <AuthProvider>
    {props.children}
    <Toaster position="bottom-right" />
  </AuthProvider>
);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Router root={Root}>{routes}</Router>
    </QueryClientProvider>
  );
}
