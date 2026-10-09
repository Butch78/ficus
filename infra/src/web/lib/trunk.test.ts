import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { Deploys, Tree, type AttemptState, type CloseReason } from "./answers.ts";
import { scoreText, trunkStory } from "./trunk.ts";

const a = "a".repeat(40);

const b = "b".repeat(40);

const c = "c".repeat(40);

const d = "d".repeat(40);

const repo = "abcdefghij-site";

const rootOnly = Schema.decodeUnknownSync(Tree)({
  name: repo,
  head: 0,
  nodes: { "0": { id: 0, parent: null, commit: a, repo, accepted_from: null, touched: [] } },
  tasks: {},
  attempts: {},
  history: [],
});

const passing = { checks_passed: 5, checks_total: 5, cost: 81, confidence: 840 };

/** An attempt as the tree stores it. */
const attempt = (id: number, task: number, base: number, state: AttemptState) => ({ id, task, agent: `agent-${id}`, base, repo: `${repo}-a${id}`, state });

const closed = (reason: CloseReason): AttemptState => ({ Closed: { reason } });

// Root 0 → node 1 (task 1, five attempts) → graft 8 → node 10 (task 9, won by a rebase).
const grown = Schema.decodeUnknownSync(Tree)({
  name: repo,
  head: 10,
  released: 1,
  nodes: {
    "0": { id: 0, parent: null, commit: a, repo, accepted_from: null, touched: [] },
    "1": { id: 1, parent: 0, commit: b, repo: `${repo}-a2`, accepted_from: 2, touched: ["src/slug.ts", "README.md"] },
    "8": { id: 8, parent: 1, commit: c, repo: `${repo}-g8`, accepted_from: null, touched: [], grafted_from: "https://github.com/o/site#main" },
    "10": { id: 10, parent: 8, commit: d, repo: `${repo}-a12`, accepted_from: 12, touched: ["src/page.ts"] },
  },
  tasks: {
    "1": { id: 1, intent: "fix slugify", state: { Done: { attempt: 2, node: 1 } } },
    "9": { id: 9, intent: "add a page", state: { Done: { attempt: 12, node: 10 } } },
    "14": { id: 14, intent: "not yet", state: "Open" },
  },
  attempts: {
    "2": attempt(2, 1, 0, { Accepted: { node: 1 } }),
    "3": attempt(3, 1, 0, closed({ Lost: { to: 2 } })),
    "4": attempt(4, 1, 0, closed({ Abandoned: { note: "the agent gave up" } })),
    "5": attempt(5, 1, 0, closed({ Retried: { into: 7 } })),
    "7": attempt(7, 1, 0, closed({ Lost: { to: 2 } })),
    "11": { ...attempt(11, 9, 1, closed({ Rebased: { into: 12 } })), rebase: 12 },
    "12": { ...attempt(12, 9, 8, { Accepted: { node: 10 } }), rebase_of: 11 },
    "13": attempt(13, 9, 1, { Scored: { commit: c, score: { checks_passed: 4, checks_total: 5, cost: 30 } } }),
    "15": attempt(15, 14, 10, "Working"),
  },
  history: [
    { attempt: 3, task: 1, agent: "agent-3", reason: { Lost: { to: 2 } }, score: { checks_passed: 0, checks_total: 5, cost: 4, confidence: null } },
    { attempt: 4, task: 1, agent: "agent-4", reason: { Abandoned: { note: "the agent gave up" } }, score: null },
    { attempt: 5, task: 1, agent: "agent-5", reason: { Retried: { into: 7 } }, score: null },
    { attempt: 7, task: 1, agent: "agent-7", reason: { Lost: { to: 2 } }, score: passing },
    { attempt: 11, task: 9, agent: "agent-11", reason: { Rebased: { into: 12 } }, score: passing },
  ],
});

const deploys = Schema.decodeUnknownSync(Deploys)({
  enabled: true,
  deploys: [
    { id: "site-deploy-3", node: 10, commit: d, started_at: 300, status: "running" },
    { id: "site-deploy-1", node: 1, commit: b, started_at: 100, status: "errored", error: "no sandbox" },
    { id: "site-deploy-2", node: 1, commit: b, started_at: 200, status: "complete" },
  ],
}).deploys;

