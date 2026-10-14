import { describe, expect, test } from "bun:test";
import { abandonedLesson, deployLesson, type DeployFacts, isLessonsPath, LESSONS_PATH, learn, Lesson, lessonsContext, lessonsPath, MAX_LESSONS, RECORDED_IN_CONTEXT } from "./lessons.ts";
import { NodeId } from "./values.ts";

const lesson = (subject: string, at: number, text = `about ${subject}`) => Lesson.make({ kind: "deploy", subject, text, at });

describe("lessonsPath", () => {
  test("the path under [lessons], else LESSONS.md", () => {
    expect(lessonsPath(undefined)).toBe(LESSONS_PATH);
    expect(lessonsPath('[[check]]\nname = "t"\npath = "no"\n')).toBe(LESSONS_PATH);
    expect(lessonsPath('[[check]]\nrun = "true"\n\n[lessons]\npath = "docs/LESSONS.md" # ours\n\n[deploy]\npath = "no"\n')).toBe("docs/LESSONS.md");
    expect(lessonsPath("[ lessons ]\n  path='notes/l.md'\n")).toBe("notes/l.md");
  });

  test("a path outside the repo is LESSONS.md", () => {
    expect(lessonsPath('[lessons]\npath = "../secrets"\n')).toBe(LESSONS_PATH);
    expect(isLessonsPath("a/./b")).toBe(false);
    expect(isLessonsPath("a/b.md")).toBe(true);
  });
});

describe("learn", () => {
  test("keeps the newest first, one per kind and subject", () => {
    const known = [lesson("node 2", 20), lesson("node 1", 10)];
    const learned = learn(known, [lesson("node 1", 30, "again"), Lesson.make({ kind: "canary", subject: "node 2", text: "canary", at: 25 })]);

    expect(learned.map((each) => [each.kind, each.subject, each.at])).toEqual([
      ["deploy", "node 1", 30],
      ["canary", "node 2", 25],
      ["deploy", "node 2", 20],
    ]);
  });

  test("an older lesson of a known kind and subject changes nothing; on a tie the one learned wins", () => {
    const known = [lesson("node 1", 30)];

    expect(learn(known, [lesson("node 1", 10, "stale")])).toEqual(known);
    expect(learn(known, [lesson("node 1", 30, "rolled back too")])[0]?.text).toBe("rolled back too");
  });

  test("is bounded, and learning a lesson cut for its age again leaves the list as it was", () => {
    const many = learn([], Array.from({ length: MAX_LESSONS + 5 }, (_, at) => lesson(`node ${at}`, at)));

    expect(many).toHaveLength(MAX_LESSONS);
    expect(many[0]?.at).toBe(MAX_LESSONS + 4);
    expect(learn(many, [lesson("node 0", 0)])).toEqual(many);
  });
});

describe("abandonedLesson", () => {
  test("names the task by its title, else its intent, on one line", () => {
    const made = abandonedLesson("rebase", { id: 4, intent: "Add\na thing" }, 9, "rebase: conflict in a.ts", 5);

    expect(made).toEqual({ kind: "rebase", subject: "task 4", text: "Attempt 9 at task 4 (Add a thing) was abandoned: rebase: conflict in a.ts", at: 5 });
    expect(abandonedLesson("sandbox", { id: 4, intent: "x", title: "Named" }, 9, "n", 5).text).toContain("(Named)");
  });
});

describe("deployLesson", () => {
  const deploy = (extra: Partial<DeployFacts>): DeployFacts => ({ id: "t-deploy-3", node: NodeId.make(7), started_at: 100, status: "complete", ...extra });
  const report = { deployed: true, passed: true, millis: 1, tail: "ok" };

  test("nothing for a deploy going or gone well", () => {
    expect(deployLesson(deploy({ status: "running" }))).toBeUndefined();
    expect(deployLesson(deploy({ report }))).toBeUndefined();
    expect(deployLesson(deploy({ report: { ...report, canary: { passed: true, millis: 1, tries: 1 } } }))).toBeUndefined();
  });

  test("an errored Workflow or a failed command, dated by the deploy's start", () => {
    expect(deployLesson(deploy({ status: "errored", error: "step deploy timed out" }))).toEqual({
      kind: "deploy",
      subject: "node 7",
      text: "Deploy t-deploy-3 of node 7 errored: step deploy timed out",
      at: 100,
    });
    expect(deployLesson(deploy({ report: { ...report, passed: false, tail: "bun run deploy\nerror: no token" } }))?.text).toBe("Deploy t-deploy-3 of node 7 failed in `run`: bun run deploy error: no token");
    expect(deployLesson(deploy({ report: { ...report, deployer: { ...report, passed: false, tail: "boom" } } }))?.text).toContain("failed in `deployer`: boom");
  });

  test("a failed canary, and the rollback it caused", () => {
    const canary = { passed: false, millis: 1, tries: 3, reason: "`bun --version` did not answer" };
    const failed = deployLesson(deploy({ report: { ...report, canary } }));

    expect(failed).toMatchObject({ kind: "canary", subject: "node 7", text: "The canary after Deploy t-deploy-3 of node 7 failed: `bun --version` did not answer" });
    expect(deployLesson(deploy({ report: { ...report, canary }, rolled_back: { node: NodeId.make(6), reason: "r" } }))?.text).toMatch(/; the release rolled back to node 6$/);
  });

  test("keeps the end of a long output", () => {
    const text = deployLesson(deploy({ status: "errored", error: `${"x".repeat(1000)} the cause` }))?.text ?? "";

    expect(text.endsWith("the cause")).toBe(true);
    expect(text.length).toBeLessThan(400);
  });
});

describe("lessonsContext", () => {
  test("empty without lessons", () => {
    expect(lessonsContext(undefined, [])).toBe("");
    expect(lessonsContext("  \n", [])).toBe("");
  });

  test("the file, then the newest recorded lessons", () => {
    const context = lessonsContext("- run the full checks", [lesson("node 2", Date.UTC(2026, 9, 13))]);

    expect(context).toBe(`From ${LESSONS_PATH}:\n- run the full checks\n\nRecorded by the tree, newest first:\n- 2026-10-13 deploy, node 2: about node 2`);
  });

  test("at most RECORDED_IN_CONTEXT recorded lessons, and the file cut at a line to fit", () => {
    const recorded = Array.from({ length: RECORDED_IN_CONTEXT + 3 }, (_, at) => lesson(`node ${at}`, at));
    const file = Array.from({ length: 200 }, (_, n) => `- lesson ${n}`).join("\n");
    const context = lessonsContext(file, recorded, 1200);

    expect(context.length).toBeLessThanOrEqual(1200);
    expect(context.match(/deploy, node/g)).toHaveLength(RECORDED_IN_CONTEXT);
    expect(context).toContain("- lesson 0\n");
    expect(context).toContain("… (the rest is cut)");
    expect(context).not.toContain("- lesson 199");
  });
});
