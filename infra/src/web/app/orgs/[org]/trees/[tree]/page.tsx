import { Badge, LayerCard, Link, Text } from "@cloudflare/kumo";
import { Glossary } from "../../../../../components/glossary.tsx";
import { LayerCardPrimary, LayerCardSecondary } from "../../../../../components/kumo.ts";
import { Landed } from "../../../../../components/landed.tsx";
import { NewTask } from "../../../../../components/new-task.tsx";
import { ReleaseCard, treeDeploys } from "../../../../../components/release-card.tsx";
import { TONE_BADGE } from "../../../../../components/standing-badge.tsx";
import { TreeHero } from "../../../../../components/tree-hero.tsx";
import { TrunkView } from "../../../../../components/trunk-view.tsx";
import { liveRaces } from "../../../../../lib/agents.ts";
import * as Api from "../../../../../lib/api.ts";
import { toLive } from "../../../../../lib/live.ts";
import { load, signedIn } from "../../../../../lib/run.ts";
import { glance } from "../../../../../lib/standing.ts";
import { trunkStory } from "../../../../../lib/trunk.ts";
import { taskName, timeAgo } from "../../../../../lib/trunk-words.ts";
import type { Tree } from "../../../../../lib/answers.ts";
import { commitTimes } from "../../../../../lib/history.ts";

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

/** How long ago the head's commit landed, from the head's log. */
const headAgo = (tree: Tree, landed: ReadonlyMap<string, number>) => {
  const at = landed.get(tree.nodes[String(tree.head)]?.commit ?? "");

  return at === undefined ? undefined : timeAgo(at, Date.now());
};

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


  return (
    <>
      <TreeHero org={org} name={name} member={member} tree={tree} ago={headAgo(tree, landed)} deploys={deploys} />
      {member ? <Landed org={org} name={name} initialized={initialized} trace={trace} op={op} error={error} /> : null}
      <Glossary />


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
          <TrunkView org={org} tree={name} member={member} stories={trunkStory(tree, deploys ?? [])} shown={node} older={older} live={races.map((race) => toLive(race, agents))} task={watching} landed={landed} now={Date.now()} />
        </LayerCardPrimary>
      </LayerCard>
    </>
  );
}
