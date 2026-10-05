import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { change, parsePath, parseRef, Subject, view } from "./browse.ts";
import { content, type Hunk } from "./diff.ts";
import { applyStep, closeLedger, emptyLedger, outcomeBody, outcomeLine, parseLine, stepLine } from "./progress.ts";
import * as T from "./tree.ts";
import { AttemptId, makeScore, NodeId, Oid, RepoName } from "./values.ts";

const ok = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result);

const oid = (digit: string) => Oid.make(digit.repeat(40));

const initialized = () => ok(T.init(RepoName.make("t-site"), oid("a")));

const bytes = (text: string) => new TextEncoder().encode(text);

describe("progress", () => {
  test("steps are one JSON object per line", () => {
    expect(stepLine("read_head", "active", undefined, "attempt 2")).toBe('{"kind":"step","step":"read_head","state":"active","detail":"attempt 2"}\n');
    expect(stepLine("lock", "complete")).toBe('{"kind":"step","step":"lock","state":"complete"}\n');
  });

  test("a ledger keeps one entry per step and item, with its times", () => {
    const lines = [
      '{"kind":"step","step":"devenv","state":"active"}',
      '{"kind":"step","step":"devenv","state":"complete"}',
      '{"kind":"step","step":"check","state":"active","item":"tests"}',
      '{"kind":"step","step":"check","state":"active","item":"lint"}',
      '{"kind":"step","step":"check","state":"error","item":"tests","detail":"exit 1"}',
      "not a progress line",
    ];

    let ledger = emptyLedger;

    lines.forEach((line, at) => {
      const parsed = parseLine(line);

      if (Option.isSome(parsed) && parsed.value.kind === "step") {
        const { step, state, item, detail } = parsed.value;

        ledger = applyStep(ledger, step, state, item, detail, 10 + at);
      }
    });

    ledger = closeLedger(ledger, "error", 99);

    expect(ledger.entries.map((entry) => [entry.step, entry.item, entry.state, entry.started_at, entry.ended_at])).toEqual([
      ["devenv", undefined, "complete", 10, 11],
      ["check", "tests", "error", 12, 14],
      ["check", "lint", "error", 13, 99],
    ]);
    expect(ledger.entries[1]?.detail).toBe("exit 1");
  });

  test("the outcome carries the answer's JSON, or its text", () => {
    expect(outcomeLine(200, outcomeBody('{"name":"t-site"}'))).toBe('{"kind":"outcome","status":200,"body":{"name":"t-site"}}\n');
    expect(outcomeBody("tree already initialized")).toBe("tree already initialized");
  });
});

