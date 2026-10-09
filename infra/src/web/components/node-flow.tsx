import { Flow, Link, Loader, Text } from "@cloudflare/kumo";
import type { ReactNode } from "react";
import { deploySteps, type DeployTone } from "../lib/release.ts";
import type { GrowingStory, LiveAttempt } from "../lib/growing.ts";
import type { AttemptStory, NodeStory } from "../lib/trunk.ts";
import { attemptChains, attemptDetail, OUTCOME_WORD } from "../lib/trunk-words.ts";
import { FlowList, FlowNode, FlowParallel } from "./kumo.ts";

/** How a step's outcome reads: Kumo's text variants. */
const TONE_TEXT = {
  running: "secondary",
  deployed: "success",
  failed: "error",
  skipped: "secondary",
  unknown: "secondary",
} as const satisfies Record<DeployTone, string>;

/** A step in the flow: what it is, then how it went. */
function Step({ title, children }: { readonly title: ReactNode; readonly children?: ReactNode }) {
  return (
    <span className="flex max-w-32 flex-col gap-0.5 text-left sm:max-w-40">
      <Text size="sm" as="span">
        {title}
      </Text>
      {children}
    </span>
  );
}

function Detail({ children, variant = "secondary" }: { readonly children: ReactNode; readonly variant?: "secondary" | "success" | "error" }) {
  return (
    <Text variant={variant} size="xs" as="span">
      {children}
    </Text>
  );
}

interface AttemptProps {
  readonly base: string;
  readonly member: boolean;
  readonly attempt: AttemptStory;
}

/** One attempt; a losing or abandoned one greys the connector into it. */
function AttemptStep({ base, member, attempt }: AttemptProps) {
  const title = member ? <Link href={`${base}/attempts/${attempt.attempt}`}>attempt {attempt.attempt}</Link> : `attempt ${attempt.attempt}`;

  return (
    <FlowNode key={attempt.attempt} disabled={attempt.outcome === "lost" || attempt.outcome === "abandoned"}>
      <Step title={title}>
        <Detail>{attempt.agent}</Detail>
        <Detail variant={attempt.outcome === "accepted" ? "success" : "secondary"}>{OUTCOME_WORD[attempt.outcome]}</Detail>
        {attemptDetail(attempt) === "" ? null : <Detail>{attemptDetail(attempt)}</Detail>}
      </Step>
    </FlowNode>
  );
}

/** Every piece of work at the task side by side; a piece moved on by rebases or retries is a list, oldest first. */
function Attempts({ base, member, story }: { readonly base: string; readonly member: boolean; readonly story: NodeStory }) {
  const lines = attemptChains(story.attempts).map(({ line }) => line);
  const step = (attempt: AttemptStory) => <AttemptStep key={attempt.attempt} base={base} member={member} attempt={attempt} />;

  if (lines.length === 1) {
    return lines[0]?.map(step);
  }

  return (
    <FlowParallel>
      {lines.map((line) => (line.length === 1 ? line.map(step) : <FlowList key={line[0]?.attempt}>{line.map(step)}</FlowList>))}
    </FlowParallel>
  );
}

/** The newest deploy of the node, step by step as its Deploy Workflow ran. */
function DeploySteps({ story }: { readonly story: NodeStory }) {
  const [newest] = story.deploys;

  if (newest === undefined) {
    return null;
  }

  const started = new Date(newest.started_at).toISOString().slice(0, 16).replace("T", " ");

  return [
    <FlowNode key="release">
      <Step title="release">
        <Detail>{story.released ? `released now, since ${started}` : `released ${started}`} UTC</Detail>
      </Step>
    </FlowNode>,
    ...deploySteps(newest).map(({ title, detail, tone }) => (
      <FlowNode key={title} disabled={tone === "skipped"}>
        <Step title={title}>
          <Detail variant={TONE_TEXT[tone]}>{detail}</Detail>
        </Step>
      </FlowNode>
    )),
  ];
}

