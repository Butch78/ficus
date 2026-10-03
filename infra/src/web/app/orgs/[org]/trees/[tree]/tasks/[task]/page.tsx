import { Badge, Banner, Code, Empty, Input, LayerCard, Link, Text } from "@cloudflare/kumo";
import * as Result from "effect/Result";
import { notFound } from "next/navigation";
import { AgentWork } from "../../../../../../../components/agent-work.tsx";
import { AutoRefresh } from "../../../../../../../components/auto-refresh.tsx";
import { WorkYourself } from "../../../../../../../components/work-yourself.tsx";
import {
  CollapsiblePanel,
  CollapsibleRoot,
  CollapsibleTrigger,
  LayerCardPrimary,
  LayerCardSecondary,
} from "../../../../../../../components/kumo.ts";
import { OperationOutcome } from "../../../../../../../components/operation-outcome.tsx";
import { PageHeader } from "../../../../../../../components/page-header.tsx";
import { ScoringSteps } from "../../../../../../../components/scoring-steps.tsx";
import { StandingBadge } from "../../../../../../../components/standing-badge.tsx";
import { SubmitButton } from "../../../../../../../components/submit-button.tsx";
import type { AgentStatus, TaskRace } from "../../../../../../../lib/answers.ts";
import * as Api from "../../../../../../../lib/api.ts";
import { load, run } from "../../../../../../../lib/run.ts";
import { acceptCase, say } from "../../../../../../../lib/standing.ts";
import { closeReason } from "../../../../../../../lib/view.ts";
import { startAgents, acceptTask, retryAttempt } from "../../../../../../actions.ts";

export const dynamic = "force-dynamic";

interface Props {
  readonly params: Promise<{ org: string; tree: string; task: string }>;
  readonly searchParams: Promise<{ op?: string; trace?: string; error?: string }>;
}

type Entry = TaskRace["attempts"][number];

interface CardProps {
  readonly entry: Entry;
  readonly org: string;
  readonly tree: string;
  /** For an attempt an agent works, while it works: what the agent is doing. */
  readonly agent: AgentStatus | undefined;
}

function AttemptCard({ entry, org, tree, agent }: CardProps) {
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

export default async function TaskPage({ params, searchParams }: Props) {
  const [{ org, tree, task: raw }, { op, trace, error }] = await Promise.all([params, searchParams]);
  const task = Number(raw);

  if (!Number.isInteger(task) || task < 0) {
    notFound();
  }

  const race = await load(Api.showTask(org, tree, task));
  const base = `/orgs/${org}/trees/${tree}`;
  const accept = acceptCase(race);
  const open = race.task.state === "Open";
  const inFlight = race.attempts.some(({ standing }) => standing === "Working" || standing === "Checking");

  // What each agent still working its attempt is doing now.
  const agents = new Map(
    await Promise.all(
      race.attempts
        .filter((entry) => entry.standing === "Working" && entry.agent !== undefined && entry.agent !== null)
        .map(async (entry) => {
          const status = await run(Api.agentStatus(org, tree, entry.attempt.id));

          return [entry.attempt.id, Result.isSuccess(status) ? status.success : undefined] as const;
        }),
    ),
  );

  return (
    <>
      <PageHeader
        trail={[
          ["Organizations", "/"],
          [org, `/orgs/${org}`],
          [tree, base],
        ]}
        title={`task ${task}`}
      >
        <AutoRefresh active={inFlight} what="attempts are working or being checked" />
      </PageHeader>
      <Text variant="heading" as="h3">
        {race.task.intent}
      </Text>
      <OperationOutcome org={org} op={op} trace={trace} error={error} />

      {race.task.state === "Open" ? null : (
        <Banner
          title="Accepted"
          description={`Attempt ${race.task.state.Done.attempt} became node ${race.task.state.Done.node}, the head of the trunk.`}
          action={<Link href={`${base}/nodes/${race.task.state.Done.node}#change`}>See what changed</Link>}
        />
      )}
      {accept === undefined ? null : (
        <LayerCard>
          <LayerCardSecondary>Ready to accept</LayerCardSecondary>
          <LayerCardPrimary className="flex flex-wrap items-center justify-between gap-3">
            <Text size="sm">{accept.sentence}</Text>
            <form action={acceptTask}>
              <input type="hidden" name="org" value={org} />
              <input type="hidden" name="tree" value={tree} />
              <input type="hidden" name="task" value={task} />
              <SubmitButton pending="Harvesting…">Accept attempt {accept.attempt.id}</SubmitButton>
            </form>
          </LayerCardPrimary>
        </LayerCard>
      )}
      {open && accept === undefined && race.attempts.length > 0 ? (
        <Text variant="secondary" size="sm">
          Nothing to accept yet: an attempt must start from the current head and pass every check.
        </Text>
      ) : null}

      <Text variant="heading" as="h3">
        Attempts
      </Text>
      {race.attempts.length === 0 ? (
        <Empty
          title="No attempts yet"
          description="An attempt is one attempt at this task. Agents start one through the Api with an API key:"
          commandLine={`curl -X POST $FICUS_API/v1/orgs/${org}/trees/${tree}/tasks/${task}/attempts -H "x-api-key: $KEY" -d '{"agent":"my-agent"}'`}
        />
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        {race.attempts.map((entry) => (
          <AttemptCard key={entry.attempt.id} entry={entry} org={org} tree={tree} agent={agents.get(entry.attempt.id)} />
        ))}
      </div>
      {open ? (
        <LayerCard>
          <LayerCardSecondary>Start agents</LayerCardSecondary>
          <LayerCardPrimary className="flex flex-col gap-2">
            <Text variant="secondary" size="sm">
              Each agent gets its own copy of the repo and a sandbox to work in, runs the checks itself, and submits
              when they pass. The smallest change that passes every check wins.
            </Text>
            <form action={startAgents} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="org" value={org} />
              <input type="hidden" name="tree" value={tree} />
              <input type="hidden" name="task" value={task} />
              <Input name="agents" type="number" label="Agents" defaultValue="3" min={1} max={5} className="w-24" />
              <Input name="model" label="Model (Workers AI)" defaultValue="@cf/moonshotai/kimi-k2.7-code" className="min-w-80" />
              <SubmitButton pending="Starting agents…">Start</SubmitButton>
            </form>
          </LayerCardPrimary>
        </LayerCard>
      ) : null}
      {open ? (
        <LayerCard>
          <LayerCardSecondary>Work one yourself</LayerCardSecondary>
          <LayerCardPrimary>
            <WorkYourself org={org} tree={tree} task={task} />
          </LayerCardPrimary>
        </LayerCard>
      ) : null}

      {race.history.length === 0 ? null : (
        <>
          <Text variant="heading" as="h3">
            HistoryEntry
          </Text>
          <Text variant="secondary" size="sm">
            Attempts that lost, and why: the next attempt at this task starts from them.
          </Text>
          <ul className="flex flex-col gap-1">
            {race.history.map((entry) => (
              <li key={entry.attempt}>
                <Text size="sm">
                  <Link href={`${base}/attempts/${entry.attempt}`}>attempt {entry.attempt}</Link> ({entry.agent}): {closeReason(entry.reason)}
                  {entry.score === null ? "" : `, scored ${entry.score.checks_passed}/${entry.score.checks_total} at ${entry.score.cost} lines`}
                </Text>
              </li>
            ))}
          </ul>
        </>
      )}
      <Code lang="bash" code={`# the same race, for agents and scripts\ncurl $FICUS_API/v1/orgs/${org}/trees/${tree}/tasks/${task} -H "x-api-key: $KEY"`} />
    </>
  );
}
