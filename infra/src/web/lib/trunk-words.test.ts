import { describe, expect, test } from "bun:test";
import type { AttemptStory, NodeStory } from "./trunk.ts";
import { attemptChains, attemptDetail, detailsLabel, graftRunIntent, graftSource, headline, listed, nodeIntent, nodeSummary, trunkRows } from "./trunk-words.ts";

const attempt = (id: number, agent: string, outcome: AttemptStory["outcome"], score?: string, other?: number): AttemptStory => ({
  attempt: id,
  agent,
  outcome,
  score,
  other: outcome === "accepted" || outcome === "open" ? undefined : (other ?? 1),
  note: outcome === "abandoned" ? "gave up" : undefined,
});

const node = (kind: NodeStory["kind"], attempts: ReadonlyArray<AttemptStory>, id = 3): NodeStory => ({
  node: id,
  parent: kind === "root" ? null : 2,
  commit: "abc",
  kind,
  task: kind === "accepted" ? { id: 4, intent: "Fix the thing. Then say so." } : undefined,
  graftedFrom: kind === "graft" ? "https://example.com/repo.git" : undefined,
  attempts,
  touched: kind === "accepted" ? ["a.ts"] : [],
  head: false,
  released: false,
  deploys: [],
});

describe("nodeSummary", () => {
  test("says who won, how it scored, and what became of the rest", () => {
    const story = node("accepted", [
      attempt(1, "opus", "accepted", "5/5 checks, cost 81"),
      attempt(2, "sonnet", "lost"),
      attempt(3, "opus", "rebased"),
      attempt(4, "kimi", "abandoned"),
    ]);

    expect(nodeSummary(story)).toBe("3 attempts by opus, sonnet and kimi: opus won (5/5 checks, cost 81); 1 lost, 1 abandoned; rebased once along the way.");
  });

  test("rebases are the same work moved on, not more attempts", () => {
    // 74 → 80 → 85 lost to 86; 76 → 82 → 86 accepted.
    const story = node("accepted", [
      attempt(86, "opus", "accepted"),
      attempt(74, "sonnet", "rebased", "5/5 checks, cost 90", 80),
      attempt(76, "opus", "rebased", undefined, 82),
      attempt(80, "sonnet", "rebased", undefined, 85),
      attempt(82, "opus", "rebased", "5/5 checks, cost 70", 86),
      attempt(85, "sonnet", "lost", "5/5 checks, cost 97", 86),
    ]);

    expect(attemptChains(story.attempts).map(({ last, rebased }) => [last.attempt, rebased])).toEqual([
      [86, 2],
      [85, 2],
    ]);

    expect(nodeSummary(story)).toBe("2 attempts by opus and sonnet: opus won; 1 lost (5/5 checks, cost 97); rebased 4 times along the way.");

    expect(detailsLabel(story)).toBe("Details: 2 attempts, 1 path changed");
  });

  test("a lone attempt rebased once reads as one", () => {
    const story = node("accepted", [attempt(96, "opus", "accepted", "5/5 checks, cost 395, before its rebase"), attempt(94, "opus", "rebased", undefined, 96)]);

    expect(nodeSummary(story)).toBe("One attempt, by opus (5/5 checks, cost 395, before its rebase), rebased once.");
  });

  test("a lone attempt reads as one", () => {
    expect(nodeSummary(node("accepted", [attempt(1, "opus", "accepted")]))).toBe("One attempt, by opus.");
  });

  test("the root and a graft say where their code came from", () => {
    expect(nodeSummary(node("root", []))).toBe("The code the tree started from.");
    expect(nodeIntent(node("graft", []))).toBe("Grafted from example.com/repo");
    expect(nodeIntent(node("root", []))).toBe("Root, as initialized");
  });
});

describe("headline", () => {
  test("keeps an intent's first sentence", () => {
    expect(headline("Fix the thing. Then say so.")).toBe("Fix the thing.");
  });

  test("cuts a long sentence at a word", () => {
    const cut = headline(`${"word ".repeat(40)}end`);

    expect(cut.endsWith("word…")).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(111);
  });
});

describe("attemptDetail", () => {
  test("names the other attempt and the score", () => {
    expect(attemptDetail(attempt(2, "sonnet", "lost", "4/5 checks, cost 9"))).toBe("to attempt 1 · 4/5 checks, cost 9");
    expect(attemptDetail(attempt(3, "opus", "rebased"))).toBe("into attempt 1 · never scored");
    expect(attemptDetail(attempt(4, "kimi", "abandoned"))).toBe("never scored · gave up");
  });

  test("an accepted attempt without a kept score says nothing of it", () => {
    expect(attemptDetail(attempt(1, "opus", "accepted"))).toBe("");
  });
});

test("listed", () => {
  expect(listed(["a"])).toBe("a");
  expect(listed(["a", "b"])).toBe("a and b");
  expect(listed(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more");
});

test("detailsLabel counts what the details show", () => {
  expect(detailsLabel(node("accepted", [attempt(1, "opus", "accepted")]))).toBe("Details: 1 attempt, 1 path changed");
  expect(detailsLabel({ ...node("accepted", [attempt(1, "opus", "accepted")]), touched: [] })).toBe("Details: 1 attempt");
  expect(detailsLabel(node("root", []))).toBe("Details");
});

test("graftSource says where a graft came from, short", () => {
  expect(graftSource("https://github.com/Butch78/ficus.git#deploys")).toBe("github.com/Butch78/ficus (deploys)");
  expect(graftSource("https://github.com/Butch78/ficus#deploys")).toBe("github.com/Butch78/ficus (deploys)");
  expect(graftSource("https://example.com/repo")).toBe("example.com/repo");
  expect(graftSource(undefined)).toBe("an outside commit");
});

describe("trunkRows", () => {
  const graft = (id: number, from: string) => ({ ...node("graft", [], id), graftedFrom: from });

  test("a run of grafts from one place shares a row; other nodes have their own", () => {
    const stories = [
      node("accepted", [], 11),
      graft(7, "https://github.com/o/r.git#main"),
      graft(6, "https://github.com/o/r#main"),
      graft(5, "https://github.com/o/r#main"),
      graft(4, "https://github.com/o/other#main"),
      node("root", [], 0),
    ];

    const rows = trunkRows(stories);

    expect(rows.map((row) => row.map((story) => story.node))).toEqual([[11], [7, 6, 5], [4], [0]]);

    const [, run] = rows;

    expect(run === undefined ? "" : graftRunIntent(run)).toBe("3 outside commits imported from github.com/o/r (main)");
  });

  test("a released graft keeps its own row", () => {
    const rows = trunkRows([graft(7, "x"), { ...graft(6, "x"), released: true }, graft(5, "x")]);

    expect(rows.map((row) => row.map((story) => story.node))).toEqual([[7], [6], [5]]);
  });
});
