/**
 * The tree's scalar values and its error, shared by tree.ts and scoring.ts
 * (which tree.ts imports, so they cannot live there).
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

export const U32_MAX = 4_294_967_295;

export const Id = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: U32_MAX }));

export const NodeId = Id.pipe(Schema.brand("NodeId"));

export type NodeId = typeof NodeId.Type;

export const TaskId = Id.pipe(Schema.brand("TaskId"));

export type TaskId = typeof TaskId.Type;

export const AttemptId = Id.pipe(Schema.brand("AttemptId"));

export type AttemptId = typeof AttemptId.Type;

/** A git object id: 40 hex digits (SHA-1) or 64 (SHA-256), lowercase. */
export const Oid = Schema.String.check(Schema.isPattern(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)).pipe(Schema.brand("Oid"));

export type Oid = typeof Oid.Type;

/** An Artifacts repository name: ASCII letters, digits, `.`, `-` and `_`, at most 63 of them. */
export const RepoName = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,63}$/)).pipe(Schema.brand("RepoName"));

export type RepoName = typeof RepoName.Type;

/**
 * What the checks said about an attempt. Only an attempt that passed every
 * check can be accepted; among those the lowest `cost` wins, then the
 * highest `confidence`: how sure the root's judges were, in thousandths.
 */
export const Score = Schema.Struct({
  checks_passed: Id,
  checks_total: Id,
  cost: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** `null` when the root has no judges; absent from trees stored before judges existed. */
  confidence: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1000 })))),
});

export type Score = typeof Score.Type;

/** Why an operation on the tree was refused. `kind` decides the HTTP status (tree/http.ts). */
export const TreeErrorKind = Schema.Literals([
  "MalformedOid",
  "MalformedRepoName",
  "ImpossibleScore",
  "EmptyIntent",
  "TaskChecks",
  "UnknownTask",
  "UnknownAttempt",
  "UnknownNode",
  "TaskDone",
  "NotWorking",
  "NotChecking",
  "NotOpen",
  "NotBehind",
  "NothingToRebase",
  "Rebasing",
  "NotRebase",
  "NothingToAccept",
  "NothingScored",
  "TaskExhausted",
  "NotReserved",
  "Full",
]);

export type TreeErrorKind = typeof TreeErrorKind.Type;

export class TreeError extends Schema.TaggedError<TreeError>()("Tree.Error", {
  kind: TreeErrorKind,
  message: Schema.String,
}) {}


/** A score of `passed` checks out of `total`, at `cost`; refused when it is not one. */
export const makeScore = (passed: number, total: number, cost: number) =>
  total === 0 || passed > total
    ? Result.fail(new TreeError({ kind: "ImpossibleScore", message: `${passed} of ${total} checks passed is not a score` }))
    : Result.succeed<Score>({ checks_passed: passed, checks_total: total, cost, confidence: null });

/** `score` with the judges' mean confidence, in thousandths (at most 1000). */
export const judged = (score: Score, confidence: number): Score => ({ ...score, confidence: Math.min(1000, confidence) });

/** Whether every check passed. */
export const passes = (score: Score) => score.checks_passed === score.checks_total;
