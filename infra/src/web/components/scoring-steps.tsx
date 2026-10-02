"use client";

/**
 * A leaf's scoring as its sandbox reports it: every step, or (compact) just
 * the one running now. The page refreshes the ledger; this keeps the running
 * step's clock moving in between.
 */
import { Loader, Text } from "@cloudflare/kumo";
import { useEffect, useState } from "react";
import type { Ledger } from "../lib/answers.ts";
import { current, elapsed, scoringLabel, scoringStatus } from "../lib/scoring.ts";
import { ChainOfThought, ChainOfThoughtStep } from "./elements/chain-of-thought.tsx";

const useNow = (running: boolean) => {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (!running) {
      return;
    }

    const timer = setInterval(() => setNow(Date.now()), 500);

    return () => clearInterval(timer);
  }, [running]);

  return now;
};

export function ScoringSteps({ ledger, compact = false }: { readonly ledger: Ledger; readonly compact?: boolean }) {
  const running = ledger.entries.some((entry) => entry.state === "active");
  const now = useNow(running);

  if (compact) {
    const step = current(ledger);

    return step === undefined ? null : (
      <span className="inline-flex items-center gap-2">
        {step.state === "active" ? <Loader size={12} /> : null}
        <Text variant="secondary" as="span" size="xs">
          {scoringLabel(step)} · {elapsed(step, now)}
        </Text>
      </span>
    );
  }

  return (
    <ChainOfThought>
      {ledger.entries.map((entry) => (
        <ChainOfThoughtStep
          key={`${entry.step}-${entry.item ?? ""}`}
          status={scoringStatus(entry)}
          label={scoringLabel(entry)}
          description={entry.state === "error" ? entry.detail : undefined}
          aside={elapsed(entry, now)}
        />
      ))}
    </ChainOfThought>
  );
}
