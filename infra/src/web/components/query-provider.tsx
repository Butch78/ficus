"use client";

/**
 * TanStack Query for the browser: one client per tab, shared by every live
 * part of a page (lib/use-live.ts), so a race the tree page and its panel both
 * show is asked for once.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

export function QueryProvider({ children }: { readonly children: ReactNode }) {
  const [client] = useState(
    () =>
      new QueryClient({
        // What the server rendered is fresh; moving parts set their own interval.
        defaultOptions: { queries: { staleTime: 2000, retry: 1, refetchOnWindowFocus: true } },
      }),
  );

  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
