/**
 * An attempt's standing in its task's race (ficus-core `Standing`), in words, and
 * the case for accepting: which attempt it would take and why. Pure, so tests
 * hold the wording to the rule.
 */
import * as Schema from "effect/Schema";
import type { TaskRace, Standing } from "./answers.ts";
import { closeReason } from "./view.ts";

export type Tone = "winner" | "passing" | "failing" | "behind" | "working" | "checking" | "accepted" | "closed";

export interface Said {
  readonly tone: Tone;
  /** A badge's worth. */
  readonly short: string;
  /** What it means for the person deciding. */
  readonly sentence: string;
}

export const say = (standing: Standing): Said => {
  switch (standing) {
    case "Best":
      return { tone: "winner", short: "ready to accept", sentence: "Passes every check with the smallest change: accepting now takes this attempt." };
    case "Behind":
      return { tone: "behind", short: "behind", sentence: "Started from an older head. It is rebased onto the current head; if that conflicts, retry it." };
    case "Working":
      return { tone: "working", short: "working", sentence: "Being worked on. It is scored once it is submitted." };
    case "Checking":
      return { tone: "checking", short: "checks running", sentence: "Submitted and frozen; the root's checks are running in a sandbox." };
  }

  if ("Outscored" in standing) {
    return {
      tone: "passing",
      short: "passes",
      sentence: `Passes every check, but attempt ${standing.Outscored.by} does it with a smaller change.`,
    };
  }

  if ("Failing" in standing) {
    const { checks_passed: passed, checks_total: total } = standing.Failing;

    return { tone: "failing", short: `fails ${total - passed} of ${total}`, sentence: `Fails ${total - passed} of its ${total} checks, so it cannot be accepted.` };
  }

  if ("Accepted" in standing) {
    return { tone: "accepted", short: "accepted", sentence: `Accepted: it is node ${standing.Accepted.node} of the trunk.` };
  }

  return { tone: "closed", short: "closed", sentence: `Out of the race: ${closeReason(standing.Closed.reason)}.` };
};

const lines = (cost: number) => `${cost} ${cost === 1 ? "line" : "lines"}`;

const isOutscored = Schema.is(Schema.Struct({ Outscored: Schema.Struct({ by: Schema.Number }) }));

/**
 * The case for accepting now: the attempt it would take, said against the next
 * best; undefined when nothing can be accepted yet.
 */
export const acceptCase = (race: TaskRace) => {
  const entries = race.attempts.map(({ attempt, standing, report }) => ({ attempt, standing, cost: report?.cost }));
  const winner = entries.find((entry) => entry.standing === "Best");

  if (winner === undefined || race.task.state !== "Open") {
    return undefined;
  }

  const checks = race.attempts.find((entry) => entry.attempt.id === winner.attempt.id)?.report?.checks.length ?? 0;

  const runnerUp = entries
    .filter((entry) => isOutscored(entry.standing))
    .toSorted((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0];

  const why = `passes all ${checks} checks with a ${winner.cost ?? 0}-line change`;

  return {
    attempt: winner.attempt,
    sentence:
      runnerUp === undefined
        ? `Attempt ${winner.attempt.id} (${winner.attempt.agent}) ${why}.`
        : `Attempt ${winner.attempt.id} (${winner.attempt.agent}) ${why}; the next best, attempt ${runnerUp.attempt.id} (${runnerUp.attempt.agent}), changes ${lines(runnerUp.cost ?? 0)}.`,
  };
};

/** A task's race at a glance: how many attempts stand where, most decisive first. */
export const glance = (race: TaskRace) => {
  const order: ReadonlyArray<Tone> = ["winner", "passing", "checking", "working", "failing", "behind", "accepted", "closed"];
  const counts = new Map<Tone, number>();

  for (const { standing } of race.attempts) {
    const { tone } = say(standing);

    counts.set(tone, (counts.get(tone) ?? 0) + 1);
  }

  return order.flatMap((tone) => {
    const count = counts.get(tone);

    return count === undefined ? [] : [{ tone, count }];
  });
};
