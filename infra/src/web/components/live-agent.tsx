"use client";

/**
 * An attempt's live parts on its page: the agent at work (its tool calls) and
 * its scoring steps, each asked for again every few seconds while it moves
 * (lib/use-live.ts). When either settles, the page refreshes once, so the
 * timeline, the standing and the actions catch up.
 */
import { LayerCard } from "@cloudflare/kumo";
import { AgentStatus, AttemptDetail } from "../lib/answers.ts";
import { agentMoving, attemptMoving } from "../lib/live.ts";
import { useLive } from "../lib/use-live.ts";
import { AgentWork } from "./agent-work.tsx";
import { LayerCardPrimary, LayerCardSecondary } from "./kumo.ts";
import { ScoringSteps } from "./scoring-steps.tsx";

interface Props<A> {
  readonly org: string;
  readonly tree: string;
  readonly attempt: number;
  /** As the page was drawn. */
  readonly initial: A;
}

export function LiveAgent({ org, tree, attempt, initial }: Props<AgentStatus>) {
  const status = useLive({ kind: "agent", org, tree, id: attempt }, AgentStatus, initial, agentMoving);

  return (
    <LayerCard>
      <LayerCardSecondary>The agent at work</LayerCardSecondary>
      <LayerCardPrimary>
        <AgentWork status={status} />
      </LayerCardPrimary>
    </LayerCard>
  );
}

export function LiveScoring({ org, tree, attempt, initial }: Props<typeof AttemptDetail.Type>) {
  const detail = useLive({ kind: "attempt", org, tree, id: attempt }, AttemptDetail, initial, attemptMoving);
  const ledger = detail.scoring;

  if (ledger === undefined || ledger === null || ledger.entries.length === 0) {
    return null;
  }

  return (
    <LayerCard>
      <LayerCardSecondary>Scoring, in its sandbox</LayerCardSecondary>
      <LayerCardPrimary>
        <ScoringSteps ledger={ledger} />
      </LayerCardPrimary>
    </LayerCard>
  );
}
