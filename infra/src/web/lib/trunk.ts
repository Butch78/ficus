/**
 * The accepted history as a story per node, for the tree page's drawing of
 * the trunk: which task each node settled, every attempt at it and what
 * became of each, and the releases and deploys that followed the node.
 * Plain functions over the decoded shapes, so they test without a Worker.
 */
import type { Attempt, CloseReason, Deploy, Score, Tree, TreeNode } from "./answers.ts";
import { trunk } from "./view.ts";

/** What became of one attempt at a node's task. */
export type Outcome = "accepted" | "lost" | "abandoned" | "rebased" | "retried" | "open";

export interface AttemptStory {
  readonly attempt: number;
  readonly agent: string;
  readonly outcome: Outcome;
  /** How it scored, said for people ("5/5 checks, cost 81"); undefined if it was never scored. */
  readonly score: string | undefined;
  /** The attempt it was rebased or retried into, or the attempt it lost to. */
  readonly other: number | undefined;
  /** Why it was abandoned. */
  readonly note: string | undefined;
}

export interface NodeStory {
  readonly node: number;
  readonly parent: number | null;
  readonly commit: string;
  /** The root (initialized), an accepted attempt, or a graft of an outside commit. */
  readonly kind: "root" | "accepted" | "graft";
  /** The task the node settled; undefined for the root and a graft. */
  readonly task: { readonly id: number; readonly intent: string } | undefined;
  /** Where a graft came from. */
  readonly graftedFrom: string | undefined;
  /** Every attempt at the node's task, the accepted one first, then by id. */
  readonly attempts: ReadonlyArray<AttemptStory>;
  /** Paths the accepted change touched. */
  readonly touched: ReadonlyArray<string>;
  readonly head: boolean;
  /** Whether the release points at this node now. */
  readonly released: boolean;
  /** This node's deploys, newest first. */
  readonly deploys: ReadonlyArray<Deploy>;
}

/** A score said for people: "5/5 checks, cost 81", with the judges' confidence when there is one. */
export const scoreText = (score: Score) => {
  const checks = `${score.checks_passed}/${score.checks_total} checks, cost ${score.cost}`;
  const confidence = score.confidence ?? null;

  return confidence === null ? checks : `${checks}, judge ${(confidence / 1000).toFixed(2)}`;
};

interface Ending {
  readonly outcome: Outcome;
  readonly other: number | undefined;
  readonly note: string | undefined;
}

const ending = (reason: CloseReason): Ending => {
  if ("Lost" in reason) {
    return { outcome: "lost", other: reason.Lost.to, note: undefined };
  }

  if ("Retried" in reason) {
    return { outcome: "retried", other: reason.Retried.into, note: undefined };
  }

  if ("Rebased" in reason) {
    return { outcome: "rebased", other: reason.Rebased.into, note: undefined };
  }

  return { outcome: "abandoned", other: undefined, note: reason.Abandoned.note };
};

const OPEN: Ending = { outcome: "open", other: undefined, note: undefined };

/** What became of `attempt`: still open (working, checking or scored on an older base), accepted, or closed and why. */
const endingOf = (attempt: Attempt): Ending => {
  const { state } = attempt;

  if (state === "Working" || "Checking" in state || "Scored" in state) {
    return OPEN;
  }

  if ("Accepted" in state) {
    return { outcome: "accepted", other: undefined, note: undefined };
  }

  return ending(state.Closed.reason);
};

/** The score an attempt carries while scored, or the one history kept when it closed. */
const scoreOf = (tree: Tree, attempt: Attempt) => {
  const { state } = attempt;

  if (state !== "Working" && "Scored" in state) {
    return state.Scored.score;
  }

  return tree.history.find((entry) => entry.attempt === attempt.id)?.score ?? undefined;
};

/** The attempt that was rebased into `attempt`: the same commits, replayed onto a newer head. */
const rebasedFrom = (tree: Tree, attempt: Attempt) =>
  Object.values(tree.attempts).find(
    ({ state }) => state !== "Working" && "Closed" in state && "Rebased" in state.Closed.reason && state.Closed.reason.Rebased.into === attempt.id,
  );

/**
 * How an accepted attempt scored, as near as the tree remembers: it keeps no
 * score once an attempt is accepted, but the attempt it was rebased from kept
 * its own, for the same change on an older head.
 */
const acceptedScore = (tree: Tree, attempt: Attempt) => {
  const seen = new Set([attempt.id]);
  let from = rebasedFrom(tree, attempt);

  while (from !== undefined && !seen.has(from.id)) {
    const score = scoreOf(tree, from);

    if (score !== undefined) {
      return `${scoreText(score)}, before its rebase`;
    }

    seen.add(from.id);
    from = rebasedFrom(tree, from);
  }

  return undefined;
};

const attemptStory = (tree: Tree, attempt: Attempt): AttemptStory => {
  const ended = endingOf(attempt);
  const score = scoreOf(tree, attempt);
  const said = score === undefined ? undefined : scoreText(score);

  return {
    attempt: attempt.id,
    agent: attempt.agent,
    ...ended,
    score: said === undefined && ended.outcome === "accepted" ? acceptedScore(tree, attempt) : said,
  };
};

/** Every attempt at `task`, the accepted one first, then by id. */
const attemptsAt = (tree: Tree, task: number): ReadonlyArray<AttemptStory> =>
  Object.values(tree.attempts)
    .filter((attempt) => attempt.task === task)
    .map((attempt) => attemptStory(tree, attempt))
    .sort((one, other) => Number(other.outcome === "accepted") - Number(one.outcome === "accepted") || one.attempt - other.attempt);

/** The task `node` settled: its accepted attempt's, or the task done at it. */
const taskAt = (tree: Tree, node: TreeNode) => {
  const winner = node.accepted_from === null ? undefined : tree.attempts[String(node.accepted_from)];

  const task =
    winner === undefined
      ? Object.values(tree.tasks).find(({ state }) => state !== "Open" && "Done" in state && state.Done.node === node.id)
      : tree.tasks[String(winner.task)];

  return task === undefined ? undefined : { id: task.id, intent: task.intent };
};

const kindOf = (node: TreeNode): NodeStory["kind"] => {
  if (node.accepted_from !== null) {
    return "accepted";
  }

  return node.parent === null ? "root" : "graft";
};

const nodeStory = (tree: Tree, node: TreeNode, deploys: ReadonlyArray<Deploy>): NodeStory => {
  const kind = kindOf(node);
  const task = kind === "accepted" ? taskAt(tree, node) : undefined;

  return {
    node: node.id,
    parent: node.parent,
    commit: node.commit,
    kind,
    task,
    graftedFrom: kind === "graft" ? node.grafted_from : undefined,
    attempts: task === undefined ? [] : attemptsAt(tree, task.id),
    touched: node.touched ?? [],
    head: tree.head === node.id,
    released: (tree.released ?? null) === node.id,
    deploys: deploys.filter((deploy) => deploy.node === node.id).toSorted((one, other) => other.started_at - one.started_at),
  };
};

/** The trunk from the head down to the root (node 0), following parents, each node with its story. */
export const trunkStory = (tree: Tree, deploys: ReadonlyArray<Deploy>): ReadonlyArray<NodeStory> =>
  trunk(tree)
    .toReversed()
    .map((node) => nodeStory(tree, node, deploys));
