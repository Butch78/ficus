/**
 * The root's judges, as the sandbox handles them: what `ficus-scorer check`
 * hands over, the Clef question each judge becomes, and the check outcome
 * its answer makes. Mirrors `crates/ficus-core/src/scoring.rs`.
 */
import * as Decision from "effect/ai/Decision";
import * as Schema from "effect/Schema";

const CheckOutcome = Schema.Struct({
  name: Schema.String,
  origin: Schema.Literals(["root", "task"]),
  passed: Schema.Boolean,
  millis: Schema.Number,
  tail: Schema.String,
  confidence: Schema.optional(Schema.Number),
});

export type CheckOutcome = Schema.Schema.Type<typeof CheckOutcome>;

/** crates/ficus-core `ScoreReport`, checked before it is passed on. */
const ScoreReport = Schema.Struct({
  checks: Schema.Array(CheckOutcome),
  cost: Schema.Number,
  touched: Schema.Array(Schema.String),
});

/** crates/ficus-core `JudgeSpec`. */
const Judge = Schema.Struct({
  name: Schema.String,
  ask: Schema.String,
  yes: Schema.NullOr(Schema.String),
  no: Schema.NullOr(Schema.String),
  pass_at: Schema.NullOr(Schema.Number),
});

export type Judge = Schema.Schema.Type<typeof Judge>;

/** crates/ficus-core `CheckRun`: what `ficus-scorer check` prints. */
export const CheckRun = Schema.Struct({ report: ScoreReport, judges: Schema.Array(Judge), diff: Schema.String });

/** crates/ficus-core `DEFAULT_PASS_AT`. */
const DEFAULT_PASS_AT = 0.5;

/** A judge as a decision; "yes" passes. */
export const decision = (judge: Judge): Decision.Probability =>
  Decision.probability({
    instructions: judge.ask,
    criteria: judge.yes === null || judge.no === null ? undefined : { true: judge.yes, false: judge.no },
  });

/** Every judge of a root, asked of `{ task, diff }` in one call. `judges` must not be empty. */
export const judging = (judges: ReadonlyArray<Judge>) =>
  Decision.make({
    input: Schema.Struct({ task: Schema.String, diff: Schema.String }),
    decisions: Object.fromEntries(judges.map((judge) => [judge.name, decision(judge)])),
  });

/** What a judge's answer did to the attempt, as a check outcome. */
export const judged = (judge: Judge, probability: number, millis: number): CheckOutcome => {
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
