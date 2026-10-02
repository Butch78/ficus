/**
 * A leaf's life so far, as the steps it has been through and the ones still
 * ahead of it. Pure, so it tests without a page.
 */
import type { StepStatus } from "../components/elements/chain-of-thought.tsx";
import type { LeafState } from "./answers.ts";
import { pruneReason, short } from "./view.ts";

export interface Moment {
  readonly label: string;
  readonly status: StepStatus;
}

export const timeline = (state: LeafState, base: number): ReadonlyArray<Moment> => {
  const sprouted = { label: `Sprouted from node ${base}`, status: "complete" } as const;

  if (state === "Growing") {
    return [
      sprouted,
      { label: "Growing: commits are pushed to its repo", status: "active" },
      { label: "Submitted for scoring", status: "pending" },
      { label: "Scored by the root's checks", status: "pending" },
    ];
  }

  if ("Ripening" in state) {
    return [
      sprouted,
      { label: `Submitted at ${short(state.Ripening.commit)}`, status: "complete" },
      { label: "The root's checks are running in a sandbox", status: "active" },
    ];
  }

  if ("Ripe" in state) {
    const { score, commit } = state.Ripe;
    const passes = score.checks_passed === score.checks_total;

    return [
      sprouted,
      { label: `Submitted at ${short(commit)}`, status: "complete" },
      {
        label: `Scored: ${score.checks_passed} of ${score.checks_total} checks pass, a ${score.cost}-line change`,
        status: passes ? "complete" : "error",
      },
      { label: passes ? "Can be harvested" : "Cannot be harvested", status: passes ? "pending" : "error" },
    ];
  }

  if ("Fruit" in state) {
    return [sprouted, { label: "Submitted and scored", status: "complete" }, { label: `Harvested into node ${state.Fruit.node}`, status: "complete" }];
  }

  return [sprouted, { label: `Pruned: ${pruneReason(state.Pruned.reason)}`, status: "error" }];
};
