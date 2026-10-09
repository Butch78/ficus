import { Badge, Empty, Link, Text } from "@cloudflare/kumo";
import type { Deploy } from "../lib/answers.ts";
import { deployStatus, type DeployTone } from "../lib/release.ts";
import type { NodeStory, Outcome } from "../lib/trunk.ts";
import {
  attemptChains,
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
import { CollapsibleBarePanel, CollapsiblePanel, CollapsibleRoot, CollapsibleTrigger } from "./kumo.ts";
import { AttemptIcon, DeployIcon, deployMarks, NodeDrawing, reach, TrunkSegment, trunkWidth } from "./trunk-drawing.tsx";

/** How many rows show before the older history folds away; the root's row always shows below the fold. */
const SHOWN = 10;

/** A details trigger that reads as a quiet action under the row's words, left-aligned when it wraps. */
const TRIGGER_CLASS = "text-left text-sm font-normal text-kumo-subtle";

interface Props {
  readonly org: string;
  readonly tree: string;
  /** Whether the reader is a member: only members may open task and attempt pages. */
  readonly member: boolean;
  /** The trunk, head first (lib/trunk.ts `trunkStory`). */
  readonly stories: ReadonlyArray<NodeStory>;
}

/** The trunk's history drawn as a ficus growing upward, each node with what happened there in words. */
export function TrunkView({ org, tree, member, stories }: Props) {
  if (stories.length === 0) {
    return <Empty size="sm" title="Nothing accepted yet" />;
  }

  const base = `/orgs/${org}/trees/${tree}`;
  const rows = trunkRows(stories);
  const root = rows.length > SHOWN + 2 ? rows.at(-1) : undefined;
  const shown = root === undefined ? rows : rows.slice(0, SHOWN);
  // The rows a closed fold leaves: the trunk tapers over those, and the folded rows keep the fold's width.
  const count = root === undefined ? rows.length : SHOWN + 2;
  const width = (index: number) => trunkWidth(index, count);

  return (
    <div className="flex flex-col gap-3">
      <TrunkKey stories={stories} />
      <ol className="flex flex-col pt-6 sm:pt-8">
        {shown.map((row, index) => (
          <NodeRow key={row[0].node} base={base} member={member} row={row} top={width(index)} bottom={width(index + 1)} sway={index % 2 === 0 ? 3 : -3} />
        ))}
        {root === undefined ? null : (
          <>
            <OlderRows base={base} member={member} rows={rows.slice(SHOWN, -1)} width={width(SHOWN)} bottom={width(SHOWN + 1)} />
            <NodeRow base={base} member={member} row={root} top={width(SHOWN + 1)} bottom={width(SHOWN + 1)} sway={0} />
          </>
        )}
      </ol>
    </div>
  );
}

const KEY_ATTEMPTS = [
  ["accepted", "accepted"],
  ["lost", "lost"],
  ["abandoned", "abandoned"],
  ["rebased", "rebased or retried"],
  ["open", "still open"],
] as const satisfies ReadonlyArray<readonly [Outcome, string]>;

const KEY_DEPLOYS = [
  ["deployed", "deployed"],
  ["running", "deploying"],
  ["failed", "deploy failed"],
  ["skipped", "nothing to deploy"],
  ["unknown", "deploy not known"],
] as const satisfies ReadonlyArray<readonly [DeployTone, string]>;

/** The attempt marks the drawing shows: each piece of work's last outcome, and a rebase's mark wherever work was moved on. */
const drawnOutcomes = (stories: ReadonlyArray<NodeStory>) =>
  new Set(
    stories.flatMap(({ attempts }) =>
      attemptChains(attempts).flatMap(({ last, rebased, retried }): ReadonlyArray<Outcome> => (rebased + retried > 0 ? [last.outcome, "rebased"] : [last.outcome])),
    ),
  );

/** What the drawing's marks mean, each beside its own mark: only the marks it shows. */
function TrunkKey({ stories }: { readonly stories: ReadonlyArray<NodeStory> }) {
  const outcomes = drawnOutcomes(stories);
  const marks = stories.flatMap((story) => deployMarks(story));
  const tones = new Set(marks.map((mark) => mark.tone));
  const released = marks.find((mark) => mark.released);

  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1">
      {KEY_ATTEMPTS.flatMap(([outcome, words]) =>
        outcomes.has(outcome)
          ? [
              <li key={outcome} className="flex items-center gap-1">
                <svg width={30} height={18} viewBox="-1 -12 40 24" aria-hidden="true">
                  <AttemptIcon outcome={outcome} />
                </svg>
                <Text variant="secondary" size="xs" as="span">
                  {words}
                </Text>
              </li>,
            ]
          : [],
      )}
      {KEY_DEPLOYS.flatMap(([tone, words]) => (tones.has(tone) ? [<KeyDeploy key={tone} tone={tone} released={false} words={words} />] : []))}
      {released === undefined ? null : <KeyDeploy tone={released.tone} released words="released now" />}
    </ul>
  );
}

