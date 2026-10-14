import { describe, expect, test } from "bun:test";
import { automaticRollback, CANARY_TRIES, canaryReport, canaryTry, canaryWaitMillis, type DeploySeen, ending, HEALTH_COMMANDS, healthCheck, healthReport } from "./deploy.ts";
import { NodeId } from "./values.ts";

const report = { deployed: true, passed: true, millis: 5000, tail: "done" };

describe("ending", () => {
  test("a finished deploy is kept as it ended: complete with its report, or why it errored", () => {
    expect(ending("complete", report, undefined)).toEqual({ status: "complete", report, error: undefined });
    expect(ending("errored", undefined, "no sandbox")).toMatchObject({ status: "errored", error: "no sandbox" });
    expect(ending("terminated", undefined, undefined)?.status).toBe("terminated");
  });

  test("one still going is not kept: it can change", () => {
    for (const status of ["queued", "running", "waiting", "paused", "unknown"]) {
      expect(ending(status, undefined, undefined)).toBeUndefined();
    }
  });
});

const [devenv, bun, scorer] = HEALTH_COMMANDS;

describe("healthCheck", () => {
  test("each command answers as expected: devenv and bun a version, ficus-scorer its usage with exit 1", () => {
    expect(healthCheck(devenv, { exitCode: 0, stdout: "devenv 1.9.1 (x86_64-linux)\n", stderr: "" }, 40).passed).toBe(true);
    expect(healthCheck(bun, { exitCode: 0, stdout: "1.4.2\n", stderr: "" }, 10).passed).toBe(true);
    expect(healthCheck(scorer, { exitCode: 1, stdout: "", stderr: "usage: ficus-scorer prepare ..." }, 90)).toMatchObject({ command: "ficus-scorer", passed: true });
  });

  test("a missing tool, a crash or silence fails", () => {
    expect(healthCheck(bun, { exitCode: 127, stdout: "", stderr: "bun: not found" }, 5).passed).toBe(false);
    expect(healthCheck(bun, { exitCode: 0, stdout: "", stderr: "" }, 5).passed).toBe(false);
    expect(healthCheck(scorer, { exitCode: 1, stdout: "", stderr: "error: Cannot find module" }, 5).passed).toBe(false);
    expect(healthCheck(scorer, { exitCode: 0, stdout: "usage: ficus-scorer", stderr: "" }, 5).passed).toBe(false);
  });
});

const healthy = healthReport(20_000, 21_000, [
  healthCheck(devenv, { exitCode: 0, stdout: "devenv 1.9.1", stderr: "" }, 300),
  healthCheck(bun, { exitCode: 0, stdout: "1.4.2", stderr: "" }, 50),
]);

const sick = healthReport(20_000, 20_500, [healthCheck(bun, { exitCode: 127, stdout: "", stderr: "bun: not found" }, 5)]);

describe("canary", () => {
  test("a try passes on a healthy report and names the failing command otherwise", () => {
    expect(canaryTry(healthy, 22_000)).toMatchObject({ passed: true, health: healthy });
    expect(canaryTry(sick, 21_000)).toMatchObject({ passed: false, reason: "`bun --version` did not answer as expected: bun: not found" });
  });

  test("the last try decides; the report counts the tries and their time", () => {
    const failed = { passed: false, millis: 1000, reason: "the sandbox answered 503: not ready" };

    expect(canaryReport([failed, canaryTry(healthy, 22_000)])).toMatchObject({ passed: true, tries: 2, millis: 23_000 });
    expect(canaryReport([failed, failed, failed])).toMatchObject({ passed: false, tries: 3, reason: failed.reason });
    expect(canaryReport([]).passed).toBe(false);
  });

  test("tries wait longer each time", () => {
    expect(CANARY_TRIES).toBeGreaterThan(1);
    expect([1, 2].map(canaryWaitMillis)).toEqual([30_000, 60_000]);
  });
});

const node = (id: number) => NodeId.make(id);

const canaryFailed = { ...report, canary: { passed: false, millis: 1000, tries: 3, reason: "no container" } };

const newest: DeploySeen = { node: node(12), previous: node(9), rollback: false, status: "complete", report: canaryFailed };

describe("automaticRollback", () => {
  test("a failed canary rolls the release back to the node released before", () => {
    expect(automaticRollback(newest, node(12))).toEqual({ node: node(9), reason: "no container" });
  });

  test("nothing to roll back when the canary passed, did not run, or the deploy has not completed", () => {
    expect(automaticRollback({ ...newest, report: { ...report, canary: { passed: true, millis: 1000, tries: 1 } } }, node(12))).toBeUndefined();
    expect(automaticRollback({ ...newest, report }, node(12))).toBeUndefined();
    expect(automaticRollback({ ...newest, status: "running", report: undefined }, node(12))).toBeUndefined();
    expect(automaticRollback({ ...newest, status: "errored" }, node(12))).toBeUndefined();
  });

  test("once: never a rollback's, never twice, never to the same node, never once the release moved on", () => {
    expect(automaticRollback({ ...newest, rollback: true }, node(12))).toBeUndefined();
    expect(automaticRollback({ ...newest, rolled_back: { node: node(9), reason: "no container", deploy: "t-deploy-4" } }, node(12))).toBeUndefined();
    expect(automaticRollback({ ...newest, previous: node(12) }, node(12))).toBeUndefined();
    expect(automaticRollback({ ...newest, previous: null }, node(12))).toBeUndefined();
    expect(automaticRollback({ node: node(12), status: "complete", report: canaryFailed }, node(12))).toBeUndefined();
    expect(automaticRollback(newest, node(13))).toBeUndefined();
  });
});
