/**
 * How a released node is deployed: the root's `[deploy]` (scoring.ts
 * `DeploySpec`), run in a sandbox by the Deploy Workflow (src/deploys) when
 * the tree moves its release pointer.
 *
 * The tree starts one Workflow instance per release and keeps a record of
 * it; the Workflow asks a sandbox to deploy the released commit, and the
 * tree reads how that went from the Workflow when asked. Nothing calls the
 * tree back.
 *
 * A deploy that updated Ficus itself (its `deployer` ran) ends with a
 * canary: a fresh scoring container must start and answer for the tools
 * scoring runs (`POST /health`). A canary that fails rolls the release back
 * to the node released before, once (`automaticRollback`).
 */
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { NodeId, Oid } from "./values.ts";

/** What the tree hands the Deploy Workflow: the released node, where its commit lives. */
export const DeployParams = Schema.Struct({
  tree: Schema.String,
  node: NodeId,
  repo: Schema.String,
  commit: Oid,
});

export type DeployParams = typeof DeployParams.Type;

/**
 * Which command of the released commit's `[deploy]` a sandbox runs: `run`
 * (in the deployer), or `deployer` (in a scoring sandbox, once `run` passed).
 */
export const DeployPart = Schema.Literals(["run", "deployer"]);

export type DeployPart = typeof DeployPart.Type;

/** What the Workflow asks a sandbox: deploy `commit` of the repo at `remote`, read with `token`. */
export const DeployRequest = Schema.Struct({
  remote: Schema.String,
  token: Schema.String,
  commit: Oid,
  part: DeployPart,
});

export type DeployRequest = typeof DeployRequest.Type;

/** What the container is told: no credentials, which the sandbox's egress adds. */
export const DeployRef = Schema.Struct({ remote: Schema.String, commit: Oid, part: DeployPart });

export type DeployRef = typeof DeployRef.Type;

/** `ficus-scorer deploy-prepare`: the workdir, whether the root deploys at all, and the hosts its `[deploy]` opens. */
export const DeployPrepared = Schema.Struct({
  workdir: Schema.String,
  /** Whether its `[deploy]` has the part asked for. */
  deploys: Schema.Boolean,
  hosts: Schema.Array(Schema.String),
});

export type DeployPrepared = typeof DeployPrepared.Type;

/** How a deploy went: `deployed` is false when the released commit's `ficus.toml` has no `[deploy]` (or not the part asked for). */
export const DeployReport = Schema.Struct({
  deployed: Schema.Boolean,
  passed: Schema.Boolean,
  millis: Schema.Number,
  /** The end of the command's output: what went wrong, or what it deployed. */
  tail: Schema.String,
});

export type DeployReport = typeof DeployReport.Type;

/** One command the canary runs in a fresh scoring container, and whether it answered as expected. */
export const HealthCheck = Schema.Struct({
  command: Schema.String,
  passed: Schema.Boolean,
  millis: Schema.Number,
  /** The end of what it printed. */
  output: Schema.String,
});

export type HealthCheck = typeof HealthCheck.Type;

/** A sandbox's `POST /health`: a fresh container, started the way scoring starts one, and the tools scoring runs answering in it. */
export const HealthReport = Schema.Struct({
  passed: Schema.Boolean,
  /** How long the container took to start and become ready. */
  start_millis: Schema.Number,
  millis: Schema.Number,
  checks: Schema.Array(HealthCheck),
});

export type HealthReport = typeof HealthReport.Type;

/** What the canary runs, and what each must answer: devenv and bun print a version; `ficus-scorer` alone prints its usage and exits 1. */
export const HEALTH_COMMANDS = [
  { argv: ["devenv", "version"], exit: 0, prints: "devenv" },
  { argv: ["bun", "--version"], exit: 0, prints: "" },
  { argv: ["ficus-scorer"], exit: 1, prints: "usage: ficus-scorer" },
] as const;

export type HealthCommand = (typeof HEALTH_COMMANDS)[number];

/** How much of a command's output a check keeps. */
const HEALTH_OUTPUT_CHARS = 400;

/** Whether `command` answered as expected: its exit code, and its expected words in what it printed. */
export const healthCheck = (command: HealthCommand, ran: { readonly exitCode: number; readonly stdout: string; readonly stderr: string }, millis: number): HealthCheck => {
  const output = `${ran.stdout}${ran.stderr}`.trim();

  return HealthCheck.make({
    command: command.argv.join(" "),
    passed: ran.exitCode === command.exit && output.includes(command.prints) && (command.prints !== "" || output !== ""),
    millis,
    output: output.slice(-HEALTH_OUTPUT_CHARS),
  });
};

/** A health report from its checks: healthy when every one passed. */
export const healthReport = (startMillis: number, millis: number, checks: ReadonlyArray<HealthCheck>): HealthReport =>
  HealthReport.make({ passed: checks.every((check) => check.passed), start_millis: startMillis, millis, checks: [...checks] });

