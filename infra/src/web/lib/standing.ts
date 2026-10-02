/**
 * A leaf's standing in its bud's race (ficus-core `Standing`), in words, and
 * the case for a harvest: which leaf it would take and why. Pure, so tests
 * hold the wording to the rule.
 */
import * as Schema from "effect/Schema";
import type { BudRace, Standing } from "./answers.ts";
import { pruneReason } from "./view.ts";

export type Tone = "winner" | "passing" | "failing" | "stale" | "growing" | "ripening" | "fruit" | "pruned";

export interface Said {
  readonly tone: Tone;
  /** A badge's worth. */
  readonly short: string;
  /** What it means for the person deciding. */
  readonly sentence: string;
}

export const say = (standing: Standing): Said => {
  switch (standing) {
    case "Winner":
      return { tone: "winner", short: "ready to harvest", sentence: "Passes every check with the smallest change: a harvest takes this leaf." };
    case "Stale":
      return { tone: "stale", short: "stale", sentence: "Grew from an older head. It cannot be harvested; regrow it on the current head." };
    case "Growing":
      return { tone: "growing", short: "growing", sentence: "Being worked on. It is scored once it is submitted." };
    case "Ripening":
      return { tone: "ripening", short: "checks running", sentence: "Submitted and frozen; the root's checks are running in a sandbox." };
  }

  if ("Outscored" in standing) {
    return {
      tone: "passing",
      short: "passes",
      sentence: `Passes every check, but leaf ${standing.Outscored.by} does it with a smaller change.`,
    };
  }

  if ("Failing" in standing) {
    const { checks_passed: passed, checks_total: total } = standing.Failing;

    return { tone: "failing", short: `fails ${total - passed} of ${total}`, sentence: `Fails ${total - passed} of its ${total} checks, so it cannot be harvested.` };
  }

  if ("Fruit" in standing) {
    return { tone: "fruit", short: "fruit", sentence: `Harvested: it is node ${standing.Fruit.node} of the trunk.` };
  }

  return { tone: "pruned", short: "pruned", sentence: `Out of the race: ${pruneReason(standing.Pruned.reason)}.` };
};

const lines = (cost: number) => `${cost} ${cost === 1 ? "line" : "lines"}`;

const isOutscored = Schema.is(Schema.Struct({ Outscored: Schema.Struct({ by: Schema.Number }) }));

/**
 * The case for harvesting now: the leaf it would take, said against the next
 * best; undefined when nothing can be harvested yet.
 */
export const harvestCase = (race: BudRace) => {
  const entries = race.leaves.map(({ leaf, standing, report }) => ({ leaf, standing, cost: report?.cost }));
  const winner = entries.find((entry) => entry.standing === "Winner");

  if (winner === undefined || race.bud.state !== "Open") {
    return undefined;
  }

  const checks = race.leaves.find((entry) => entry.leaf.id === winner.leaf.id)?.report?.checks.length ?? 0;

  const runnerUp = entries
    .filter((entry) => isOutscored(entry.standing))
    .toSorted((a, b) => (a.cost ?? 0) - (b.cost ?? 0))[0];

  const why = `passes all ${checks} checks with a ${winner.cost ?? 0}-line change`;

  return {
    leaf: winner.leaf,
    sentence:
      runnerUp === undefined
        ? `Leaf ${winner.leaf.id} (${winner.leaf.agent}) ${why}.`
        : `Leaf ${winner.leaf.id} (${winner.leaf.agent}) ${why}; the next best, leaf ${runnerUp.leaf.id} (${runnerUp.leaf.agent}), changes ${lines(runnerUp.cost ?? 0)}.`,
  };
};

/** A bud's race at a glance: how many leaves stand where, most decisive first. */
export const glance = (race: BudRace) => {
  const order: ReadonlyArray<Tone> = ["winner", "passing", "ripening", "growing", "failing", "stale", "fruit", "pruned"];
  const counts = new Map<Tone, number>();

  for (const { standing } of race.leaves) {
    const { tone } = say(standing);

    counts.set(tone, (counts.get(tone) ?? 0) + 1);
  }

  return order.flatMap((tone) => {
    const count = counts.get(tone);

    return count === undefined ? [] : [{ tone, count }];
  });
};
