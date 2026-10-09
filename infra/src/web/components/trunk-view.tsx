import { Badge, Empty, Flow, Link, Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import type { Deploy } from "../lib/answers.ts";
import { deployStatus } from "../lib/release.ts";
import { growing } from "../lib/growing.ts";
import { agentsOf, type LiveRace } from "../lib/live.ts";
import type { NodeStory } from "../lib/trunk.ts";
import {
  changedPaths,
  detailsLabel,
  graftRunIntent,
  nodeIntent,
  nodeSummary,
  timeAgo,
  plural,
  trunkRows,
  type TrunkRow,
} from "../lib/trunk-words.ts";
import { short } from "../lib/view.ts";
import { DEPLOY_BADGE, DEPLOY_WORD, DeployList } from "./deploy-list.tsx";
import { LiveGrowing, LiveTaskPanel } from "./live-growing.tsx";
import { NodeFlow } from "./node-flow.tsx";
import { Card, FLIP } from "./trunk-card.tsx";
import { FullPrompt } from "./task-prompt.tsx";
import { CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "./kumo.ts";

/** How many nodes show before the older history folds away; the root always shows below the fold. */
const SHOWN = 10;

/** A details trigger that reads as a quiet action under the card's words, left-aligned when it wraps. */
const TRIGGER_CLASS = "text-left text-sm font-normal text-kumo-subtle";

interface Props {
  readonly org: string;
  readonly tree: string;
  /** Whether the reader is a member: only members may open task and attempt pages. */
  readonly member: boolean;
  /** The trunk, head first (lib/trunk.ts `trunkStory`). */
  readonly stories: ReadonlyArray<NodeStory>;
  /** The node whose story the panel shows, from the page's `?node=`; the head when absent or unknown. */
  readonly shown: string | undefined;
  /** Whether the older history is unfolded, from the page's `?older=1`. */
  readonly older: string | undefined;
  /** The open tasks' races and their agents as the page was drawn (lib/live.ts); the browser keeps them fresh. Empty for visitors. */
  readonly live: ReadonlyArray<LiveRace>;
  /** The growing task whose race the panel shows, from the page's `?task=`; it wins over `shown`. */
  readonly task: string | undefined;
  /** When each trunk commit landed, in seconds (from the head's log); a commit missing from it goes unsaid. */
  readonly landed: ReadonlyMap<string, number>;
  /** The time the page is drawn at, in milliseconds. */
  readonly now: number;
}

/**
 * The trunk's history as a Kumo Flow that grows upward like the tree: the root
 * at the bottom, each node a card built on the one below, the head on top.
 * Kumo's vertical Flow runs downward, and it places nodes from their measured
 * sizes, which a flip leaves alone: so the flow is laid out oldest first and
 * turned upside down, and every card is turned back. What happened at one node
 * (its own flow) sits in a panel beside it: Kumo's Flow does not nest, since
 * its nodes fade in through motion that a parent node's motion holds back.
 */
export function TrunkView({ org, tree, member, stories, shown, older, live, task, landed, now }: Props) {
  const [head] = stories;

  if (head === undefined) {
    return <Empty size="sm" title="Nothing accepted yet" />;
  }

  const base = `/orgs/${org}/trees/${tree}`;
  const unfolded = older === "1";
  const selected = stories.find((story) => String(story.node) === shown) ?? head;

  const watched = live.find((race) => String(race.race.task.id) === task && growing([race.race], agentsOf(race)).length > 0);
  const ago = new Map(stories.flatMap((story) => (landed.has(story.commit) ? [[story.node, timeAgo(landed.get(story.commit) ?? 0, now)] as const] : [])));

  const here = (pick: Pick, open: boolean) => {
    const query = new URLSearchParams({ [pick.kind]: String(pick.id) });

    if (open) {
      query.set("older", "1");
    }

    return `${base}?${query.toString()}#history`;
  };

  const kept: Pick = watched === undefined ? { kind: "node", id: selected.node } : { kind: "task", id: watched.race.task.id };
  const hrefs = Object.fromEntries(live.map((race) => [String(race.race.task.id), here({ kind: "task", id: race.race.task.id }, unfolded)]));

  const rows = trunkRows(stories);
  const folds = rows.length > SHOWN + 2;

  const card = (row: TrunkRow) => (
    <TrunkCard key={row[0].node} base={base} member={member} row={row} ago={ago} selected={watched === undefined ? selected.node : -1} open={here({ kind: "node", id: row[0].node }, unfolded)} />
  );

  const olderRows = folds && unfolded ? rows.slice(SHOWN, -1) : [];
  const root = folds ? rows.slice(-1) : [];
  const newest = folds ? rows.slice(0, SHOWN) : rows;

  return (
    <div id="history" className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
      <UpwardFlow>
        {root.map(card)}
        {olderRows.toReversed().map(card)}
        {folds ? <FoldCard rows={rows.slice(SHOWN, -1)} unfolded={unfolded} toggle={here(kept, !unfolded)} /> : null}
        {newest.toReversed().map(card)}
        <LiveGrowing org={org} tree={tree} member={member} initial={live} watched={watched?.race.task.id} hrefs={hrefs} />
      </UpwardFlow>
      {watched === undefined ? (
        <NodePanel base={base} member={member} story={selected} ago={ago.get(selected.node)} />
      ) : (
        <LiveTaskPanel org={org} tree={tree} member={member} initial={watched} />
      )}
    </div>
  );
}

/** What the panel shows: a node's story, or a growing task's race. */
interface Pick {
  readonly kind: "node" | "task";
  readonly id: number;
}

/** A vertical Flow turned upside down: its children come oldest first and show newest on top. */
function UpwardFlow({ children }: { readonly children: ReactNode }) {
  return (
    <div className={`${FLIP} @container`}>
      <Flow orientation="vertical" align="start" canvas={false}>
        {children}
      </Flow>
    </div>
  );
}

const newestFirst = (deploys: ReadonlyArray<Deploy>) => deploys.toSorted((one, other) => other.started_at - one.started_at);

interface RowProps {
  readonly base: string;
  readonly member: boolean;
  readonly row: TrunkRow;
  /** The node the panel shows. */
  readonly selected: number;
  /** How long ago each node landed, by node. */
  readonly ago: ReadonlyMap<number, string>;
  /** Where its "what happened" link goes. */
  readonly open: string;
}

/** A node's card, or one card for a run of grafts from one place with every deploy of the run. */
function TrunkCard({ base, member, row, selected, open, ago }: RowProps) {
  const [story] = row;

  return (
    <Card>
      {row.length === 1 ? (
        <NodeWords base={base} member={member} story={story} selected={selected === story.node} open={open} ago={ago.get(story.node)} />
      ) : (
        <GraftRunWords base={base} row={row} deploys={newestFirst(row.flatMap((each) => each.deploys))} />
      )}
    </Card>
  );
}

interface FoldProps {
  /** The older rows, head first. */
  readonly rows: ReadonlyArray<TrunkRow>;
  readonly unfolded: boolean;
  /** The page with the older history the other way. */
  readonly toggle: string;
}

/** Where the older history folds: what it holds, and a link that unfolds it into the trunk or folds it away again. */
function FoldCard({ rows, unfolded, toggle }: FoldProps) {
  const nodes = rows.flat().map((story) => story.node);

  return (
    <Card>
      <Text variant="secondary" size="sm">
        Older history: {plural(nodes.length, "node")}, {Math.min(...nodes)} to {Math.max(...nodes)}.{" "}
        <Link href={toggle}>{unfolded ? "Fold it away" : "Show it"}</Link>
      </Text>
    </Card>
  );
}

interface NodeProps {
  readonly base: string;
  readonly member: boolean;
  readonly story: NodeStory;
}

interface WordsProps extends NodeProps {
  /** Whether the panel shows this node. */
  readonly selected: boolean;
  /** How long ago it landed. */
  readonly ago: string | undefined;
  /** Where its "what happened" link goes. */
  readonly open: string;
}

/** One node's words: its heading, what it settled, how, and the way to what happened there. */
function NodeWords({ base, story, selected, open, ago }: WordsProps) {
  return (
    <>
      <Link href={`${base}/nodes/${story.node}`}>
        <span className="font-medium">{nodeIntent(story)}</span>
      </Link>
      <NodeMeta story={story} ago={ago} />
      {selected ? (
        <span className="flex items-center gap-2">
          <Badge variant="outline">shown</Badge>
          <Text variant="secondary" size="xs" as="span">
            what happened here is in the panel
          </Text>
        </span>
      ) : (
        <Link href={open}>{detailsLabel(story).replace("Details:", "What happened:")}</Link>
      )}
    </>
  );
}

/** The newest deploy's badge, and on a wide screen a short word of how it went; a failure's words wait in the details. */
function NewestDeploy({ deploys }: { readonly deploys: ReadonlyArray<Deploy> }) {
  const newest = deploys[0];

  if (newest === undefined) {
    return null;
  }

  const status = deployStatus(newest);

  return (
    <span className="flex min-w-0 items-center gap-1">
      <Badge variant={DEPLOY_BADGE[status.tone]} appearance="dot">
        {DEPLOY_WORD[status.tone]}
      </Badge>
      {status.tone === "failed" ? null : (
        <span className="hidden max-w-[28ch] min-w-0 sm:inline-flex">
          <Text variant="secondary" size="xs" as="span" truncate>
            {status.label}
          </Text>
        </span>
      )}
    </span>
  );
}

/** A node's quiet line: its commit, how long ago it landed, and where it stands (the head, released, its newest deploy). */
function NodeMeta({ story, ago }: { readonly story: NodeStory; readonly ago: string | undefined }) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Text variant="mono-secondary">{short(story.commit)}</Text>
      {ago === undefined ? null : (
        <Text variant="secondary" size="xs" as="span">
          {ago}
        </Text>
      )}
      {story.head ? <Badge variant="green">head</Badge> : null}
      {story.released ? <Badge variant="purple">released</Badge> : null}
      <NewestDeploy deploys={story.deploys} />
    </div>
  );
}

