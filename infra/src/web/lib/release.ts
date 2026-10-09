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
    return { tone: "running", label: deploy.status === "running" ? "running now" : deploy.status, tail: undefined };
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

/** One step of a release's Deploy Workflow, as a flow shows it. */
export interface DeployStep {
  readonly title: string;
  readonly detail: string;
  readonly tone: DeployTone;
}

type Report = NonNullable<Deploy["report"]>;

const ranStep = (title: string, report: Pick<Report, "passed" | "millis">): DeployStep => ({
  title,
  detail: `${report.passed ? "passed" : "failed"} in ${seconds(report.millis)}`,
  tone: report.passed ? "deployed" : "failed",
});

/**
 * The Deploy Workflow's steps for one deploy (src/deploys): `run` (the
 * released commit's `[deploy] run`, in the deployer), then, once it passed,
 * `deployer` (its `[deploy] deployer`, in a scoring sandbox). Unfinished or
 * failed before either reported, the whole deploy is one step.
 */
export const deploySteps = (deploy: Deploy): ReadonlyArray<DeployStep> => {
  const { report } = deploy;
  const status = deployStatus(deploy);

  if (report === undefined || deploy.status !== "complete") {
    return [{ title: "deploy", detail: status.label, tone: status.tone }];
  }

  if (!report.deployed) {
    return [{ title: "deploy", detail: "nothing to deploy", tone: "skipped" }];
  }

  const deployer = report.deployer?.deployed === true ? [ranStep("update the deployer", report.deployer)] : [];

  return [ranStep("deploy", report), ...deployer];
};