describe("browsing a tree's repos", () => {
  test("a node is pinned to its commit", () => {
    const tree = initialized();

    expect(ok(view(tree, Subject.Node({ id: T.head(tree).id })))).toEqual({ repo: tree.name, pinned: oid("a") });
  });

  test("an attempt is pinned once submitted", () => {
    let tree = initialized();
    const task = ok(T.taskNew(tree, "fix it", []));
    const started = ok(T.start(task.tree, task.task, "alpha"));
    const subject = Subject.Attempt({ id: started.attempt });

    tree = started.tree;
    expect(ok(view(tree, subject)).pinned).toBeUndefined();
    tree = ok(T.submit(tree, started.attempt, oid("b")));
    expect(ok(view(tree, subject)).pinned).toBe(oid("b"));
    tree = ok(T.scored(tree, started.attempt, ok(makeScore(1, 1, 3)), []));
    expect(ok(view(tree, subject)).pinned).toBe(oid("b"));
    tree = ok(T.accept(tree, task.task)).tree;
    expect(ok(view(tree, subject))).toEqual({ repo: T.attempt(tree, started.attempt)!.repo, pinned: oid("b") });
  });

  test("an attempt changes from its base, a node from its parent", () => {
    let tree = initialized();

    expect(ok(change(tree, Subject.Node({ id: T.head(tree).id }))).base).toBeUndefined();

    const task = ok(T.taskNew(tree, "fix it", []));
    const started = ok(T.start(task.tree, task.task, "alpha"));

    tree = started.tree;

    const working = ok(change(tree, Subject.Attempt({ id: started.attempt })));

    expect([working.base, working.head]).toEqual([oid("a"), undefined]);
    tree = ok(T.scored(ok(T.submit(tree, started.attempt, oid("b"))), started.attempt, ok(makeScore(1, 1, 3)), []));

    const accepted = ok(T.accept(tree, task.task));
    const node = ok(change(accepted.tree, Subject.Node({ id: accepted.acceptance.node })));

    expect([node.base, node.head, node.repo]).toEqual([oid("a"), oid("b"), T.attempt(accepted.tree, started.attempt)!.repo]);
  });

  test("unknown subjects are errors", () => {
    const tree = initialized();
    const kind = (result: Result.Result<unknown, T.TreeError>) => (Result.isFailure(result) ? result.failure.kind : "found");

    expect(kind(view(tree, Subject.Attempt({ id: AttemptId.make(7) })))).toBe("UnknownAttempt");
    expect(kind(view(tree, Subject.Node({ id: NodeId.make(7) })))).toBe("UnknownNode");
  });

  test("refs", () => {
    for (const good of ["main", "feature/x", "v1.2", "a".repeat(40)]) {
      expect(Result.isSuccess(parseRef(good))).toBe(true);
    }

    for (const bad of ["", "-x", "/x", "x/", "x.", "a..b", "a//b", "a b", "a~1", "a^", "a:b", "@{-1}", "a\nb", "a".repeat(256)]) {
      expect(Result.isFailure(parseRef(bad))).toBe(true);
    }
  });

  test("paths", () => {
    expect(ok(parsePath(""))).toEqual([]);
    expect(ok(parsePath("/"))).toEqual([]);
    expect(ok(parsePath("/src/lib.rs"))).toEqual(["src", "lib.rs"]);

    for (const bad of ["a//b", "../etc", "a/./b", "a/..", "a\0b", "a".repeat(4097)]) {
      expect(Result.isFailure(parsePath(bad))).toBe(true);
    }
  });
});

describe("a file's diff", () => {
  const span = (hunk: Hunk | undefined) => [hunk?.old_start, hunk?.old_lines, hunk?.new_start, hunk?.new_lines];

  test("a change in the middle is one hunk, with context", () => {
    const diff = content(bytes("a\nb\nc\nd\ne\nf\ng\nh\n"), bytes("a\nb\nc\nd\nE\nf\ng\nh\n"));

    if (diff.kind !== "text") {
      throw new Error("text diffs as text");
    }

    expect([diff.additions, diff.deletions, diff.hunks.length]).toEqual([1, 1, 1]);
    expect(span(diff.hunks[0])).toEqual([2, 7, 2, 7]);
    expect(diff.hunks[0]?.lines.map((line) => [line.kind, line.text])).toEqual([
      ["context", "b"],
      ["context", "c"],
      ["context", "d"],
      ["removed", "e"],
      ["added", "E"],
      ["context", "f"],
      ["context", "g"],
      ["context", "h"],
    ]);
  });

  test("an added file is all additions, from line one", () => {
    const diff = content(undefined, bytes("one\ntwo\n"));

    if (diff.kind !== "text") {
      throw new Error("text diffs as text");
    }

    expect(diff.additions).toBe(2);
    expect(span(diff.hunks[0])).toEqual([0, 0, 1, 2]);
  });

  test("identical text has no hunks, and bytes are binary", () => {
    expect(content(bytes("same\n"), bytes("same\n"))).toEqual({ kind: "text", additions: 0, deletions: 0, hunks: [] });
    expect(content(new Uint8Array([0xff, 0xfe]), bytes("x"))).toEqual({ kind: "binary" });
  });
});