/** What happened at one node: its flow (task, attempts, node, deploy), the task in full, its deploys, and its change. */
function NodePanel({ base, member, story, ago }: NodeProps & { readonly ago: string | undefined }) {
  return (
    <section className="order-first flex min-w-0 flex-col gap-3 rounded-lg border border-kumo-hairline p-4 lg:sticky lg:top-4 lg:order-none">
      <Text variant="heading3" as="h3">
        {nodeIntent(story)}
      </Text>
      <NodeMeta story={story} ago={ago} />
      <Text variant="secondary" size="xs">
        {nodeSummary(story)}
      </Text>
      <NodeFlow base={base} member={member} story={story} />
      <FullPrompt intent={story.task?.intent ?? ""} />
      {story.deploys.length === 0 ? null : <DeployList base={base} deploys={story.deploys} />}
      <Text variant="secondary" size="xs">
        <Link href={`${base}/nodes/${story.node}`}>Browse node {story.node}</Link>
        {changeWords(story)}
      </Text>
    </section>
  );
}

/** What the node's page shows of its change. */
const changeWords = (story: NodeStory) => {
  if (story.kind !== "accepted") {
    return story.kind === "root" ? ": the files as initialized." : ": the outside commit's files.";
  }

  const paths = changedPaths(story);

  return paths === undefined ? ": see its changes." : `: ${paths}.`;
};

