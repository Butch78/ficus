/**
 * How the tree reads on a page: plain functions over the decoded shapes, so
 * they test without a Worker.
 */
import type { Task, Attempt, AttemptState, CloseReason, Tree, TreeNode } from "./answers.ts";
import { taskName } from "./trunk-words.ts";

/** Where an attempt stands; `failing` is scored with at least one failed check. */
export type Tone = "working" | "checking" | "scored" | "failing" | "accepted" | "closed";

export interface Status {
  readonly tone: Tone;
  readonly label: string;
  readonly commit: string | undefined;
}

export const short = (oid: string) => oid.slice(0, 8);

export const closeReason = (reason: CloseReason) => {
  if ("Lost" in reason) {
    return `lost to attempt ${reason.Lost.to}`;
  }

  if ("Retried" in reason) {
    return `retried as attempt ${reason.Retried.into}`;
  }

  if ("Rebased" in reason) {
    return `rebased onto the head as attempt ${reason.Rebased.into}`;
  }

  return `abandoned: ${reason.Abandoned.note}`;
};

export const status = (state: AttemptState): Status => {
  if (state === "Working") {
    return { tone: "working", label: "working", commit: undefined };
  }

  if ("Checking" in state) {
    return { tone: "checking", label: "checking: checks running", commit: state.Checking.commit };
  }

  if ("Scored" in state) {
    const { score, commit } = state.Scored;
    const passes = score.checks_passed === score.checks_total;

    return {
      tone: passes ? "scored" : "failing",
      label: `scored: ${passes ? "passes" : "fails"} ${score.checks_passed}/${score.checks_total} checks, cost ${score.cost}`,
      commit,
    };
  }

  if ("Accepted" in state) {
    return { tone: "accepted", label: `accepted: node ${state.Accepted.node}`, commit: undefined };
  }

  return { tone: "closed", label: `closed: ${closeReason(state.Closed.reason)}`, commit: undefined };
};

/** The accepted history: root first, head last, following parents back from the head; a parent missing (or seen twice) ends the walk. */
export const trunk = (tree: Tree): ReadonlyArray<TreeNode> => {
  const nodes: Array<TreeNode> = [];
  const seen = new Set<number>();
  let current = tree.nodes[String(tree.head)];

  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    nodes.push(current);
    current = current.parent === null ? undefined : tree.nodes[String(current.parent)];
  }

  return nodes.toReversed();
};

export interface TaskView {
  readonly task: Task;
  readonly attempts: ReadonlyArray<Attempt>;
  /** The node the task's accept made, once it has fruited. */
  readonly accepted: number | undefined;
}

/** Every task with its attempts, newest task first. */
export const tasks = (tree: Tree): ReadonlyArray<TaskView> => {
  const attempts = Object.values(tree.attempts);

  return Object.values(tree.tasks)
    .toSorted((a, b) => b.id - a.id)
    .map((task) => ({
      task,
      attempts: attempts.filter((attempt) => attempt.task === task.id).toSorted((a, b) => a.id - b.id),
      accepted: task.state === "Open" || "Closed" in task.state ? undefined : task.state.Done.node,
    }));
};

/** `a/b/c` → [["a", "a"], ["b", "a/b"], ["c", "a/b/c"]]: a breadcrumb's labels and targets. */
export const crumbs = (path: string): ReadonlyArray<readonly [string, string]> => {
  const names = path.split("/").filter((name) => name !== "");

  return names.map((name, index) => [name, names.slice(0, index + 1).join("/")] as const);
};

export const join = (directory: string, name: string) => (directory === "" ? name : `${directory}/${name}`);

/** The name of the task an accepted node settled (lib/trunk-words.ts `taskName`); undefined for the root, a graft, or an unknown node. */
export const nodeTitle = (tree: Tree, node: number) => {
  const from = tree.nodes[String(node)]?.accepted_from;
  const task = from === null || from === undefined ? undefined : tree.tasks[String(tree.attempts[String(from)]?.task)];

  return task === undefined ? undefined : taskName(task);
};