function KeyDeploy({ tone, released, words }: { readonly tone: DeployTone; readonly released: boolean; readonly words: string }) {
  return (
    <li className="flex items-center gap-1">
      <svg width={22} height={22} viewBox="-11 -11 22 22" aria-hidden="true">
        <DeployIcon tone={tone} released={released} />
      </svg>
      <Text variant="secondary" size="xs" as="span">
        {words}
      </Text>
    </li>
  );
}

const newestFirst = (deploys: ReadonlyArray<Deploy>) => deploys.toSorted((one, other) => other.started_at - one.started_at);

interface RowProps {
  readonly base: string;
  readonly member: boolean;
  readonly row: TrunkRow;
  /** The trunk's width at the row's node and where the row ends. */
  readonly top: number;
  readonly bottom: number;
  /** How far the trunk leans through the row; the head's and the root's short pieces stand straight. */
  readonly sway: number;
}

function NodeRow({ base, member, row, top, bottom, sway }: RowProps) {
  const [story] = row;
  const span = reach(story);
  // A run of grafts is drawn once, with every deploy of the run.
  const drawn = row.length === 1 ? story : { ...story, deploys: newestFirst(row.flatMap((each) => each.deploys)) };

  return (
    <li className="flex gap-2 sm:gap-3">
      <div className="relative w-16 shrink-0 sm:w-24">
        <TrunkSegment reach={span} top={top} bottom={bottom} sway={span === "full" ? sway : 0} />
        <NodeDrawing story={drawn} width={top} run={row.length} />
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1 pt-1 pb-6 [overflow-wrap:anywhere] sm:pt-3">
        {row.length === 1 ? <NodeWords base={base} member={member} story={story} /> : <GraftRunWords base={base} row={row} deploys={drawn.deploys} />}
      </div>
    </li>
  );
}

interface OlderProps {
  readonly base: string;
  readonly member: boolean;
  readonly rows: ReadonlyArray<TrunkRow>;
  /** The trunk's width through the fold and its rows, and where the fold's row ends. */
  readonly width: number;
  readonly bottom: number;
}

/** The older rows, folded away under one row that says what they hold; the trunk runs on through it. */
function OlderRows({ base, member, rows, width, bottom }: OlderProps) {
  const nodes = rows.flat().map((story) => story.node);

  return (
    <li>
      <CollapsibleRoot>
        <div className="flex gap-2 sm:gap-3">
          <div className="relative min-h-14 w-16 shrink-0 sm:w-24">
            <TrunkSegment reach="full" top={width} bottom={bottom} sway={0} />
          </div>
          <div className="flex min-w-0 flex-1 items-start pt-1 pb-6 sm:pt-3">
            <CollapsibleTrigger className={TRIGGER_CLASS}>
              Older history: {plural(nodes.length, "node")}, {Math.min(...nodes)} to {Math.max(...nodes)}
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleBarePanel>
          <ol className="flex flex-col">
            {rows.map((row, index) => (
              <NodeRow key={row[0].node} base={base} member={member} row={row} top={width} bottom={width} sway={index % 2 === 0 ? 3 : -3} />
            ))}
          </ol>
        </CollapsibleBarePanel>
      </CollapsibleRoot>
    </li>
  );
}

interface NodeProps {
  readonly base: string;
  readonly member: boolean;
  readonly story: NodeStory;
}

/** One node's words: its heading, what it settled, how, and its details. */
function NodeWords({ base, member, story }: NodeProps) {
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
      <NodeDetails base={base} member={member} story={story} />
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

/** What happened at the node as a flow (task, attempts, node, deploy), its deploys' history, and its change; open at the head. */
function NodeDetails({ base, member, story }: NodeProps) {
  return (
    <CollapsibleRoot defaultOpen={story.head}>
      <CollapsibleTrigger className={TRIGGER_CLASS}>{detailsLabel(story)}</CollapsibleTrigger>
      <CollapsiblePanel>
        <div className="flex flex-col gap-3 pt-1">
          <NodeFlow base={base} member={member} story={story} />
          <FullIntent story={story} />
          {story.deploys.length === 0 ? null : <DeployList base={base} deploys={story.deploys} />}
          <Text variant="secondary" size="xs">
            <Link href={`${base}/nodes/${story.node}`}>Browse node {story.node}</Link>
            {changeWords(story)}
          </Text>
        </div>
      </CollapsiblePanel>
    </CollapsibleRoot>
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
