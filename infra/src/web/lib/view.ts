/**
 * How the tree reads on a page: plain functions over the decoded shapes, so
 * they test without a Worker.
 */
import type { Bud, Leaf, LeafState, PruneReason, Tree, TreeNode } from "./answers.ts";

export type Tone = "growing" | "ripening" | "ripe" | "fruit" | "pruned";

export interface Status {
  readonly tone: Tone;
  readonly label: string;
  readonly commit: string | undefined;
}

export const short = (oid: string) => oid.slice(0, 8);

export const pruneReason = (reason: PruneReason) => {
  if ("Outgrown" in reason) {
    return `outgrown by leaf ${reason.Outgrown.by}`;
  }

  if ("Regrown" in reason) {
    return `regrown as leaf ${reason.Regrown.into}`;
  }

  return `withered: ${reason.Withered.note}`;
};

export const status = (state: LeafState): Status => {
  if (state === "Growing") {
    return { tone: "growing", label: "growing", commit: undefined };
  }

  if ("Ripening" in state) {
    return { tone: "ripening", label: "ripening: checks running", commit: state.Ripening.commit };
  }

  if ("Ripe" in state) {
    const { score, commit } = state.Ripe;
    const verdict = score.checks_passed === score.checks_total ? "passes" : "fails";

    return {
      tone: "ripe",
      label: `ripe: ${verdict} ${score.checks_passed}/${score.checks_total} checks, cost ${score.cost}`,
      commit,
    };
  }

  if ("Fruit" in state) {
    return { tone: "fruit", label: `fruit: node ${state.Fruit.node}`, commit: undefined };
  }

  return { tone: "pruned", label: `pruned: ${pruneReason(state.Pruned.reason)}`, commit: undefined };
};

/** The accepted history: root first, head last, following parents back from the head. */
export const trunk = (tree: Tree): ReadonlyArray<TreeNode> => {
  const nodes: Array<TreeNode> = [];
  let current = tree.nodes[String(tree.head)];

  while (current !== undefined) {
    nodes.push(current);
    current = current.parent === null ? undefined : tree.nodes[String(current.parent)];
  }

  return nodes.toReversed();
};

export interface BudView {
  readonly bud: Bud;
  readonly leaves: ReadonlyArray<Leaf>;
  /** The node the bud's harvest made, once it has fruited. */
  readonly fruit: number | undefined;
}

/** Every bud with its leaves, newest bud first. */
export const buds = (tree: Tree): ReadonlyArray<BudView> => {
  const leaves = Object.values(tree.leaves);

  return Object.values(tree.buds)
    .toSorted((a, b) => b.id - a.id)
    .map((bud) => ({
      bud,
      leaves: leaves.filter((leaf) => leaf.bud === bud.id).toSorted((a, b) => a.id - b.id),
      fruit: bud.state === "Open" ? undefined : bud.state.Fruited.node,
    }));
};

/** `a/b/c` → [["a", "a"], ["b", "a/b"], ["c", "a/b/c"]]: a breadcrumb's labels and targets. */
export const crumbs = (path: string): ReadonlyArray<readonly [string, string]> => {
  const names = path.split("/").filter((name) => name !== "");

  return names.map((name, index) => [name, names.slice(0, index + 1).join("/")] as const);
};

export const join = (directory: string, name: string) => (directory === "" ? name : `${directory}/${name}`);
