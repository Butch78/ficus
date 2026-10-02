import { describe, expect, test } from "bun:test";
import { BLOCK_AT, clip, DIFF, DIFF_CHARS, effort, MECHANICAL_AT, objections, PLAN } from "./gates.ts";

const yes = (probability: number) => ({ probability });

/** Answers to PLAN: the three doubts, and the route with `mechanical` as the mechanical probability. */
const planAnswers = (doubts: { vague?: number; offTask?: number; beyond?: number }, mechanical = 0.5) => ({
  plan_vague: yes(doubts.vague ?? 0),
  plan_off_task: yes(doubts.offTask ?? 0),
  plan_beyond_task: yes(doubts.beyond ?? 0),
  change_effort: {
    label: mechanical >= 0.5 ? ("mechanical" as const) : ("reasoning" as const),
    probabilities: { mechanical, reasoning: 1 - mechanical },
  },
});

describe("objections", () => {
  test("keeps yes answers at or above BLOCK_AT, most probable first, in the question's words", () => {
    const found = objections(PLAN.decisions, planAnswers({ vague: BLOCK_AT, offTask: 0.95, beyond: BLOCK_AT - 0.01 }));

    expect(found).toEqual([
      { question: "plan_off_task", probability: 0.95, meaning: PLAN.decisions.plan_off_task.criteria?.true ?? "" },
      { question: "plan_vague", probability: BLOCK_AT, meaning: PLAN.decisions.plan_vague.criteria?.true ?? "" },
    ]);
  });

  test("skips the route, which is not a doubt, whatever it answers", () => {
    expect(objections(PLAN.decisions, planAnswers({}, 1))).toEqual([]);
  });

  test("reads the diff gate's doubts the same way", () => {
    const answers = { diff_off_task: yes(0), diff_unrelated: yes(0), diff_weakens_tests: yes(0.9), diff_vacuous_test: yes(0.2) };

    expect(objections(DIFF.decisions, answers).map((objection) => objection.question)).toEqual(["diff_weakens_tests"]);
  });
});

describe("effort", () => {
  test("is mechanical only when Clef is at least MECHANICAL_AT sure", () => {
    expect(effort(planAnswers({}, MECHANICAL_AT))).toBe("mechanical");
    expect(effort(planAnswers({}, MECHANICAL_AT - 0.01))).toBe("reasoning");
  });
});

describe("clip", () => {
  test("leaves a diff within DIFF_CHARS alone", () => {
    expect(clip("+a\n-b\n")).toBe("+a\n-b\n");
  });

  test("cuts a long diff at a line end and says how long it was", () => {
    const line = `+${"x".repeat(99)}\n`;
    const diff = line.repeat(Math.ceil(DIFF_CHARS / line.length) + 10);
    const clipped = clip(diff);

    expect(clipped.length).toBeLessThan(DIFF_CHARS + 100);
    expect(clipped).toEndWith(`\n[diff truncated: ${diff.length} characters in all]`);
    expect(clipped.split("\n").slice(0, -1).every((each) => each === line.trimEnd())).toBe(true);
  });
});