/** One try of the canary: the health report when the sandbox answered, and why it failed when it did. */
export const CanaryTry = Schema.Struct({
  passed: Schema.Boolean,
  millis: Schema.Number,
  reason: Schema.optionalKey(Schema.String),
  health: Schema.optionalKey(HealthReport),
});

export type CanaryTry = typeof CanaryTry.Type;

/** A try from a sandbox's health report: one that is not healthy says which command did not answer. */
export const canaryTry = (health: HealthReport, millis: number): CanaryTry => {
  const failing = health.checks.find((check) => !check.passed);

  return failing === undefined
    ? CanaryTry.make({ passed: true, millis, health })
    : CanaryTry.make({ passed: false, millis, reason: `\`${failing.command}\` did not answer as expected: ${failing.output || "(no output)"}`, health });
};

/** How often the Workflow tries the canary: a container started right after a deploy can be slow. */
export const CANARY_TRIES = 3;

/** How long the Workflow waits before try `n + 1`, doubling from 30 seconds. */
export const canaryWaitMillis = (n: number) => 30_000 * 2 ** (n - 1);

/** The canary's outcome: whether scoring works on the stage just deployed, after how many tries; the last try's reason and health. */
export const CanaryReport = Schema.Struct({
  ...CanaryTry.fields,
  tries: Schema.Number,
});

export type CanaryReport = typeof CanaryReport.Type;

/** The canary's report from its tries, the last one deciding. */
export const canaryReport = (tries: ReadonlyArray<CanaryTry>): CanaryReport => {
  const last = tries.at(-1);
  const millis = tries.reduce((sum, tried) => sum + tried.millis, 0);

  return last === undefined
    ? CanaryReport.make({ passed: false, millis, reason: "the canary never ran", tries: 0 })
    : CanaryReport.make({ ...last, millis, tries: tries.length });
};

/** What a Deploy Workflow instance answers: how `run` went, `deployer` when it ran too, and the canary after it. */
export const DeployOutcome = Schema.Struct({
  ...DeployReport.fields,
  deployer: Schema.optionalKey(DeployReport),
  canary: Schema.optionalKey(CanaryReport),
});

export type DeployOutcome = typeof DeployOutcome.Type;

/** The tree's record of a release's deploy: the Workflow instance that runs it. */
export const DeployRecord = Schema.Struct({
  id: Schema.String,
  node: NodeId,
  commit: Oid,
  started_at: Schema.Number,
  /** The node released before this one; absent on records kept before automatic rollbacks. */
  previous: Schema.optionalKey(Schema.NullOr(NodeId)),
  /** Whether this release moved back to an older node, by hand or automatically: a rollback is never rolled back. */
  rollback: Schema.optionalKey(Schema.Boolean),
  /** The deploy whose failed canary this automatic rollback answers. */
  rollback_of: Schema.optionalKey(Schema.String),
});

export type DeployRecord = typeof DeployRecord.Type;

/** The Workflow instance for the `n`th deploy of a tree: one per release, so a repeated create is refused, not doubled. */
export const deployId = (tree: string, n: number) => `${tree}-deploy-${n}`;

/** How a deploy ended, as the Workflow said: kept once it ended, since a finished instance never changes. */
export const DeployEnding = Schema.Struct({
  status: Schema.Literals(["complete", "errored", "terminated"]),
  report: Schema.optional(DeployOutcome),
  error: Schema.optional(Schema.String),
});

export type DeployEnding = typeof DeployEnding.Type;

/** A Workflow instance's status, as an ending to keep; none while it can still change. */
export const ending = (status: string, report: DeployOutcome | undefined, error: string | undefined): DeployEnding | undefined =>
  Option.getOrUndefined(Schema.decodeUnknownOption(DeployEnding)({ status, report, error }));

/** A failed canary's automatic rollback, as the tree recorded it: where it went, why, and the deploy it started (or why that failed). */
export const RolledBack = Schema.Struct({
  node: NodeId,
  reason: Schema.String,
  deploy: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
});

export type RolledBack = typeof RolledBack.Type;

/** What the tree knows of a deploy when it decides on a rollback: its record, how the Workflow says it went, and any rollback already made. */
export interface DeploySeen {
  readonly node: NodeId;
  readonly previous?: NodeId | null;
  readonly rollback?: boolean;
  readonly status: string;
  readonly report?: DeployOutcome | undefined;
  readonly rolled_back?: RolledBack | undefined;
}

/**
 * Where the tree's newest deploy should roll back to, and why: only when it
 * completed with a failed canary, the release still points at its node, it
 * is not itself a rollback, it has not been rolled back already, and the
 * node released before is another one.
 */
export const automaticRollback = (newest: DeploySeen, released: NodeId | null): { readonly node: NodeId; readonly reason: string } | undefined => {
  const canary = newest.report?.canary;
  const previous = newest.previous ?? null;

  if (newest.status !== "complete" || canary === undefined || canary.passed) {
    return undefined;
  }

  if (newest.rollback === true || newest.rolled_back !== undefined || released !== newest.node || previous === null || previous === newest.node) {
    return undefined;
  }

  return { node: previous, reason: canary.reason ?? "the canary failed" };
};
