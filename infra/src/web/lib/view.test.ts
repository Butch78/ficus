import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { Tree } from "./answers.ts";
import { tasks, crumbs, join, status, trunk } from "./view.ts";

const a = "a".repeat(40);

const b = "b".repeat(40);

// The shape `GET /trees/<t>` answers after one accept, as serde writes it.
const accepted = Schema.decodeUnknownSync(Tree)({
  name: "abcdefghij-site",
  head: 1,
  next_id: 5,
  nodes: {
    "0": { id: 0, parent: null, commit: a, repo: "abcdefghij-site", accepted_from: null },
    "1": { id: 1, parent: 0, commit: b, repo: "abcdefghij-site-a2", accepted_from: 2 },
  },
  tasks: {
    "1": { id: 1, intent: "fix slugify", state: { Done: { attempt: 2, node: 1 } } },
    "4": { id: 4, intent: "add a test", state: "Open" },
  },
  attempts: {
    "2": { id: 2, task: 1, agent: "beta", base: 0, repo: "abcdefghij-site-a2", state: { Accepted: { node: 1 } } },
    "3": {
      id: 3,
      task: 1,
      agent: "cheater",
      base: 0,
      repo: "abcdefghij-site-a3",
      state: { Closed: { reason: { Lost: { to: 2 } } } },
    },
    "5": { id: 5, task: 4, agent: "gamma", base: 0, repo: "abcdefghij-site-a5", state: "Working" },
  },
  history: [
    {
      attempt: 3,
      task: 1,
      agent: "cheater",
      reason: { Lost: { to: 2 } },
      score: { checks_passed: 0, checks_total: 1, cost: 4 },
    },
  ],
});

describe("the tree as a page reads it", () => {
  test("decodes serde's externally tagged enums", () => {
    expect(accepted.attempts["5"]?.state).toBe("Working");
    expect(accepted.tasks["1"]?.state).toEqual({ Done: { attempt: 2, node: 1 } });
  });

  test("the trunk runs from the root to the head", () => {
    expect(trunk(accepted).map((node) => node.id)).toEqual([0, 1]);
  });

  test("tasks come newest first, each with its own attempts and accepted", () => {
    expect(tasks(accepted).map((view) => [view.task.id, view.attempts.map((attempt) => attempt.id), view.accepted])).toEqual([
      [4, [5], undefined],
      [1, [2, 3], 1],
    ]);
  });
});

describe("status", () => {
  test("says what each attempt state means", () => {
    expect(status("Working")).toEqual({ tone: "working", label: "working", commit: undefined });
    expect(status({ Checking: { commit: a } }).commit).toBe(a);
    expect(status({ Scored: { commit: b, score: { checks_passed: 2, checks_total: 2, cost: 7 } } }).label).toBe(
      "scored: passes 2/2 checks, cost 7",
    );
    expect(status({ Scored: { commit: b, score: { checks_passed: 1, checks_total: 2, cost: 7 } } })).toEqual({
      tone: "failing",
      label: "scored: fails 1/2 checks, cost 7",
      commit: b,
    });
    expect(status({ Accepted: { node: 3 } }).tone).toBe("accepted");
    expect(status({ Closed: { reason: { Retried: { into: 9 } } } }).label).toBe("closed: retried as attempt 9");
    expect(status({ Closed: { reason: { Abandoned: { note: "gave up" } } } }).label).toBe("closed: abandoned: gave up");
  });
});

describe("paths", () => {
  test("a breadcrumb names each directory and where it leads", () => {
    expect(crumbs("")).toEqual([]);
    expect(crumbs("src/web/lib")).toEqual([
      ["src", "src"],
      ["web", "src/web"],
      ["lib", "src/web/lib"],
    ]);
  });

  test("join does not lead with a slash at the root", () => {
    expect(join("", "README.md")).toBe("README.md");
    expect(join("src", "lib.rs")).toBe("src/lib.rs");
  });
});