interface Props {
  /** The tree page. */
  readonly base: string;
  /** Whether the reader may open attempt pages. */
  readonly member: boolean;
  readonly story: NodeStory;
}

/**
 * What happened at an accepted node, as a Kumo Flow: its task, every attempt
 * at it (the work that lost greyed), the node it became, then the newest
 * release's deploy as its Workflow ran.
 */
export function NodeFlow(props: Props) {
  // A phone starts the flow at its left edge, where the winning line runs; a wider screen centres it.
  return (
    <>
      <div className="sm:hidden">
        <NodeFlowAligned {...props} align="start" />
      </div>
      <div className="hidden sm:block">
        <NodeFlowAligned {...props} align="center" />
      </div>
    </>
  );
}

function NodeFlowAligned({ base, member, story, align }: Props & { readonly align: "start" | "center" }) {
  if (story.kind !== "accepted" || story.task === undefined) {
    return null;
  }

  const task = member ? <Link href={`${base}/tasks/${story.task.id}`}>task {story.task.id}</Link> : `task ${story.task.id}`;

  return (
    <Flow orientation="vertical" align={align} padding={{ x: 8, y: 16 }}>
      <FlowNode>
        <Step title={task} />
      </FlowNode>
      <Attempts base={base} member={member} story={story} />
      <FlowNode>
        <Step title={<Link href={`${base}/nodes/${story.node}`}>node {story.node}</Link>}>
          <Detail variant="success">accepted{story.head ? ", the head" : ""}</Detail>
        </Step>
      </FlowNode>
      <DeploySteps story={story} />
    </Flow>
  );
}

interface LiveProps {
  readonly base: string;
  readonly member: boolean;
  readonly attempt: LiveAttempt;
}

/** An attempt still in the race, as it is now: who, where it stands, what it is doing. */
function LiveStep({ base, member, attempt }: LiveProps) {
  const title = member ? <Link href={`${base}/attempts/${attempt.attempt}`}>attempt {attempt.attempt}</Link> : `attempt ${attempt.attempt}`;

  return (
    <FlowNode key={attempt.attempt}>
      <Step title={title}>
        <Detail>{attempt.agent}</Detail>
        <span className="flex items-center gap-1">
          {attempt.live ? <Loader size={10} /> : null}
          <Detail variant={attempt.tone === "winner" ? "success" : "secondary"}>{attempt.words}</Detail>
        </span>
      </Step>
    </FlowNode>
  );
}

interface TaskProps {
  readonly base: string;
  readonly member: boolean;
  readonly story: GrowingStory;
}

function TaskFlowAligned({ base, member, story, align }: TaskProps & { readonly align: "start" | "center" }) {
  const task = member ? <Link href={`${base}/tasks/${story.task.id}`}>task {story.task.id}</Link> : `task ${story.task.id}`;
  const step = (attempt: LiveAttempt) => <LiveStep key={attempt.attempt} base={base} member={member} attempt={attempt} />;

  return (
    <Flow orientation="vertical" align={align} padding={{ x: 8, y: 16 }}>
      <FlowNode>
        <Step title={task} />
      </FlowNode>
      {story.attempts.length === 1 ? story.attempts.map(step) : <FlowParallel>{story.attempts.map(step)}</FlowParallel>}
      <FlowNode disabled>
        <Step title="the next node">
          <Detail>once the best passing attempt is accepted</Detail>
        </Step>
      </FlowNode>
    </Flow>
  );
}

/** An open task's race as it runs: the task, its attempts side by side as they are now, and the node an accept would make. */
export function TaskFlow(props: TaskProps) {
  return (
    <>
      <div className="sm:hidden">
        <TaskFlowAligned {...props} align="start" />
      </div>
      <div className="hidden sm:block">
        <TaskFlowAligned {...props} align="center" />
      </div>
    </>
  );
}
