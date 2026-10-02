import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { BudRace, type LeafState } from "./answers.ts";
import { glance, harvestCase, say } from "./standing.ts";

const a = "a".repeat(40);

const leaf = (id: number, agent: string, state: LeafState) => ({ id, bud: 1, agent, base: 0, repo: `t-l${id}`, state });

const report = (cost: number, passed: ReadonlyArray<boolean>) => ({
  cost,
  checks: passed.map((ok, index) => ({ name: `check${index}`, passed: ok, millis: 10, tail: "" })),
});

// GET .../buds/1, as the tree Worker answers mid-race (serde's shapes).
const race = Schema.decodeUnknownSync(BudRace)({
  bud: { id: 1, intent: "slugify should drop punctuation", state: "Open" },
  head: 0,
  leaves: [
    { leaf: leaf(2, "alpha", { Ripe: { commit: a, score: { checks_passed: 2, checks_total: 2, cost: 12 } } }), standing: { Outscored: { by: 4 } }, report: report(12, [true, true]) },
    { leaf: leaf(3, "cheater", { Ripe: { commit: a, score: { checks_passed: 1, checks_total: 2, cost: 1 } } }), standing: { Failing: { checks_passed: 1, checks_total: 2 } }, report: report(1, [true, false]) },
    { leaf: leaf(4, "beta", { Ripe: { commit: a, score: { checks_passed: 2, checks_total: 2, cost: 2 } } }), standing: "Winner", report: report(2, [true, true]) },
    { leaf: leaf(5, "gamma", "Growing"), standing: "Growing", report: null },
  ],
  compost: [],
});

describe("harvestCase", () => {
  test("names the leaf a harvest takes, against the next best", () => {
    expect(harvestCase(race)?.leaf.id).toBe(4);
    expect(harvestCase(race)).toMatchObject({
      sentence: "Leaf 4 (beta) passes all 2 checks with a 2-line change; the next best, leaf 2 (alpha), changes 12 lines.",
    });
  });

  test("is undefined until something passes, and once the bud has fruited", () => {
    expect(harvestCase({ ...race, leaves: race.leaves.filter(({ standing }) => standing !== "Winner") })).toBeUndefined();
    expect(harvestCase({ ...race, bud: { ...race.bud, state: { Fruited: { leaf: 4, node: 1 } } } })).toBeUndefined();
  });
});

describe("say", () => {
  test("puts each standing in words", () => {
    expect(say("Winner").short).toBe("ready to harvest");
    expect(say({ Failing: { checks_passed: 1, checks_total: 3 } }).sentence).toBe("Fails 2 of its 3 checks, so it cannot be harvested.");
    expect(say({ Outscored: { by: 4 } }).sentence).toContain("leaf 4");
    expect(say({ Pruned: { reason: { Outgrown: { by: 4 } } } }).sentence).toBe("Out of the race: outgrown by leaf 4.");
  });
});

describe("glance", () => {
  test("counts the race, most decisive first", () => {
    expect(glance(race)).toEqual([
      { tone: "winner", count: 1 },
      { tone: "passing", count: 1 },
      { tone: "growing", count: 1 },
      { tone: "failing", count: 1 },
    ]);
  });
});
