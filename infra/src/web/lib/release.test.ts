import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { Deploys, Tree } from "./answers.ts";
import { deploySteps, deployStatus, deploying, move } from "./release.ts";

const a = "a".repeat(40);

const treeReleasedAt = (released: number | null) =>
  Schema.decodeUnknownSync(Tree)({
    name: "abcdefghij-site",
    head: 2,
    nodes: Object.fromEntries(
      [0, 1, 2].map((id) => [String(id), { id, parent: id === 0 ? null : id - 1, commit: a, repo: "abcdefghij-site", accepted_from: null }]),
    ),
    tasks: {},
    attempts: {},
    history: [],
    released,
  });

/** What a deploy carries beyond its status, as the Api answers it (undecoded). */
interface Finished {
  readonly report?: unknown;
  readonly error?: string;
}

// As `GET .../deploys` answers: a workflow status, and the sandbox's report once it finished.
const deploy = (status: string, extra: Finished = {}) =>
  Schema.decodeUnknownSync(Deploys)({ enabled: true, deploys: [{ id: "t-deploy-1", node: 2, commit: a, started_at: 0, status, ...extra }] })
    .deploys[0]!;

const ran = (passed: boolean, tail = "") => ({ deployed: true, passed, millis: 61_000, tail });

describe("move", () => {
  test("an older node than the released one is a rollback, a newer one a release", () => {
    expect(move(treeReleasedAt(1), 0)).toBe("rollback");
    expect(move(treeReleasedAt(1), 1)).toBe("released");
    expect(move(treeReleasedAt(1), 2)).toBe("release");
  });

  test("before the first release any node is a release", () => {
    expect(move(treeReleasedAt(null), 0)).toBe("release");
  });
});

describe("deployStatus", () => {
  test("an unfinished workflow is deploying", () => {
    expect(deployStatus(deploy("running")).tone).toBe("running");
    expect(deployStatus(deploy("queued")).tone).toBe("running");
    expect(deploying([deploy("complete", { report: ran(true) }), deploy("waiting")])).toBe(true);
  });

  test("a finished deploy reads from its report: deployed, failed with its tail, or nothing to deploy", () => {
    expect(deployStatus(deploy("complete", { report: ran(true) }))).toEqual({ tone: "deployed", label: "deployed in 61 s", tail: undefined });
    expect(deployStatus(deploy("complete", { report: ran(false, "boom") }))).toMatchObject({ tone: "failed", tail: "boom" });
    expect(deployStatus(deploy("complete", { report: { ...ran(true), deployed: false } })).tone).toBe("skipped");
  });

  test("the deployer's part counts: its failure fails the deploy, its time adds up", () => {
    expect(deployStatus(deploy("complete", { report: { ...ran(true), deployer: ran(false, "stale") } }))).toMatchObject({ tone: "failed", tail: "stale" });
    expect(deployStatus(deploy("complete", { report: { ...ran(true), deployer: ran(true) } })).label).toBe("deployed in 122 s");
  });

  test("an errored workflow says why; one never read is unknown", () => {
    expect(deployStatus(deploy("errored", { error: "no sandbox" })).label).toBe("errored: no sandbox");
    expect(deployStatus(deploy("unknown")).tone).toBe("unknown");
    expect(deploying([deploy("errored")])).toBe(false);
  });
});

describe("deploySteps", () => {
  test("a finished deploy is its run, then the deployer's update", () => {
    expect(deploySteps(deploy("complete", { report: { ...ran(true), deployer: ran(true) } }))).toEqual([
      { title: "deploy", detail: "passed in 61 s", tone: "deployed" },
      { title: "update the deployer", detail: "passed in 61 s", tone: "deployed" },
    ]);
  });

  test("a failed run stops there; an unfinished or errored deploy is one step", () => {
    expect(deploySteps(deploy("complete", { report: ran(false) })).map(({ tone }) => tone)).toEqual(["failed"]);
    expect(deploySteps(deploy("running"))).toEqual([{ title: "deploy", detail: "running now", tone: "running" }]);
    expect(deploySteps(deploy("errored", { error: "no sandbox" }))[0]?.tone).toBe("failed");
  });
});
