import { Badge, Banner, Code, Empty, Input, LayerCard, Link, Text } from "@cloudflare/kumo";
import * as Result from "effect/Result";
import { notFound } from "next/navigation";
import { AgentWork } from "../../../../../../../components/agent-work.tsx";
import { AutoRefresh } from "../../../../../../../components/auto-refresh.tsx";
import { GrowYourself } from "../../../../../../../components/grow-yourself.tsx";
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
import type { AgentStatus, BudRace } from "../../../../../../../lib/answers.ts";
import * as Api from "../../../../../../../lib/api.ts";
import { attempt, load } from "../../../../../../../lib/run.ts";
import { harvestCase, say } from "../../../../../../../lib/standing.ts";
import { pruneReason } from "../../../../../../../lib/view.ts";
import { growWithAgents, harvestBud, regrowLeaf } from "../../../../../../actions.ts";

export const dynamic = "force-dynamic";

interface Props {
  readonly params: Promise<{ org: string; tree: string; bud: string }>;
  readonly searchParams: Promise<{ op?: string; trace?: string; error?: string }>;
}

type Entry = BudRace["leaves"][number];

interface CardProps {
  readonly entry: Entry;
  readonly org: string;
  readonly tree: string;
  /** For a leaf an agent grows while it grows: what the agent is doing. */
  readonly agent: AgentStatus | undefined;
}

function LeafCard({ entry, org, tree, agent }: CardProps) {
  const { leaf, standing, report, scoring } = entry;
  const href = `/orgs/${org}/trees/${tree}/leaves/${leaf.id}`;
  const failing = report?.checks.filter((check) => !check.passed) ?? [];

  return (
    <LayerCard>
      <LayerCardSecondary className="flex flex-wrap items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <Link href={href}>leaf {leaf.id}</Link>
          <Text variant="secondary" as="span" size="sm">
            {leaf.agent}
          </Text>
          {entry.agent === undefined || entry.agent === null ? null : <Badge variant="purple">agent</Badge>}
        </span>
        <StandingBadge standing={standing} />
      </LayerCardSecondary>
      <LayerCardPrimary className="flex flex-col gap-2">
        <Text size="sm">{say(standing).sentence}</Text>
        {agent === undefined ? null : <AgentWork status={agent} compact />}
        {standing === "Ripening" && scoring !== undefined && scoring !== null ? <ScoringSteps ledger={scoring} compact /> : null}
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
          {standing === "Stale" ? (
            <form action={regrowLeaf}>
              <input type="hidden" name="org" value={org} />
              <input type="hidden" name="tree" value={tree} />
              <input type="hidden" name="leaf" value={leaf.id} />
              <SubmitButton pending="Regrowing…">Regrow on the head</SubmitButton>
            </form>
          ) : null}
        </span>
      </LayerCardPrimary>
    </LayerCard>
  );
}

