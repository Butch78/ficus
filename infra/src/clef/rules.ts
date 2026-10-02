/**
 * The judgement half of the anti-slop rules: what oxlint cannot decide from
 * an AST, asked of Clef instead. Each question is one narrow yes/no
 * judgement over `{ path, source }`, and "yes" always means "slop".
 */
import type { Answers, NoulQuestion } from "./clef.ts";

export const RULES = {
  comment_restates_code: {
    type: "noul",
    instructions:
      "Does `source` contain a comment or doc comment that only restates what the code next to it already says, such as `// increment the counter` above `count++` or `/** Returns the name. */` above `getName()`?",
    criteria: {
      true: "At least one comment carries no information beyond its own line of code.",
      false: "Every comment explains a reason, an invariant, a pitfall or context the code cannot show, or there are no comments.",
    },
  },
  swallowed_failure: {
    type: "noul",
    instructions:
      "Does `source` discard an Effect failure without saying why: `Effect.orDie`, `Effect.ignore`, a catch handler that returns `Effect.void` or a default value, with no nearby comment explaining why that failure cannot matter?",
    criteria: {
      true: "A failure is dropped or turned into a default or a defect, and nothing says why that is safe.",
      false: "Failures stay in the error channel, or every place that drops one says why.",
    },
  },
  unparsed_boundary: {
    type: "noul",
    instructions:
      "Does `source` rely on the structure of data from outside the program (an HTTP response, `JSON.parse`, environment variables, a file, command-line arguments) without first decoding it through an Effect `Schema` or `Config`?",
    criteria: {
      true: "Outside data is read by property access or cast before any schema or Config has checked it.",
      false: "Outside data is decoded at the boundary, or the file reads no outside data.",
    },
  },
  vacuous_test: {
    type: "noul",
    instructions:
      "Does `source` contain a test that cannot fail: no assertion at all, an assertion of a literal against itself, or `expect(true)`-style checks?",
    criteria: {
      true: "At least one test passes regardless of what the code under test does.",
      false: "Every test can fail when the behaviour it covers breaks, or the file has no tests.",
    },
  },
} as const satisfies Record<string, NoulQuestion>;

export type RuleId = keyof typeof RULES;

/**
 * Starting thresholds, not calibrated ones: nothing has measured Clef on
 * this codebase yet. Above BLOCK_AT a finding fails the review; between the
 * two it is printed as advice.
 */
export const BLOCK_AT = 0.8;

export const ADVISE_AT = 0.5;

export interface Finding {
  readonly path: string;
  readonly rule: RuleId;
  readonly probability: number;
  readonly blocking: boolean;
}

/** The findings in `answers`, most probable first. */
export const findingsOf = (path: string, answers: Answers): ReadonlyArray<Finding> => {
  const findings: Array<Finding> = [];

  // SAFETY: RULES is a const object literal, so its own keys are exactly RuleId.
  for (const rule of Object.keys(RULES) as Array<RuleId>) {
    const probability = answers[rule];

    if (probability !== undefined && probability >= ADVISE_AT) {
      findings.push({ path, rule, probability, blocking: probability >= BLOCK_AT });
    }
  }

  return findings.sort((a, b) => b.probability - a.probability);
};
