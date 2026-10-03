import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import legacyTree from "./fixtures/tree-botany.json";
import type { CheckSpec } from "./scoring.ts";
import * as T from "./tree.ts";
import { AttemptId, makeScore, NodeId, Oid, RepoName, type Score, TaskId } from "./values.ts";

const oid = (digit: string) => Oid.make(digit.repeat(40));

const repo = (name: string) => RepoName.make(name);

const ok = <A, E>(result: Result.Result<A, E>): A => Result.getOrThrow(result);

/** The kind a refused operation was refused with. */
const refusal = <A>(result: Result.Result<A, T.TreeError>) => (Result.isFailure(result) ? result.failure.kind : "succeeded");

const passing = (cost: number): Score => ok(makeScore(3, 3, cost));

const fresh = (name = "t") => ok(T.init(repo(name), oid("0")));

/** A tree being built up step by step. */
const grow = (start = fresh()) => {
  let tree = start;

  const task = (intent: string, checks: ReadonlyArray<CheckSpec> = []) => {
    const made = ok(T.taskNew(tree, intent, checks));

    tree = made.tree;

    return made.task;
  };

  const attempt = (taskId: TaskId, agent: string) => {
    const started = ok(T.start(tree, taskId, agent));

    tree = started.tree;

    return started.attempt;
  };

  /** Submit and score in one step, as the scorer would. */
  const scored = (id: AttemptId, commit: Oid, score: Score, touched: ReadonlyArray<string> = []) => {
    tree = ok(T.scored(ok(T.submit(tree, id, commit)), id, score, touched));
  };

  const accept = (taskId: TaskId) => {
    const accepted = ok(T.accept(tree, taskId));

    tree = accepted.tree;

    return accepted.acceptance;
  };

  const set = (next: T.Tree) => {
    tree = next;
  };

  return { task, attempt, scored, accept, set, get: () => tree };
};

