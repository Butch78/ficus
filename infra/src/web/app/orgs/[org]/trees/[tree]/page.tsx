import { Badge, Banner, Empty, Input, LayerCard, Link, Text } from "@cloudflare/kumo";
import { ActivityPanel } from "../../../../../components/activity-panel.tsx";
import { AutoRefresh } from "../../../../../components/auto-refresh.tsx";
import { Glossary } from "../../../../../components/glossary.tsx";
import { LayerCardPrimary, LayerCardSecondary } from "../../../../../components/kumo.ts";
import { OperationOutcome } from "../../../../../components/operation-outcome.tsx";
import { PageHeader } from "../../../../../components/page-header.tsx";
import { TONE_BADGE } from "../../../../../components/standing-badge.tsx";
import { SubmitButton } from "../../../../../components/submit-button.tsx";
import * as Api from "../../../../../lib/api.ts";
import { load } from "../../../../../lib/run.ts";
import { glance } from "../../../../../lib/standing.ts";
import { short } from "../../../../../lib/view.ts";
import { createTask } from "../../../../actions.ts";

export const dynamic = "force-dynamic";

interface Props {
  readonly params: Promise<{ org: string; tree: string }>;
  /** `initialized` + `trace`: an init just landed; `op`/`trace`/`error`: another change did. */
  readonly searchParams: Promise<{ initialized?: string; trace?: string; op?: string; error?: string }>;
}

const GLANCE_WORDS = {
  winner: "ready to accept",
  passing: "passing",
  checking: "checks running",
  working: "working",
  failing: "failing",
  behind: "behind",
  accepted: "accepted",
  closed: "closed",
} as const;

export default async function TreePage({ params, searchParams }: Props) {
  const [{ org, tree: name }, { initialized, trace, op, error }] = await Promise.all([params, searchParams]);
  const tree = await load(Api.showTree(org, name));
  const base = `/orgs/${org}/trees/${name}`;
  const tasks = Object.values(tree.tasks).toSorted((a, b) => b.id - a.id);
  const open = tasks.filter((task) => task.state === "Open");
  const races = await Promise.all(open.map((task) => load(Api.showTask(org, name, task.id))));
  const accepted = tasks.flatMap((task) => (task.state === "Open" ? [] : [{ task, ...task.state.Done }]));
  const head = tree.nodes[String(tree.head)];
  const headAttempt = head?.accepted_from === null || head === undefined ? undefined : tree.attempts[String(head.accepted_from)];
  const inFlight = races.some((race) => race.attempts.some(({ standing }) => standing === "Working" || standing === "Checking"));

  return (
    <>
      <PageHeader trail={[["Organizations", "/"], [org, `/orgs/${org}`]]} title={name}>
        <AutoRefresh active={inFlight} what="attempts are working or being checked" />
      </PageHeader>
      {initialized === undefined ? null : (
        <>
          <Banner title={`Initialized ${name}`} description={`Its root is the default branch of ${initialized}, at node 0.`} />
          {trace === undefined ? null : <ActivityPanel org={org} operation={trace} title={`Init ${name}`} refused={false} />}
        </>
      )}
      {initialized === undefined ? <OperationOutcome org={org} op={op} trace={trace} error={error} /> : null}
      <Glossary />

      <LayerCard>
        <LayerCardSecondary>The code now</LayerCardSecondary>
        <LayerCardPrimary className="flex flex-wrap items-center justify-between gap-3">
          {head === undefined ? null : (
            <>
              <span className="flex flex-col gap-1">
                <Text size="sm">
                  Node {head.id} at <Text variant="mono">{short(head.commit)}</Text>
                </Text>
                <Text variant="secondary" size="xs">
                  {headAttempt === undefined
                    ? "The root, as initialized."
                    : `Accepted from attempt ${headAttempt.id} (${headAttempt.agent}): "${tree.tasks[String(headAttempt.task)]?.intent ?? ""}".`}
                </Text>
              </span>
              <span className="flex gap-3">
                <Link href={`${base}/nodes/${head.id}`}>Browse the files</Link>
                {head.parent === null ? null : <Link href={`${base}/nodes/${head.id}#change`}>What changed</Link>}
              </span>
            </>
          )}
        </LayerCardPrimary>
      </LayerCard>

      <LayerCard>
        <LayerCardSecondary>Open tasks: work in progress</LayerCardSecondary>
        <LayerCardPrimary className="flex flex-col gap-3">
          {open.length === 0 ? (
            <Text variant="secondary" size="sm">
              Nothing open. Say what you want changed, and agents work attempts at it.
            </Text>
          ) : null}
          {races.map((race) => (
            <div key={race.task.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline pb-2">
              <Link href={`${base}/tasks/${race.task.id}`}>{race.task.intent}</Link>
              <span className="flex flex-wrap gap-1">
                {race.attempts.length === 0 ? <Badge variant="outline">no attempts yet</Badge> : null}
                {glance(race).map(({ tone, count }) => (
                  <Badge key={tone} variant={TONE_BADGE[tone]} appearance="dot">
                    {count} {GLANCE_WORDS[tone]}
                  </Badge>
                ))}
              </span>
            </div>
          ))}
          <form action={createTask} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="org" value={org} />
            <input type="hidden" name="tree" value={name} />
            <Input name="intent" label="New task" placeholder="What should change? e.g. slugify should drop punctuation" className="min-w-96" required />
            <SubmitButton pending="Creating…">Create task</SubmitButton>
          </form>
        </LayerCardPrimary>
      </LayerCard>

      <LayerCard>
        <LayerCardSecondary>Accepted: the trunk's history</LayerCardSecondary>
        <LayerCardPrimary className="flex flex-col gap-2">
          {accepted.length === 0 ? <Empty size="sm" title="Nothing accepted yet" /> : null}
          {accepted.map(({ task, attempt, node }) => (
            <div key={task.id} className="flex flex-wrap items-center justify-between gap-2">
              <Link href={`${base}/tasks/${task.id}`}>{task.intent}</Link>
              <Text variant="secondary" as="span" size="sm">
                attempt {attempt} ({tree.attempts[String(attempt)]?.agent ?? "?"}) → <Link href={`${base}/nodes/${node}`}>node {node}</Link>
              </Text>
            </div>
          ))}
          <Text variant="secondary" size="xs">
            The root is <Link href={`${base}/nodes/0`}>node 0</Link>. {tree.history.length} earlier attempts are in the history, on their tasks' pages.
          </Text>
        </LayerCardPrimary>
      </LayerCard>
    </>
  );
}