const story = trunkStory(grown, deploys);

const at = (node: number) => {
  const found = story.find((entry) => entry.node === node);

  if (found === undefined) {
    throw new Error(`no story for node ${node}`);
  }

  return found;
};

describe("trunkStory", () => {
  test("a tree with only its root is one root node, the head, with nothing settled", () => {
    expect(trunkStory(rootOnly, [])).toEqual([
      {
        node: 0,
        parent: null,
        commit: a,
        kind: "root",
        task: undefined,
        graftedFrom: undefined,
        attempts: [],
        touched: [],
        head: true,
        released: false,
        deploys: [],
      },
    ]);
  });

  test("runs from the head down to the root, following parents", () => {
    expect(story.map((entry) => [entry.node, entry.kind])).toEqual([
      [10, "accepted"],
      [8, "graft"],
      [1, "accepted"],
      [0, "root"],
    ]);

    expect(story.map((entry) => entry.head)).toEqual([true, false, false, false]);

    expect(story.map((entry) => entry.released)).toEqual([false, false, true, false]);
  });

  test("an accepted node tells its task and every attempt at it, the winner first", () => {
    const node = at(1);

    expect(node.task).toEqual({ id: 1, intent: "fix slugify", title: undefined });

    expect(node.touched).toEqual(["src/slug.ts", "README.md"]);

    expect(node.attempts).toEqual([
      { attempt: 2, agent: "agent-2", outcome: "accepted", score: undefined, other: undefined, note: undefined },
      { attempt: 3, agent: "agent-3", outcome: "lost", score: "0/5 checks, cost 4", other: 2, note: undefined },
      { attempt: 4, agent: "agent-4", outcome: "abandoned", score: undefined, other: undefined, note: "the agent gave up" },
      { attempt: 5, agent: "agent-5", outcome: "retried", score: undefined, other: 7, note: undefined },
      { attempt: 7, agent: "agent-7", outcome: "lost", score: "5/5 checks, cost 81, judge 0.84", other: 2, note: undefined },
    ]);
  });

  test("a rebased attempt points at its rebase, which wins with its score; one scored on an older base is still open", () => {
    expect(at(10).attempts.map((entry) => [entry.attempt, entry.outcome, entry.other, entry.score])).toEqual([
      [12, "accepted", undefined, "5/5 checks, cost 81, judge 0.84, before its rebase"],
      [11, "rebased", 12, "5/5 checks, cost 81, judge 0.84"],
      [13, "open", undefined, "4/5 checks, cost 30"],
    ]);
  });

  test("a graft says where it came from and settled no task", () => {
    expect(at(8)).toMatchObject({ kind: "graft", graftedFrom: "https://github.com/o/site#main", task: undefined, attempts: [] });
  });

  test("each node carries its own deploys, newest first", () => {
    expect(at(1).deploys.map((deploy) => deploy.id)).toEqual(["site-deploy-2", "site-deploy-1"]);

    expect(at(10).deploys.map((deploy) => deploy.id)).toEqual(["site-deploy-3"]);

    expect(at(8).deploys).toEqual([]);
  });

  test("a walk stops at a missing parent instead of looping", () => {
    const broken = { ...rootOnly, head: 3, nodes: { "3": { id: 3, parent: 2, commit: a, repo, accepted_from: null } } };

    expect(trunkStory(broken, []).map((entry) => entry.node)).toEqual([3]);
  });

  test("a walk stops at a node seen twice instead of looping", () => {
    const looped = {
      ...rootOnly,
      head: 3,
      nodes: {
        "2": { id: 2, parent: 3, commit: a, repo, accepted_from: null },
        "3": { id: 3, parent: 2, commit: a, repo, accepted_from: null },
      },
    };

    expect(trunkStory(looped, []).map((entry) => entry.node)).toEqual([3, 2]);
  });
});

describe("scoreText", () => {
  test("says checks and cost, and the judges' confidence when there is one", () => {
    expect(scoreText({ checks_passed: 5, checks_total: 5, cost: 81 })).toBe("5/5 checks, cost 81");
    expect(scoreText({ checks_passed: 5, checks_total: 5, cost: 81, confidence: 700 })).toBe("5/5 checks, cost 81, judge 0.70");
  });
});
