import { Badge, LayerCard, Link, Text } from "@cloudflare/kumo";
import { retryAttempt } from "../app/actions.ts";
import type { AgentStatus, TaskRace } from "../lib/answers.ts";
import { say } from "../lib/standing.ts";
import { AgentWork } from "./agent-work.tsx";
import { CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger, LayerCardPrimary, LayerCardSecondary } from "./kumo.ts";
import { ScoringSteps } from "./scoring-steps.tsx";
import { StandingBadge } from "./standing-badge.tsx";
import { SubmitButton } from "./submit-button.tsx";

type Entry = TaskRace["attempts"][number];

interface CardProps {
  readonly entry: Entry;
  readonly org: string;
  readonly tree: string;
  /** For an attempt an agent works, while it works: what the agent is doing. */
  readonly agent: AgentStatus | undefined;
}

/** One attempt in a task's race: where it stands, what its agent or its checks are doing, and its report. */
export function AttemptCard({ entry, org, tree, agent }: CardProps) {
  const { attempt, standing, report, scoring } = entry;
  const href = `/orgs/${org}/trees/${tree}/attempts/${attempt.id}`;
  const failing = report?.checks.filter((check) => !check.passed) ?? [];

  return (
    <LayerCard>
      <LayerCardSecondary className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Link href={href}>attempt {attempt.id}</Link>
          <Text variant="secondary" as="span" size="sm">
            {attempt.agent}
          </Text>
          {entry.agent === undefined || entry.agent === null ? null : <Badge variant="purple">agent</Badge>}
        </span>
        <StandingBadge standing={standing} />
      </LayerCardSecondary>
      <LayerCardPrimary className="flex flex-col gap-2">
        <Text size="sm">{say(standing).sentence}</Text>
        {agent === undefined ? null : <AgentWork status={agent} compact />}
        {standing === "Checking" && scoring !== undefined && scoring !== null ? <ScoringSteps ledger={scoring} compact /> : null}
        {report === null ? null : (
          <Text variant="secondary" size="xs">
            {report.checks.filter((check) => check.passed).length} of {report.checks.length} checks pass · a {report.cost}-line
            change
          </Text>
        )}
        {failing.map((check) => (
          <CollapsibleRoot key={check.name}>
            <CollapsibleTrigger>
              <span className="text-kumo-danger">Failed: {check.name}</span>
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <pre className="overflow-x-auto rounded-md border border-kumo-hairline bg-kumo-recessed p-3 font-mono text-xs text-kumo-default">
                {check.tail || "(no output)"}
              </pre>
            </CollapsiblePanel>
          </CollapsibleRoot>
        ))}
        <span className="flex flex-wrap items-center gap-3">
          <Link href={`${href}#change`}>Review the change</Link>
          {standing === "Behind" ? (
            <form action={retryAttempt}>
              <input type="hidden" name="org" value={org} />
              <input type="hidden" name="tree" value={tree} />
              <input type="hidden" name="attempt" value={attempt.id} />
              <SubmitButton pending="Retrying…">Retry on the head</SubmitButton>
            </form>
          ) : null}
        </span>
      </LayerCardPrimary>
    </LayerCard>
  );
}
