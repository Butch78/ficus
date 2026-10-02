/**
 * Clef on an agent's two handovers:
 *
 * - the plan gate, before `plan_change` hands the conversation over: is the
 *   plan concrete and on task? Asked together with the route question,
 *   which picks the model that makes the change.
 * - the diff gate, before `submit` freezes the attempt: does the diff do
 *   the task, and only the task, without weakening a test?
 *
 * Every gate question is phrased so that "yes" is the problem, as in
 * `clef/rules.ts`. A gate is advice ahead of scoring, not the score: after
 * `MAX_REJECTIONS` the agent's call goes through with Clef's objections
 * attached, and the root's checks decide.
 */
import * as Decision from "effect/ai/Decision";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";

/** A gate objects when Clef gives a problem at least this probability. */
export const BLOCK_AT = 0.7;

/** Times a gate turns a call back before it lets the next one through. */
export const MAX_REJECTIONS = 2;

/** The change goes to the light model only when Clef is at least this sure it is mechanical. */
export const MECHANICAL_AT = 0.75;

/** Diff characters Clef sees; Clef's context is 65,536 tokens, shared with the task and plan. */
export const DIFF_CHARS = 120_000;

/** Doubts about `{ task, plan }`. */
const PLAN_DOUBTS = {
  plan_vague: Decision.probability({
    instructions: "Does `plan` leave the change unspecified: no file named, or no concrete description of what changes in each file?",
    criteria: {
      true: "The plan does not say which files change and how.",
      false: "The plan names the files and the edits to make in them.",
    },
  }),
  plan_off_task: Decision.probability({
    instructions: "Would carrying out `plan` fail to do what `task` asks, in whole or in part, or do something else instead?",
    criteria: {
      true: "The plan misses part of the task, or solves a different problem.",
      false: "Carrying out the plan does the whole task.",
    },
  }),
  plan_beyond_task: Decision.probability({
    instructions:
      "Does `plan` include changes `task` does not need: refactoring, reformatting, renames, or fixes to unrelated code?",
    criteria: {
      true: "The plan changes more than the task needs.",
      false: "Every change in the plan serves the task.",
    },
  }),
};

/** Asked of `{ task, plan }`, with the plan gate. */
const ROUTE = {
  change_effort: Decision.classify({
    instructions: "How much reasoning does carrying out `plan` take?",
    criteria: {
      mechanical: "Small, fully specified edits: following the plan needs no design decisions and no debugging.",
      reasoning: "Design decisions, debugging, or edits the plan attempts open.",
    },
  }),
};

/** The plan gate and the route, in one Clef call. */
export const PLAN = Decision.make({
  input: Schema.Struct({ task: Schema.String, plan: Schema.String }),
  decisions: { ...PLAN_DOUBTS, ...ROUTE },
});

/** Doubts about `{ task, plan, diff }`. */
const DIFF_DOUBTS = {
  diff_off_task: Decision.probability({
    instructions: "Does `diff` fail to do what `task` asks, in whole or in part?",
    criteria: {
      true: "Part of the task is not done by the diff, or is done wrong.",
      false: "The diff does the whole task.",
    },
  }),
  diff_unrelated: Decision.probability({
    instructions:
      "Does `diff` change anything `task` does not need: reformatting, renames, refactors, unrelated fixes, or leftover debugging?",
    criteria: {
      true: "The diff changes lines the task does not need.",
      false: "Every changed line serves the task.",
    },
  }),
  diff_weakens_tests: Decision.probability({
    instructions:
      "Does `diff` delete, skip, or loosen an existing test or assertion, or otherwise make a check easier to pass instead of fixing the code?",
    criteria: {
      true: "A test or assertion was weakened to get the checks to pass.",
      false: "No existing test or assertion was weakened.",
    },
  }),
  diff_vacuous_test: Decision.probability({
    instructions: "Does `diff` add a test that cannot fail: no assertion, or an assertion that holds whatever the code does?",
    criteria: {
      true: "The diff adds at least one test that passes regardless of the code under test.",
      false: "Every test the diff adds can fail, or it adds none.",
    },
  }),
};

/** The diff gate. */
export const DIFF = Decision.make({
  input: Schema.Struct({ task: Schema.String, plan: Schema.String, diff: Schema.String }),
  decisions: DIFF_DOUBTS,
});

export interface Objection {
  readonly question: string;
  readonly probability: number;
  /** What a yes means, in the question's words. */
  readonly meaning: string;
}

/**
 * The doubts in `decisions` Clef answered yes to at `BLOCK_AT` or above,
 * most probable first. Decisions other than probabilities (the route) are
 * not doubts and are skipped.
 */
export const objections = (
  decisions: Readonly<Record<string, Decision.Any>>,
  answers: Readonly<Record<string, Decision.Answer<Decision.Any>>>,
): ReadonlyArray<Objection> =>
  Object.entries(decisions)
    .flatMap(([question, decision]) => {
      const answer = answers[question];

      if (!Predicate.isTagged(decision, "Probability") || answer === undefined || !("probability" in answer)) {
        return [];
      }

      return answer.probability >= BLOCK_AT
        ? [{ question, probability: answer.probability, meaning: decision.criteria?.true ?? decision.instructions }]
        : [];
    })
    .toSorted((a, b) => b.probability - a.probability);

/** Objections as the agent reads them in a tool result. */
export const describe = (found: ReadonlyArray<Objection>): string =>
  found.map((objection) => `- ${objection.meaning} (${objection.question}, ${objection.probability.toFixed(2)})`).join("\n");

export type Effort = "mechanical" | "reasoning";

/** Mechanical only when Clef is sure; a doubtful plan gets the stronger model. */
export const effort = (answers: Decision.Answers<typeof PLAN.decisions>): Effort =>
  answers.change_effort.probabilities.mechanical >= MECHANICAL_AT ? "mechanical" : "reasoning";

/** The first `DIFF_CHARS` of `diff`, cut at a line end, marked when cut. */
export const clip = (diff: string): string => {
  if (diff.length <= DIFF_CHARS) {
    return diff;
  }

  const cut = diff.lastIndexOf("\n", DIFF_CHARS);

  return `${diff.slice(0, cut === -1 ? DIFF_CHARS : cut)}\n[diff truncated: ${diff.length} characters in all]`;
};
