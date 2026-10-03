/**
 * How a released node is deployed: the root's `[deploy]` (scoring.ts
 * `DeploySpec`), run in a sandbox by the Deploy Workflow (src/deploys) when
 * the tree moves its release pointer.
 *
 * The tree starts one Workflow instance per release and keeps a record of
 * it; the Workflow asks a sandbox to deploy the released commit, and the
 * tree reads how that went from the Workflow when asked. Nothing calls the
 * tree back.
 */
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

/** What the Workflow asks a sandbox: deploy `commit` of the repo at `remote`, read with `token`. */
export const DeployRequest = Schema.Struct({
  remote: Schema.String,
  token: Schema.String,
  commit: Oid,
});

export type DeployRequest = typeof DeployRequest.Type;

/** What the container is told: no credentials, which the sandbox's egress adds. */
export const DeployRef = Schema.Struct({ remote: Schema.String, commit: Oid });

export type DeployRef = typeof DeployRef.Type;

/** `ficus-scorer deploy-prepare`: the workdir, whether the root deploys at all, and the hosts its `[deploy]` opens. */
export const DeployPrepared = Schema.Struct({
  workdir: Schema.String,
  deploys: Schema.Boolean,
  hosts: Schema.Array(Schema.String),
});

export type DeployPrepared = typeof DeployPrepared.Type;

/** How a deploy went: `deployed` is false when the released commit's `ficus.toml` has no `[deploy]`. */
export const DeployReport = Schema.Struct({
  deployed: Schema.Boolean,
  passed: Schema.Boolean,
  millis: Schema.Number,
  /** The end of the command's output: what went wrong, or what it deployed. */
  tail: Schema.String,
});

export type DeployReport = typeof DeployReport.Type;

/** The tree's record of a release's deploy: the Workflow instance that runs it. */
export const DeployRecord = Schema.Struct({
  id: Schema.String,
  node: NodeId,
  commit: Oid,
  started_at: Schema.Number,
});

export type DeployRecord = typeof DeployRecord.Type;

/** The Workflow instance for the `n`th deploy of a tree: one per release, so a repeated create is refused, not doubled. */
export const deployId = (tree: string, n: number) => `${tree}-deploy-${n}`;
