import { Badge, Empty, Flow, Link, Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import type { Deploy } from "../lib/answers.ts";
import { deployStatus } from "../lib/release.ts";
import type { NodeStory } from "../lib/trunk.ts";
import {
  changedPaths,
  detailsLabel,
  graftRunIntent,
  headline,
  nodeIntent,
  nodeSummary,
  plural,
  trunkRows,
  type TrunkRow,
} from "../lib/trunk-words.ts";
import { short } from "../lib/view.ts";
import { DEPLOY_BADGE, DEPLOY_WORD, DeployList } from "./deploy-list.tsx";
import { NodeFlow } from "./node-flow.tsx";
import { CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger, FlowNode } from "./kumo.ts";

/** How many nodes show before the older history folds away; the root always shows below the fold. */
const SHOWN = 10;

/** A details trigger that reads as a quiet action under the card's words, left-aligned when it wraps. */
const TRIGGER_CLASS = "text-left text-sm font-normal text-kumo-subtle";

/** Turns a box upside down; the flow below wears it, and each card wears it again to read the right way up. */
const FLIP = "-scale-y-100";

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
export function TrunkView({ org, tree, member, stories, shown, older }: Props) {
  const [head] = stories;

  if (head === undefined) {
    return <Empty size="sm" title="Nothing accepted yet" />;
  }

  const base = `/orgs/${org}/trees/${tree}`;
  const unfolded = older === "1";
  const selected = stories.find((story) => String(story.node) === shown) ?? head;

  const here = (node: number, open: boolean) => {
    const query = new URLSearchParams({ node: String(node) });

    if (open) {
      query.set("older", "1");
    }

    return `${base}?${query.toString()}#history`;
  };

  const rows = trunkRows(stories);
  const folds = rows.length > SHOWN + 2;

  const card = (row: TrunkRow) => (
    <TrunkCard key={row[0].node} base={base} member={member} row={row} selected={selected.node} open={here(row[0].node, unfolded)} />
  );

  const olderRows = folds && unfolded ? rows.slice(SHOWN, -1) : [];
  const root = folds ? rows.slice(-1) : [];
  const newest = folds ? rows.slice(0, SHOWN) : rows;

  return (
    <div id="history" className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] lg:items-start">
      <UpwardFlow>
        {root.map(card)}
        {olderRows.toReversed().map(card)}
        {folds ? <FoldCard rows={rows.slice(SHOWN, -1)} unfolded={unfolded} toggle={here(selected.node, !unfolded)} /> : null}
        {newest.toReversed().map(card)}
      </UpwardFlow>
      <NodePanel base={base} member={member} story={selected} />
    </div>
  );
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

/** One step of the trunk, turned the right way up: wide enough for its words, never wider than the screen. */
function Card({ children }: { readonly children: ReactNode }) {
  return (
    <FlowNode>
      <div className={`${FLIP} flex w-[calc(100cqw-2.5rem)] min-w-0 flex-col gap-1 text-left [overflow-wrap:anywhere]`}>{children}</div>
    </FlowNode>
  );
}

const newestFirst = (deploys: ReadonlyArray<Deploy>) => deploys.toSorted((one, other) => other.started_at - one.started_at);

interface RowProps {
  readonly base: string;
  readonly member: boolean;
  readonly row: TrunkRow;
  /** The node the panel shows. */
  readonly selected: number;
  /** Where its "what happened" link goes. */
  readonly open: string;
}

/** A node's card, or one card for a run of grafts from one place with every deploy of the run. */
function TrunkCard({ base, member, row, selected, open }: RowProps) {
  const [story] = row;

  return (
    <Card>
      {row.length === 1 ? (
        <NodeWords base={base} member={member} story={story} selected={selected === story.node} open={open} />
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
  /** Where its "what happened" link goes. */
  readonly open: string;
}

/** One node's words: its heading, what it settled, how, and the way to what happened there. */
function NodeWords({ base, member, story, selected, open }: WordsProps) {
  return (
    <>
      <NodeHeading base={base} story={story} />
      {member && story.task !== undefined ? (
        <Link href={`${base}/tasks/${story.task.id}`}>{nodeIntent(story)}</Link>
      ) : (
        <Text size="sm">{nodeIntent(story)}</Text>
      )}
      <Text variant="secondary" size="xs">
        {nodeSummary(story)}
      </Text>
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

/** The node's name and commit, and where it stands: the head, released, its newest deploy. */
function NodeHeading({ base, story }: Omit<NodeProps, "member">) {
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <Link href={`${base}/nodes/${story.node}`}>node {story.node}</Link>
      <Text variant="mono-secondary">{short(story.commit)}</Text>
      {story.head ? <Badge variant="green">head</Badge> : null}
      {story.released ? <Badge variant="purple">released</Badge> : null}
      <NewestDeploy deploys={story.deploys} />
    </div>
  );
}

/** What happened at one node: its flow (task, attempts, node, deploy), the task in full, its deploys, and its change. */
function NodePanel({ base, member, story }: NodeProps) {
  return (
    <section className="order-first flex min-w-0 flex-col gap-3 rounded-lg border border-kumo-hairline p-4 lg:sticky lg:top-4 lg:order-none">
      <Text variant="heading3" as="h3">
        What happened at node {story.node}
      </Text>
      <Text size="sm">{nodeIntent(story)}</Text>
      <NodeFlow base={base} member={member} story={story} />
      <FullIntent story={story} />
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

/** The task's whole intent, folded, when the heading showed only its first sentence. */
function FullIntent({ story }: { readonly story: NodeStory }) {
  const intent = story.task?.intent.trim() ?? "";

  if (intent === "" || headline(intent) === intent) {
    return null;
  }

  return (
    <CollapsibleRoot>
      <CollapsibleTrigger className={TRIGGER_CLASS}>The task in full</CollapsibleTrigger>
      <CollapsiblePanel>
        <p className="whitespace-pre-line">
          <Text variant="secondary" size="sm" as="span">
            {intent}
          </Text>
        </p>
      </CollapsiblePanel>
    </CollapsibleRoot>
  );
}