export default async function BudPage({ params, searchParams }: Props) {
  const [{ org, tree, bud: raw }, { op, trace, error }] = await Promise.all([params, searchParams]);
  const bud = Number(raw);

  if (!Number.isInteger(bud) || bud < 0) {
    notFound();
  }

  const race = await load(Api.showBud(org, tree, bud));
  const base = `/orgs/${org}/trees/${tree}`;
  const harvest = harvestCase(race);
  const open = race.bud.state === "Open";
  const inFlight = race.leaves.some(({ standing }) => standing === "Growing" || standing === "Ripening");

  // What each agent still growing its leaf is doing now.
  const agents = new Map(
    await Promise.all(
      race.leaves
        .filter((entry) => entry.standing === "Growing" && entry.agent !== undefined && entry.agent !== null)
        .map(async (entry) => {
          const status = await attempt(Api.agentStatus(org, tree, entry.leaf.id));

          return [entry.leaf.id, Result.isSuccess(status) ? status.success : undefined] as const;
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
        title={`bud ${bud}`}
      >
        <AutoRefresh active={inFlight} what="leaves are growing or being checked" />
      </PageHeader>
      <Text variant="heading" as="h3">
        {race.bud.intent}
      </Text>
      <OperationOutcome org={org} op={op} trace={trace} error={error} />

      {race.bud.state === "Open" ? null : (
        <Banner
          title="Harvested"
          description={`Leaf ${race.bud.state.Fruited.leaf} became node ${race.bud.state.Fruited.node}, the head of the trunk.`}
          action={<Link href={`${base}/nodes/${race.bud.state.Fruited.node}#change`}>See what changed</Link>}
        />
      )}
      {harvest === undefined ? null : (
        <LayerCard>
          <LayerCardSecondary>Ready to harvest</LayerCardSecondary>
          <LayerCardPrimary className="flex flex-wrap items-center justify-between gap-3">
            <Text size="sm">{harvest.sentence}</Text>
            <form action={harvestBud}>
              <input type="hidden" name="org" value={org} />
              <input type="hidden" name="tree" value={tree} />
              <input type="hidden" name="bud" value={bud} />
              <SubmitButton pending="Harvesting…">Harvest leaf {harvest.leaf.id}</SubmitButton>
            </form>
          </LayerCardPrimary>
        </LayerCard>
      )}
      {open && harvest === undefined && race.leaves.length > 0 ? (
        <Text variant="secondary" size="sm">
          Nothing to harvest yet: a leaf must grow from the current head and pass every check.
        </Text>
      ) : null}

      <Text variant="heading" as="h3">
        Leaves
      </Text>
      {race.leaves.length === 0 ? (
        <Empty
          title="No leaves yet"
          description="A leaf is one attempt at this bud. Agents start one through the Api with an API key:"
          commandLine={`curl -X POST $FICUS_API/v1/orgs/${org}/trees/${tree}/buds/${bud}/leaves -H "x-api-key: $KEY" -d '{"agent":"my-agent"}'`}
        />
      ) : null}
      <div className="grid gap-3 md:grid-cols-2">
        {race.leaves.map((entry) => (
          <LeafCard key={entry.leaf.id} entry={entry} org={org} tree={tree} agent={agents.get(entry.leaf.id)} />
        ))}
      </div>
      {open ? (
        <LayerCard>
          <LayerCardSecondary>Grow with agents</LayerCardSecondary>
          <LayerCardPrimary className="flex flex-col gap-2">
            <Text variant="secondary" size="sm">
              Each agent gets its own copy of the repo and a sandbox to work in, runs the checks itself, and submits
              when they pass. The smallest change that passes every check wins.
            </Text>
            <form action={growWithAgents} className="flex flex-wrap items-end gap-2">
              <input type="hidden" name="org" value={org} />
              <input type="hidden" name="tree" value={tree} />
              <input type="hidden" name="bud" value={bud} />
              <Input name="agents" type="number" label="Agents" defaultValue="3" min={1} max={5} className="w-24" />
              <Input name="model" label="Model (Workers AI)" defaultValue="@cf/moonshotai/kimi-k2.7-code" className="min-w-80" />
              <SubmitButton pending="Starting agents…">Grow</SubmitButton>
            </form>
          </LayerCardPrimary>
        </LayerCard>
      ) : null}
      {open ? (
        <LayerCard>
          <LayerCardSecondary>Grow one yourself</LayerCardSecondary>
          <LayerCardPrimary>
            <GrowYourself org={org} tree={tree} bud={bud} />
          </LayerCardPrimary>
        </LayerCard>
      ) : null}

      {race.compost.length === 0 ? null : (
        <>
          <Text variant="heading" as="h3">
            Compost
          </Text>
          <Text variant="secondary" size="sm">
            Attempts that lost, and why: the next attempt at this bud starts from them.
          </Text>
          <ul className="flex flex-col gap-1">
            {race.compost.map((entry) => (
              <li key={entry.leaf}>
                <Text size="sm">
                  <Link href={`${base}/leaves/${entry.leaf}`}>leaf {entry.leaf}</Link> ({entry.agent}): {pruneReason(entry.reason)}
                  {entry.score === null ? "" : `, scored ${entry.score.checks_passed}/${entry.score.checks_total} at ${entry.score.cost} lines`}
                </Text>
              </li>
            ))}
          </ul>
        </>
      )}
      <Code lang="bash" code={`# the same race, for agents and scripts\ncurl $FICUS_API/v1/orgs/${org}/trees/${tree}/buds/${bud} -H "x-api-key: $KEY"`} />
    </>
  );
}
