/**
 * An attempt's life so far, as the steps it has been through and the ones still
 * ahead of it. Pure, so it tests without a page.
 */
import type { StepStatus } from "../components/elements/chain-of-thought.tsx";
import type { AttemptState } from "./answers.ts";
import { closeReason, short } from "./view.ts";

export interface Moment {
  readonly label: string;
  readonly status: StepStatus;
}

export const timeline = (state: AttemptState, base: number): ReadonlyArray<Moment> => {
  const started = { label: `Sprouted from node ${base}`, status: "complete" } as const;

  if (state === "Working") {
    return [
      started,
      { label: "Working: commits are pushed to its repo", status: "active" },
      { label: "Submitted for scoring", status: "pending" },
      { label: "Scored by the root's checks", status: "pending" },
    ];
  }

  if ("Checking" in state) {
    return [
      started,
      { label: `Submitted at ${short(state.Checking.commit)}`, status: "complete" },
      { label: "The root's checks are running in a sandbox", status: "active" },
    ];
  }

  if ("Scored" in state) {
    const { score, commit } = state.Scored;
    const passes = score.checks_passed === score.checks_total;

    return [
      started,
      { label: `Submitted at ${short(commit)}`, status: "complete" },
      {
        label: `Scored: ${score.checks_passed} of ${score.checks_total} checks pass, a ${score.cost}-line change`,
        status: passes ? "complete" : "error",
      },
      { label: passes ? "Can be accepted" : "Cannot be accepted", status: passes ? "pending" : "error" },
    ];
  }

  if ("Accepted" in state) {
    return [started, { label: "Submitted and scored", status: "complete" }, { label: `Accepted into node ${state.Accepted.node}`, status: "complete" }];
  }

  return [started, { label: `Closed: ${closeReason(state.Closed.reason)}`, status: "error" }];
};
