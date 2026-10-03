/**
 * How the tree Worker answers: JSON for what it knows, plain text with a
 * status for what it refuses, the same as the Rust Worker answered.
 */
import * as Schema from "effect/Schema";
import type { BrowseError } from "../core/browse.ts";
import type { TreeError, TreeErrorKind } from "../core/values.ts";
import { type ArtifactsError, statusOf } from "./artifacts.ts";

/** A refusal: a status and the reason, as text. */
export class Refused extends Schema.TaggedError<Refused>()("Tree.Refused", {
  status: Schema.Number,
  message: Schema.String,
}) {}

export const refuse = (status: number, message: string) => new Refused({ status, message });

export const json = <A>(body: A, status = 200) => Response.json(body, { status });

export const text = (message: string, status: number) => new Response(message, { status });

const TREE_STATUS: Readonly<Record<TreeErrorKind, number>> = {
  MalformedOid: 400,
  MalformedRepoName: 400,
  ImpossibleScore: 400,
  EmptyIntent: 400,
  TaskChecks: 400,
  UnknownTask: 404,
  UnknownAttempt: 404,
  UnknownNode: 404,
  NotReserved: 409,
  TaskDone: 409,
  NotWorking: 409,
  NotChecking: 409,
  NotOpen: 409,
  NotBehind: 409,
  NothingToRebase: 409,
  Rebasing: 409,
  NotRebase: 409,
  NothingToAccept: 409,
  NothingScored: 409,
  TaskExhausted: 409,
  Full: 507,
};

export const treeRefused = (error: TreeError) => refuse(TREE_STATUS[error.kind], error.message);

export const artifactsRefused = (error: ArtifactsError) => refuse(statusOf(error), `Artifacts ${error.code}: ${error.message}`);

export const browseRefused = (error: BrowseError) => refuse(400, error.message);

/** The answer a refusal makes. */
export const answerRefused = (refused: Refused) => text(refused.message, refused.status);
