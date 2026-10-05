import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { TaskRace, type AttemptState } from "./answers.ts";
import { glance, acceptCase, say } from "./standing.ts";

const a = "a".repeat(40);

const attempt = (id: number, agent: string, state: AttemptState) => ({ id, task: 1, agent, base: 0, repo: `t-a${id}`, state });

const report = (cost: number, passed: ReadonlyArray<boolean>) => ({
  cost,
  checks: passed.map((ok, index) => ({ name: `check${index}`, passed: ok, millis: 10, tail: "" })),
});

// GET .../tasks/1, as the tree Worker answers mid-race (the stored shapes).
const race = Schema.decodeUnknownSync(TaskRace)({
  task: { id: 1, intent: "slugify should drop punctuation", state: "Open" },
  head: 0,
  attempts: [
    { attempt: attempt(2, "alpha", { Scored: { commit: a, score: { checks_passed: 2, checks_total: 2, cost: 12 } } }), standing: { Outscored: { by: 4 } }, report: report(12, [true, true]) },
    { attempt: attempt(3, "cheater", { Scored: { commit: a, score: { checks_passed: 1, checks_total: 2, cost: 1 } } }), standing: { Failing: { checks_passed: 1, checks_total: 2 } }, report: report(1, [true, false]) },
    { attempt: attempt(4, "beta", { Scored: { commit: a, score: { checks_passed: 2, checks_total: 2, cost: 2 } } }), standing: "Best", report: report(2, [true, true]) },
    { attempt: attempt(5, "gamma", "Working"), standing: "Working", report: null },
  ],
  history: [],
});

describe("acceptCase", () => {
  test("names the attempt an acceptance takes, against the next best", () => {
    expect(acceptCase(race)?.attempt.id).toBe(4);
    expect(acceptCase(race)).toMatchObject({
      sentence: "Attempt 4 (beta) passes all 2 checks with a 2-line change; the next best, attempt 2 (alpha), changes 12 lines.",
    });
  });

  test("is undefined until something passes, and once the task has fruited", () => {
    expect(acceptCase({ ...race, attempts: race.attempts.filter(({ standing }) => standing !== "Best") })).toBeUndefined();
    expect(acceptCase({ ...race, task: { ...race.task, state: { Done: { attempt: 4, node: 1 } } } })).toBeUndefined();
  });
});

describe("say", () => {
  test("puts each standing in words", () => {
    expect(say("Best").short).toBe("ready to accept");
    expect(say({ Failing: { checks_passed: 1, checks_total: 3 } }).sentence).toBe("Fails 2 of its 3 checks, so it cannot be accepted.");
    expect(say({ Outscored: { by: 4 } }).sentence).toContain("attempt 4");
    expect(say({ Closed: { reason: { Lost: { to: 4 } } } }).sentence).toBe("Out of the race: lost to attempt 4.");
  });
});

describe("glance", () => {
  test("counts the race, most decisive first", () => {
    expect(glance(race)).toEqual([
      { tone: "winner", count: 1 },
      { tone: "passing", count: 1 },
      { tone: "working", count: 1 },
      { tone: "failing", count: 1 },
    ]);
  });
});
