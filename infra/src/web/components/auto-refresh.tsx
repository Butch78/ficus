"use client";

/**
 * Re-renders the page every few seconds while something on it is still in
 * flight (an agent growing, checks running), and says so.
 */
import { Loader, Text } from "@cloudflare/kumo";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

const EVERY_MS = 4000;

export function AutoRefresh({ active, what }: { readonly active: boolean; readonly what: string }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) {
      return;
    }

    const timer = setInterval(() => router.refresh(), EVERY_MS);

    return () => clearInterval(timer);
  }, [active, router]);

  return active ? (
    <span className="inline-flex items-center gap-2">
      <Loader size={12} />
      <Text variant="secondary" as="span" size="xs">
        Live: {what}
      </Text>
    </span>
  ) : null;
}
