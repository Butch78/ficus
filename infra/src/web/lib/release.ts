/**
 * The release pointer and the deploys that follow it, as they read on a page:
 * plain functions over the decoded shapes, so they test without a Worker.
 */
import type { Deploy, Tree } from "./answers.ts";

/** What releasing `node` would do: nothing (it is released), a release, or a rollback to an older node. */
export type Move = "released" | "release" | "rollback";

/** The same rule as src/core/tree.ts `release`: older than the released node is a rollback. */
export const move = (tree: Tree, node: number): Move => {
  const released = tree.released ?? null;

  if (released === node) {
    return "released";
  }

  return released !== null && node < released ? "rollback" : "release";
};

export type DeployTone = "running" | "deployed" | "failed" | "skipped" | "unknown";

export interface DeployStatus {
  readonly tone: DeployTone;
  readonly label: string;
  /** The end of the failing command's output. */
  readonly tail: string | undefined;
}

/** Workflow statuses of an instance that has not finished. */
const UNFINISHED = new Set(["queued", "running", "waiting", "paused", "waitingForPause"]);

const seconds = (millis: number) => `${Math.round(millis / 1000)} s`;

export const deployStatus = (deploy: Deploy): DeployStatus => {
  if (UNFINISHED.has(deploy.status)) {
    return { tone: "running", label: deploy.status === "running" ? "its [deploy] is running" : deploy.status, tail: undefined };
  }

  if (deploy.status === "errored" || deploy.status === "terminated") {
    return { tone: "failed", label: deploy.error ? `${deploy.status}: ${deploy.error}` : deploy.status, tail: undefined };
  }

  const { report } = deploy;

  if (deploy.status !== "complete" || report === undefined) {
    return { tone: "unknown", label: deploy.status, tail: undefined };
  }

  if (!report.deployed) {
    return { tone: "skipped", label: "nothing to deploy: its ficus.toml has no [deploy]", tail: undefined };
  }

  if (!report.passed) {
    return { tone: "failed", label: `deploy failed after ${seconds(report.millis)}`, tail: report.tail };
  }

  if (report.deployer !== undefined && report.deployer.deployed && !report.deployer.passed) {
    return { tone: "failed", label: "deployed; updating the deployer failed", tail: report.deployer.tail };
  }

  const millis = report.millis + (report.deployer?.millis ?? 0);

  return { tone: "deployed", label: `deployed in ${seconds(millis)}`, tail: undefined };
};

/** Whether any deploy is still going, so the page keeps refreshing; none are when they are not shown. */
export const deploying = (deploys: ReadonlyArray<Deploy> | undefined) => (deploys ?? []).some((deploy) => deployStatus(deploy).tone === "running");
