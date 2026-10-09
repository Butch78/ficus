import { Banner, Code, Empty, Input, LayerCard, Link, Text } from "@cloudflare/kumo";
import { notFound } from "next/navigation";
import { WorkYourself } from "../../../../../../../components/work-yourself.tsx";
import { LayerCardPrimary, LayerCardSecondary } from "../../../../../../../components/kumo.ts";
import { LiveAttempts } from "../../../../../../../components/live-attempts.tsx";
import { OperationOutcome } from "../../../../../../../components/operation-outcome.tsx";
import { PageHeader } from "../../../../../../../components/page-header.tsx";
import { SubmitButton } from "../../../../../../../components/submit-button.tsx";
import { TaskPrompt } from "../../../../../../../components/task-prompt.tsx";
import { agentStatuses } from "../../../../../../../lib/agents.ts";
import * as Api from "../../../../../../../lib/api.ts";
import { agentAttempts } from "../../../../../../../lib/growing.ts";
import { toLive } from "../../../../../../../lib/live.ts";
import { load } from "../../../../../../../lib/run.ts";
import { acceptCase } from "../../../../../../../lib/standing.ts";
import { closeReason } from "../../../../../../../lib/view.ts";
import { startAgents, acceptTask } from "../../../../../../actions.ts";

export const dynamic = "force-dynamic";

interface Props {
  readonly params: Promise<{ org: string; tree: string; task: string }>;
  readonly searchParams: Promise<{ op?: string; trace?: string; error?: string }>;
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

  // What each agent still working its attempt is doing now.
  const agents = await agentStatuses(org, tree, agentAttempts([race]));

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
      </PageHeader>
      <TaskPrompt intent={race.task.intent} title={race.task.title} heading />
      <OperationOutcome org={org} op={op} trace={trace} error={error} />

      {race.task.state === "Open" || "Closed" in race.task.state ? null : (
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
              <SubmitButton pending="Accepting…">Accept attempt {accept.attempt.id}</SubmitButton>
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
      <LiveAttempts org={org} tree={tree} initial={toLive(race, agents)} />
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
