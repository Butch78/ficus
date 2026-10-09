import { Badge, LayerCard, Link, Text } from "@cloudflare/kumo";
import { AutoRefresh } from "../../../../../components/auto-refresh.tsx";
import { Glossary } from "../../../../../components/glossary.tsx";
import { LayerCardPrimary, LayerCardSecondary } from "../../../../../components/kumo.ts";
import { Landed } from "../../../../../components/landed.tsx";
import { NewTask } from "../../../../../components/new-task.tsx";
import { PageHeader } from "../../../../../components/page-header.tsx";
import { ReleaseCard, treeDeploys } from "../../../../../components/release-card.tsx";
import { TONE_BADGE } from "../../../../../components/standing-badge.tsx";
import { TrunkView } from "../../../../../components/trunk-view.tsx";
import { VisibilitySwitch } from "../../../../../components/visibility-switch.tsx";
import { liveRaces } from "../../../../../lib/agents.ts";
import * as Api from "../../../../../lib/api.ts";
import { growing } from "../../../../../lib/growing.ts";
import { deploying } from "../../../../../lib/release.ts";
import { load, signedIn } from "../../../../../lib/run.ts";
import { glance } from "../../../../../lib/standing.ts";
import { trunkStory } from "../../../../../lib/trunk.ts";
import { taskName } from "../../../../../lib/trunk-words.ts";
import { commitTimes } from "../../../../../lib/history.ts";
import { short } from "../../../../../lib/view.ts";

export const dynamic = "force-dynamic";

interface Props {
  readonly params: Promise<{ org: string; tree: string }>;
  /** `initialized` + `trace`: an init just landed; `op`/`trace`/`error`: another change did. */
  readonly searchParams: Promise<{ initialized?: string; trace?: string; op?: string; error?: string; node?: string; older?: string; task?: string }>;
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
  const [{ org, tree: name }, { initialized, trace, op, error, node, older, task: watching }] = await Promise.all([params, searchParams]);
  // Anyone may read a public tree; the rest of this page is for its members.
  const [member, tree] = await Promise.all([signedIn(), load(Api.showTree(org, name))]);
  const base = `/orgs/${org}/trees/${name}`;
  const tasks = Object.values(tree.tasks).toSorted((a, b) => b.id - a.id);
  const open = tasks.filter((task) => task.state === "Open");

  // Members see the open tasks' races, what their agents are doing (the trunk's growing cards) and the deploys, asked together.
  const [{ races, agents }, deploys, landed] = await Promise.all([
    member ? liveRaces(org, name, open) : { races: [], agents: new Map() },
    member ? treeDeploys(org, name) : undefined,
    commitTimes(org, name, tree.head),
  ]);

  const head = tree.nodes[String(tree.head)];
  const headAttempt = head?.accepted_from === null || head === undefined ? undefined : tree.attempts[String(head.accepted_from)];
  const inFlight = races.some((race) => race.attempts.some(({ standing }) => standing === "Working" || standing === "Checking"));

  return (
    <>
      <PageHeader trail={member ? [["Organizations", "/"], [org, `/orgs/${org}`]] : []} title={name}>
        {member ? (
          <VisibilitySwitch org={org} tree={name} isPublic={tree.public === true} />
        ) : (
          <Link href="/sign-in">Sign in to work on it</Link>
        )}
        <AutoRefresh
          active={inFlight || deploying(deploys)}
          what={inFlight ? "attempts are working or being checked" : "a release is deploying"}
        />
      </PageHeader>
      {member ? <Landed org={org} name={name} initialized={initialized} trace={trace} op={op} error={error} /> : null}
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
                    : `Accepted from attempt ${headAttempt.id} (${headAttempt.agent}): "${taskName(tree.tasks[String(headAttempt.task)] ?? { intent: "" })}"`}
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

      <ReleaseCard org={org} name={name} base={base} tree={tree} member={member} deploys={deploys} />

      <LayerCard>
        <LayerCardSecondary>Open tasks: work in progress</LayerCardSecondary>
        <LayerCardPrimary className="flex flex-col gap-3">
          {open.length === 0 ? (
            <Text variant="secondary" size="sm">
              Nothing open.
            </Text>
          ) : null}
          {member ? null : open.map((task) => <Text key={task.id} size="sm">{taskName(task)}</Text>)}
          {races.map((race) => (
            <div key={race.task.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-kumo-hairline pb-2">
              <Link href={`${base}/tasks/${race.task.id}`}>{taskName(race.task)}</Link>
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
          {member ? <NewTask org={org} tree={name} /> : null}
        </LayerCardPrimary>
      </LayerCard>

      <LayerCard>
        <LayerCardSecondary>History: how the trunk grew</LayerCardSecondary>
        <LayerCardPrimary>
          <TrunkView org={org} tree={name} member={member} stories={trunkStory(tree, deploys ?? [])} shown={node} older={older} growing={growing(races, agents)} task={watching} landed={landed} now={Date.now()} />
        </LayerCardPrimary>
      </LayerCard>
    </>
  );
}