describe("the tree", () => {
  test("standings say which attempt accept would take, and why not the rest", () => {
    const g = grow(ok(T.init(repo("t-site"), oid("a"))));
    const task = g.task("fix slugify");
    const [costly, cheap, failing, working, checking] = ["alpha", "beta", "cheater", "gamma", "delta"].map((agent) => g.attempt(task, agent));

    g.scored(costly!, oid("b"), passing(12));
    g.scored(cheap!, oid("c"), passing(2));
    g.scored(failing!, oid("d"), ok(makeScore(1, 3, 1)));
    g.set(ok(T.submit(g.get(), checking!, oid("e"))));

    expect(ok(T.standings(g.get(), task))).toEqual([
      [costly!, { Outscored: { by: cheap! } }],
      [cheap!, "Best"],
      [failing!, { Failing: { checks_passed: 1, checks_total: 3 } }],
      [working!, "Working"],
      [checking!, "Checking"],
    ]);

    // The standings' best is the acceptance's: one rule.
    expect(g.accept(task).accepted).toBe(cheap!);

    const after = ok(T.standings(g.get(), task));

    expect(after[0]?.[1]).toHaveProperty("Closed");
    expect(after[1]?.[1]).toHaveProperty("Accepted");
  });

  test("an attempt of another task started from an old head stands behind", () => {
    const g = grow(ok(T.init(repo("t-site"), oid("a"))));
    const first = g.task("first");
    const second = g.task("second");
    const accepted = g.attempt(first, "alpha");
    const behind = g.attempt(second, "beta");

    g.scored(accepted, oid("b"), passing(1));
    g.scored(behind, oid("c"), passing(1));
    g.accept(first);

    expect(ok(T.standings(g.get(), second))).toEqual([[behind, "Behind"]]);
    expect(refusal(T.standings(g.get(), TaskId.make(99)))).toBe("UnknownTask");
  });

  test("a graft becomes the head and leaves open attempts behind", () => {
    const g = grow(ok(T.init(repo("t-site"), oid("a"))));
    const task = g.task("fix it");
    const submitted = g.attempt(task, "alpha");

    g.scored(submitted, oid("b"), passing(1));

    const reserved = ok(T.reserveGraft(g.get()));

    g.set(reserved.tree);
    expect(reserved.repo).toBe(repo(`t-site-g${reserved.node}`));

    // An attempt started while the import runs takes another id.
    const meanwhile = g.attempt(task, "beta");

    expect(Number(meanwhile)).not.toBe(Number(reserved.node));

    g.set(ok(T.graft(g.get(), reserved.node, oid("c"), reserved.repo, "https://github.com/o/r#main")));

    const head = T.head(g.get());

    expect([head.id, head.commit, head.repo, head.parent, head.grafted_from]).toEqual([
      reserved.node,
      oid("c"),
      reserved.repo,
      NodeId.make(0),
      "https://github.com/o/r#main",
    ]);

    // Nothing accepts from the old head; the submitted attempt gets rebased.
    expect(refusal(T.accept(g.get(), task))).toBe("NothingToAccept");
    expect(T.rebaseable(g.get()).map((entry) => entry.id)).toEqual([submitted]);

    // A reservation is used once, and only a reservation can be used.
    expect(refusal(T.graft(g.get(), reserved.node, oid("d"), reserved.repo, "again"))).toBe("NotReserved");
    expect(refusal(T.graft(g.get(), NodeId.make(999), oid("d"), reserved.repo, "never reserved"))).toBe("NotReserved");
  });

  test("an oid is lowercase hex of a hash's length", () => {
    const valid = Schema.is(Oid);

    expect(valid("a".repeat(40))).toBe(true);
    expect(valid("a".repeat(64))).toBe(true);
    expect(valid("A".repeat(40))).toBe(false);
    expect(valid("a".repeat(39))).toBe(false);
    expect(valid("g".repeat(40))).toBe(false);
  });

  test("a score never passes more checks than it has", () => {
    expect(Result.isFailure(makeScore(4, 3, 0))).toBe(true);
    expect(Result.isFailure(makeScore(0, 0, 0))).toBe(true);
    expect(T.passes(ok(makeScore(2, 3, 0)))).toBe(false);
  });

  test("on equal cost accept takes the attempt the judges were surest of", () => {
    const g = grow();
    const task = g.task("add a /health route");
    const first = g.attempt(task, "agent-a");
    const surer = g.attempt(task, "agent-b");
    const cheaperButDoubted = g.attempt(task, "agent-c");

    g.scored(first, oid("a"), T.judged(passing(10), 600));
    g.scored(surer, oid("b"), T.judged(passing(10), 900));
    g.scored(cheaperButDoubted, oid("c"), T.judged(passing(9), 510));
    expect(g.accept(task).accepted).toBe(cheaperButDoubted);

    const next = g.task("add a /ready route");
    const nextFirst = g.attempt(next, "agent-a");
    const nextSurer = g.attempt(next, "agent-b");

    g.scored(nextFirst, oid("d"), T.judged(passing(10), 600));
    g.scored(nextSurer, oid("e"), T.judged(passing(10), 900));
    expect(g.accept(next).accepted).toBe(nextSurer);
  });

  test("a score stored before judges reads back unjudged", () => {
    const stored = Schema.decodeUnknownSync(T.Score)({ checks_passed: 3, checks_total: 3, cost: 7 });

    expect(stored.confidence ?? null).toBeNull();
    expect(T.judged(passing(7), 2000).confidence).toBe(1000);
  });

  test("accept takes the cheapest passing attempt and closes the rest", () => {
    const g = grow();
    const root = T.head(g.get()).id;
    const task = g.task("add a /health route");
    const costly = g.attempt(task, "agent-a");
    const cheap = g.attempt(task, "agent-b");
    const failing = g.attempt(task, "agent-c");
    const unfinished = g.attempt(task, "agent-d");

    g.scored(costly, oid("a"), passing(900));
    g.scored(cheap, oid("b"), passing(120));
    g.scored(failing, oid("c"), ok(makeScore(2, 3, 1)));

    const acceptance = g.accept(task);

    expect(acceptance.accepted).toBe(cheap);
    expect(acceptance.closed).toEqual([costly, failing, unfinished]);
    expect(acceptance.behind).toEqual([]);

    const head = T.head(g.get());

    expect([head.id, head.parent, head.commit, head.accepted_from, head.repo]).toEqual([acceptance.node, root, oid("b"), cheap, repo(`t-a${cheap}`)]);
    expect(T.task(g.get(), task)?.state).toEqual({ Done: { attempt: cheap, node: acceptance.node } });
    expect(T.attempt(g.get(), cheap)?.state).toEqual({ Accepted: { node: acceptance.node } });
    expect(T.historyOf(g.get(), task).map((entry) => [entry.attempt, entry.reason, entry.score])).toEqual([
      [costly, { Lost: { to: cheap } }, passing(900)],
      [failing, { Lost: { to: cheap } }, ok(makeScore(2, 3, 1))],
      [unfinished, { Lost: { to: cheap } }, null],
    ]);
  });

  test("equal cost goes to the earliest attempt", () => {
    const g = grow();
    const task = g.task("intent");
    const first = g.attempt(task, "a");
    const second = g.attempt(task, "b");

    g.scored(second, oid("b"), passing(5));
    g.scored(first, oid("a"), passing(5));
    expect(g.accept(task).accepted).toBe(first);
  });

  test("nothing to accept without a passing scored attempt", () => {
    const g = grow();
    const task = g.task("intent");
    const attempt = g.attempt(task, "a");

    expect(refusal(T.accept(g.get(), task))).toBe("NothingToAccept");
    g.scored(attempt, oid("a"), ok(makeScore(0, 1, 0)));
    expect(refusal(T.accept(g.get(), task))).toBe("NothingToAccept");
    expect(T.head(g.get()).id).toBe(NodeId.make(0));
  });

  test("an acceptance leaves other tasks behind, and they retry instead of merging", () => {
    const g = grow();
    const auth = g.task("add auth");
    const search = g.task("add search");
    const authAttempt = g.attempt(auth, "a");
    const searchAttempt = g.attempt(search, "b");

    g.scored(authAttempt, oid("a"), passing(1));
    g.scored(searchAttempt, oid("b"), passing(1));

    const acceptance = g.accept(auth);

    expect(acceptance.behind).toEqual([searchAttempt]);

    // Scored and passing, but checked against the old root: not acceptable.
    expect(refusal(T.accept(g.get(), search))).toBe("NothingToAccept");

    const retried = ok(T.retry(g.get(), searchAttempt));

    g.set(retried.tree);

    const restarted = T.attempt(g.get(), retried.attempt);

    expect([restarted?.task, restarted?.agent, restarted?.base, restarted?.state]).toEqual([search, "b", acceptance.node, "Working"]);
    expect(T.historyOf(g.get(), search).map((entry) => [entry.attempt, entry.reason])).toEqual([[searchAttempt, { Retried: { into: retried.attempt } }]]);

    g.scored(retried.attempt, oid("c"), passing(1));

    const second = g.accept(search);

    expect(T.node(g.get(), second.node)?.parent).toBe(acceptance.node);
  });

  test("retry refuses an attempt that is on the head", () => {
    const g = grow();
    const attempt = g.attempt(g.task("intent"), "a");

    expect(refusal(T.retry(g.get(), attempt))).toBe("NotBehind");
  });

  test("a done task takes no more attempts", () => {
    const g = grow();
    const task = g.task("intent");

    g.scored(g.attempt(task, "a"), oid("a"), passing(1));
    g.accept(task);
    expect(refusal(T.start(g.get(), task, "late"))).toBe("TaskDone");
    expect(refusal(T.accept(g.get(), task))).toBe("TaskDone");
  });

  test("an attempt scores once and abandons into the history", () => {
    const g = grow();
    const task = g.task("intent");
    const attempt = g.attempt(task, "a");

    g.set(ok(T.submit(g.get(), attempt, oid("a"))));
    expect(refusal(T.submit(g.get(), attempt, oid("b")))).toBe("NotWorking");
    g.set(ok(T.scored(g.get(), attempt, passing(1), [])));
    expect(refusal(T.scored(g.get(), attempt, passing(0), []))).toBe("NotChecking");
    g.set(ok(T.abandon(g.get(), attempt, "lost interest")));
    expect(refusal(T.abandon(g.get(), attempt, "again"))).toBe("NotOpen");

    const entry = T.historyOf(g.get(), task)[0];

    expect([entry?.reason, entry?.score]).toEqual([{ Abandoned: { note: "lost interest" } }, passing(1)]);
  });

  test("a submitted attempt waits for its checks and cannot be accepted yet", () => {
    const g = grow();
    const task = g.task("intent");
    const attempt = g.attempt(task, "a");

    expect(refusal(T.scored(g.get(), attempt, passing(1), []))).toBe("NotChecking");
    g.set(ok(T.submit(g.get(), attempt, oid("a"))));
    expect(T.checking(g.get()).map((waiting) => [waiting.attempt.id, waiting.commit])).toEqual([[attempt, oid("a")]]);
    expect(refusal(T.accept(g.get(), task))).toBe("NothingToAccept");
    g.set(ok(T.scored(g.get(), attempt, passing(1), [])));
    expect(T.checking(g.get())).toEqual([]);
    expect(g.accept(task).accepted).toBe(attempt);
  });

  test("an empty intent is refused", () => {
    expect(refusal(T.taskNew(fresh(), "  ", []))).toBe("EmptyIntent");
  });

  test("attempts get their own repo, and accept hands it to the node", () => {
    const g = grow(fresh("site"));

    expect(T.head(g.get()).repo).toBe(repo("site"));

    const task = g.task("intent");
    const attempt = g.attempt(task, "a");

    expect(T.attempt(g.get(), attempt)?.repo).toBe(repo(`site-a${attempt}`));
    g.scored(attempt, oid("a"), passing(1));
    const acceptance = g.accept(task);

    expect(T.node(g.get(), acceptance.node)?.repo).toBe(T.attempt(g.get(), attempt)!.repo);
  });

  test("repo names follow Artifacts' rules and leave room for attempts", () => {
    const valid = Schema.is(RepoName);

    expect(valid("my_repo-1.0")).toBe(true);
    expect(valid("")).toBe(false);
    expect(valid("has space")).toBe(false);
    expect(valid("a".repeat(64))).toBe(false);
    expect(refusal(T.init(repo("a".repeat(60)), oid("0")))).toBe("MalformedRepoName");
  });

  test("the tree round-trips through JSON", () => {
    const g = grow();

    g.scored(g.attempt(g.task("intent"), "a"), oid("a"), passing(1));

    const json = JSON.stringify(g.get());

    expect(ok(T.decodeTree(JSON.parse(json)))).toEqual(g.get());
    expect(Result.isFailure(T.decodeTree(JSON.parse(json.replace("0".repeat(40), "not-an-oid"))))).toBe(true);
  });

  test("a behind attempt is rebased onto the head without its agent", () => {
    const g = grow();
    const auth = g.task("add auth");
    const search = g.task("add search");
    const authAttempt = g.attempt(auth, "a");
    const searchAttempt = g.attempt(search, "b");

    g.scored(authAttempt, oid("a"), passing(1), ["auth.rs"]);
    g.scored(searchAttempt, oid("b"), passing(1), ["search.rs"]);

    const first = g.accept(auth);

    // Disjoint paths: the head sees nothing in the way.
    expect(T.allBehind(g.get())).toEqual([{ attempt: searchAttempt, behind: 1, overlap: [], rebase: null }]);
    expect(T.rebaseable(g.get()).map((entry) => entry.id)).toEqual([searchAttempt]);

    const started = ok(T.rebaseStart(g.get(), searchAttempt));

    g.set(started.tree);
    expect(started.commit).toBe(oid("b"));

    const replay = T.attempt(g.get(), started.fresh);

    expect([replay?.task, replay?.agent, replay?.base, replay?.rebase_of]).toEqual([search, "b", first.node, searchAttempt]);

    // In flight: not offered again, and not for an agent to retry either.
    expect(T.rebaseable(g.get())).toEqual([]);
    expect(refusal(T.retry(g.get(), searchAttempt))).toBe("Rebasing");
    expect(refusal(T.rebaseStart(g.get(), searchAttempt))).toBe("Rebasing");

    g.set(ok(T.rebaseDone(g.get(), started.fresh, oid("c"))));
    expect(T.attempt(g.get(), started.fresh)?.state).toEqual({ Checking: { commit: oid("c") } });
    expect(T.attempt(g.get(), searchAttempt)?.state).toEqual({ Closed: { reason: { Rebased: { into: started.fresh } } } });
    g.set(ok(T.scored(g.get(), started.fresh, passing(1), ["search.rs"])));

    const second = g.accept(search);

    expect(T.node(g.get(), second.node)?.parent).toBe(first.node);
    expect(T.allBehind(g.get())).toEqual([]);
  });

  test("a failed rebase leaves the behind attempt for its agent to retry", () => {
    const g = grow();
    const a = g.task("a");
    const b = g.task("b");
    const aAttempt = g.attempt(a, "x");
    const bAttempt = g.attempt(b, "y");

    g.scored(aAttempt, oid("a"), passing(1), ["lib.rs", "a.rs"]);
    g.scored(bAttempt, oid("b"), passing(1), ["lib.rs", "b.rs"]);
    g.accept(a);
    expect(T.behind(g.get(), T.attempt(g.get(), bAttempt)!)?.overlap).toEqual(["lib.rs"]);

    const started = ok(T.rebaseStart(g.get(), bAttempt));

    g.set(ok(T.rebaseFailed(started.tree, started.fresh, "conflict in lib.rs")));
    expect(T.attempt(g.get(), started.fresh)?.state).toEqual({ Closed: { reason: { Abandoned: { note: "conflict in lib.rs" } } } });

    const old = T.attempt(g.get(), bAttempt)!;

    // The behind attempt is the agent's to retry, and the machine will not try again.
    expect(T.isOpen(old)).toBe(true);
    expect(old.rebase).toBe(started.fresh);
    expect(T.rebaseable(g.get())).toEqual([]);
    expect(T.behind(g.get(), old)?.rebase).toBe(started.fresh);
    expect(refusal(T.rebaseDone(g.get(), started.fresh, oid("c")))).toBe("NotRebase");

    const retried = ok(T.retry(g.get(), bAttempt));

    g.set(retried.tree);
    expect(T.task(g.get(), b)?.retries).toBe(1);
    expect(T.historyOf(g.get(), b).map((entry) => [entry.attempt, entry.reason])).toEqual([
      [started.fresh, { Abandoned: { note: "conflict in lib.rs" } }],
      [bAttempt, { Retried: { into: retried.attempt } }],
    ]);
  });

  test("a rebase the sandbox could not run is offered again", () => {
    const g = grow();
    const a = g.task("a");
    const b = g.task("b");
    const aAttempt = g.attempt(a, "x");
    const bAttempt = g.attempt(b, "y");

    g.scored(aAttempt, oid("a"), passing(1));
    g.scored(bAttempt, oid("b"), passing(1));
    g.accept(a);

    const started = ok(T.rebaseStart(g.get(), bAttempt));

    g.set(ok(T.rebaseRetry(started.tree, started.fresh, "sandbox unreachable")));
    expect(T.attempt(g.get(), bAttempt)?.rebase ?? null).toBeNull();
    expect(T.rebaseable(g.get()).map((entry) => entry.id)).toEqual([bAttempt]);
    expect(ok(T.rebaseStart(g.get(), bAttempt)).fresh).not.toBe(started.fresh);
  });

  test("only a submitted attempt can be rebased", () => {
    const g = grow();
    const a = g.task("a");
    const b = g.task("b");
    const aAttempt = g.attempt(a, "x");
    const working = g.attempt(b, "y");

    g.scored(aAttempt, oid("a"), passing(1));
    g.accept(a);
    expect(T.isBehind(g.get(), T.attempt(g.get(), working)!)).toBe(true);
    expect(T.rebaseable(g.get())).toEqual([]);
    expect(refusal(T.rebaseStart(g.get(), working))).toBe("NothingToRebase");

    const onHead = g.attempt(b, "z");

    g.set(ok(T.submit(g.get(), onHead, oid("b"))));
    expect(refusal(T.rebaseStart(g.get(), onHead))).toBe("NotBehind");
  });

  test("a task retries a bounded number of times", () => {
    const g = grow();
    const slow = g.task("slow");
    let attempt = g.attempt(slow, "s");

    for (let round = 0; round < T.MAX_RETRIES; round += 1) {
      const fast = g.task(`fast ${round}`);

      g.scored(g.attempt(fast, "f"), oid("a"), passing(1));
      g.accept(fast);

      const retried = ok(T.retry(g.get(), attempt));

      g.set(retried.tree);
      attempt = retried.attempt;
    }

    const last = g.task("last");

    g.scored(g.attempt(last, "f"), oid("a"), passing(1));
    g.accept(last);
    expect(refusal(T.retry(g.get(), attempt))).toBe("TaskExhausted");

    // The task is still open: its owner can abandon it or split it.
    expect(T.task(g.get(), slow)?.state).toBe("Open");
    expect(Result.isSuccess(T.start(g.get(), slow, "human"))).toBe(true);
  });

  test("a task carries its own checks and refuses broken ones", () => {
    const g = grow();
    const check = (name: string, run: string): CheckSpec => ({ name, run });
    const task = g.task("dark mode", [check("toggle", "grep -q dark-mode ui.css")]);

    expect(T.task(g.get(), task)?.checks).toHaveLength(1);

    const duplicate = T.taskNew(g.get(), "x", [check("a", "true"), check("a", "true")]);

    expect(refusal(duplicate)).toBe("TaskChecks");
    expect(Result.isFailure(duplicate) ? duplicate.failure.message : "").toContain("appears twice");
    expect(refusal(T.taskNew(g.get(), "x", [check("a", " ")]))).toBe("TaskChecks");
  });

  test("accept-next takes the oldest task that is ready", () => {
    const g = grow();
    const old = g.task("old");
    const mid = g.task("mid");
    const latest = g.task("new");

    g.attempt(old, "a");

    const midAttempt = g.attempt(mid, "b");
    const newAttempt = g.attempt(latest, "c");

    expect(refusal(T.acceptNext(g.get()))).toBe("NothingScored");
    g.scored(newAttempt, oid("c"), passing(1));
    g.scored(midAttempt, oid("b"), passing(1));
    expect(T.acceptable(g.get())).toEqual([mid, latest]);

    const next = ok(T.acceptNext(g.get()));

    g.set(next.tree);
    expect(next.acceptance.accepted).toBe(midAttempt);

    // `new` is behind now, and `old` never scored.
    expect(T.acceptable(g.get())).toEqual([]);
    expect(refusal(T.acceptNext(g.get()))).toBe("NothingScored");
  });

  test("a release points at a node, and moving it back is a rollback", () => {
    const g = grow();

    expect(T.released(g.get())).toBeUndefined();

    const task = g.task("intent");

    g.scored(g.attempt(task, "a"), oid("a"), passing(1));

    const acceptance = g.accept(task);
    const first = ok(T.release(g.get(), acceptance.node));

    expect(first.release).toEqual({ node: acceptance.node, previous: null, rollback: false });
    g.set(first.tree);
    expect(T.released(g.get())?.commit).toBe(oid("a"));

    const back = ok(T.release(g.get(), NodeId.make(0)));

    expect(back.release).toEqual({ node: NodeId.make(0), previous: acceptance.node, rollback: true });
    expect(refusal(T.release(g.get(), NodeId.make(99)))).toBe("UnknownNode");
    expect(ok(T.decodeTree(JSON.parse(JSON.stringify(back.tree))))).toEqual(back.tree);
  });

  /** A tree saved by the version that spoke of buds, leaves, harvests and compost loads unchanged. */
  test("a tree saved in the old vocabulary still loads", () => {
    const tree = ok(T.decodeTree(legacyTree));
    const id = (raw: number) => AttemptId.make(raw);

    expect(T.head(tree).id).toBe(NodeId.make(9));
    expect(T.released(tree)?.id).toBe(NodeId.make(9));
    expect(T.head(tree).accepted_from).toBe(id(4));
    expect(T.openTasks(tree)).toHaveLength(2);
    expect(T.task(tree, TaskId.make(1))?.state).toEqual({ Done: { attempt: id(4), node: NodeId.make(9) } });
    expect(T.task(tree, TaskId.make(1))?.checks?.[0]?.name).toBe("done");
    expect(T.task(tree, TaskId.make(3))?.retries).toBe(1);
    expect(tree.history.map((entry) => [entry.attempt, entry.reason])).toEqual([
      [id(5), { Lost: { to: id(4) } }],
      [id(6), { Rebased: { into: id(10) } }],
      [id(11), { Abandoned: { note: "conflict in lib.rs" } }],
      [id(7), { Retried: { into: id(12) } }],
      [id(12), { Abandoned: { note: "gave up" } }],
    ]);
    expect(T.attempt(tree, id(10))?.state).toEqual({ Checking: { commit: oid("5") } });
    expect(T.attempt(tree, id(8))?.state).toBe("Working");
    expect(T.attempt(tree, id(7))?.rebase).toBe(id(11));

    // Saving writes the new names only.
    const saved = JSON.stringify(tree);

    for (const old of ["buds", "leaves", "compost", "fruit_of", "regrowths", "transplant", "Fruited", "Pruned", "Growing", "Outgrown"]) {
      expect(saved).not.toContain(`"${old}"`);
    }
  });
});
