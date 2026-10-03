/**
 * The root's judges, as the sandbox handles them: the Clef question each
 * judge in `ficus-scorer check`'s CheckRun becomes, and the check outcome its
 * answer makes. The schemas are core's (src/core/scoring.ts).
 */
import * as Decision from "effect/ai/Decision";
import * as Schema from "effect/Schema";
import { type CheckOutcome, DEFAULT_PASS_AT, type JudgeSpec } from "../core/scoring.ts";

export { CheckRun, type CheckOutcome } from "../core/scoring.ts";

/** A judge as a decision; "yes" passes. */
export const decision = (judge: JudgeSpec): Decision.Probability =>
  Decision.probability({
    instructions: judge.ask,
    criteria: judge.yes === undefined || judge.no === undefined ? undefined : { true: judge.yes, false: judge.no },
  });

/** Every judge of a root, asked of `{ task, diff }` in one call. `judges` must not be empty. */
export const judging = (judges: ReadonlyArray<JudgeSpec>) =>
  Decision.make({
    input: Schema.Struct({ task: Schema.String, diff: Schema.String }),
    decisions: Object.fromEntries(judges.map((judge) => [judge.name, decision(judge)])),
  });

/** What a judge's answer did to the attempt, as a check outcome. */
export const judged = (judge: JudgeSpec, probability: number, millis: number): CheckOutcome => {
  const passAt = judge.pass_at ?? DEFAULT_PASS_AT;

  return {
    name: judge.name,
    origin: "root",
    passed: probability >= passAt,
    millis,
    tail: `Clef answered yes with probability ${probability.toFixed(2)}; this judge passes at ${passAt.toFixed(2)}.`,
    confidence: Math.round(probability * 1000),
  };
};
