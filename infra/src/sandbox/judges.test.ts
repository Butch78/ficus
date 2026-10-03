import { describe, expect, test } from "bun:test";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { CheckRun, decision, judged, judging } from "./judges.ts";

const judge = { name: "does_the_task", ask: "Does `diff` do `task`?" };

describe("decision", () => {
  test("asks the judge's question, with its criteria when it has them", () => {
    expect(Predicate.isTagged(decision(judge), "Probability")).toBe(true);
    expect(decision(judge)).toMatchObject({ instructions: judge.ask, criteria: undefined });
    expect(decision({ ...judge, yes: "done", no: "not done" }).criteria).toEqual({ true: "done", false: "not done" });
  });

  test("asks every judge in one definition, keyed by name", () => {
    expect(Object.keys(judging([judge, { ...judge, name: "tidy" }]).decisions)).toEqual(["does_the_task", "tidy"]);
  });
});

describe("judged", () => {
  test("passes at the default 0.5 and records the confidence in thousandths", () => {
    expect(judged(judge, 0.5, 40)).toMatchObject({ name: "does_the_task", passed: true, millis: 40, confidence: 500 });
    expect(judged(judge, 0.4999, 40)).toMatchObject({ passed: false, confidence: 500 });
  });

  test("passes at the judge's own pass_at", () => {
    expect(judged({ ...judge, pass_at: 0.8 }, 0.79, 1).passed).toBe(false);
    expect(judged({ ...judge, pass_at: 0.8 }, 0.8, 1).passed).toBe(true);
  });
});

describe("CheckRun", () => {
  test("decodes what `ficus-scorer check` prints: a judge without criteria or pass_at leaves them out", () => {
    const printed = { report: { checks: [], cost: 3, touched: ["a.ts"] }, judges: [judge], diff: "+x" };

    expect(Schema.decodeUnknownSync(CheckRun)(JSON.parse(JSON.stringify(printed))).judges).toEqual([judge]);
  });
});