interface RunProps {
  readonly base: string;
  readonly row: TrunkRow;
  /** Every deploy of the run, newest first. */
  readonly deploys: ReadonlyArray<Deploy>;
}

/** A run of grafts from one place, said once: where they came from, and in the details each node and its deploys. */
function GraftRunWords({ base, row, deploys }: RunProps) {
  const oldest = row.at(-1) ?? row[0];

  return (
    <>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Text size="sm" as="span">
          nodes {oldest.node} to {row[0].node}
        </Text>
        <NewestDeploy deploys={deploys} />
      </div>
      <Text size="sm">{graftRunIntent(row)}</Text>
      <Text variant="secondary" size="xs">
        Imported onto the trunk one after another, each its own node.
      </Text>
      <CollapsibleRoot>
        <CollapsibleTrigger className={TRIGGER_CLASS}>
          Details: {plural(row.length, "node")}
          {deploys.length === 0 ? "" : `, ${plural(deploys.length, "deploy")}`}
        </CollapsibleTrigger>
        <CollapsiblePanel>
          <div className="flex flex-col gap-3 pt-1">
            <ul className="flex flex-col gap-1">
              {row.map((story) => (
                <li key={story.node} className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <Link href={`${base}/nodes/${story.node}`}>node {story.node}</Link>
                  <Text variant="mono-secondary">{short(story.commit)}</Text>
                  <NewestDeploy deploys={story.deploys} />
                </li>
              ))}
            </ul>
            {deploys.length === 0 ? null : <DeployList base={base} deploys={deploys} />}
          </div>
        </CollapsiblePanel>
      </CollapsibleRoot>
    </>
  );
}
