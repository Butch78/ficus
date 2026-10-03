import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { scoreOf, type AttemptRef, type CheckSpec } from "../core/scoring.ts";
import { Oid } from "../core/values.ts";
import { check, failedDerivation, fetch, numstatCost, prepare, rebase, score } from "./scorer.ts";
import { isInputProblem, type ScoreError, tail, TAIL_CHARS } from "./shell.ts";

const scratch: Array<string> = [];

afterAll(() => {
  for (const dir of scratch) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "ficus-scorer-"));

  scratch.push(dir);

  return dir;
};

const gitIn = (dir: string, args: ReadonlyArray<string>) => {
  const ran = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir });

  if (ran.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
  }

  return ran.stdout.toString().trim();
};

const commitIn = (dir: string, files: ReadonlyArray<readonly [string, string]>, deletions: ReadonlyArray<string> = []) => {
  for (const [path, body] of files) {
    writeFileSync(join(dir, path), body);
  }

  for (const path of deletions) {
    unlinkSync(join(dir, path));
  }

  gitIn(dir, ["add", "-A"]);
  gitIn(dir, ["commit", "--quiet", "--allow-empty", "-m", "c"]);

  return Oid.make(gitIn(dir, ["rev-parse", "HEAD"]));
};

/** An origin repo standing in for an attempt's Artifacts repo, and a scratch root for workdirs. */
const fixture = () => {
  const dir = tempDir();
  const origin = join(dir, "origin");

  mkdirSync(origin);
  gitIn(origin, ["init", "--quiet", "-b", "main"]);

  return {
    origin,
    work: join(dir, "work"),
    git: (args: ReadonlyArray<string>) => gitIn(origin, args),
    commit: (files: ReadonlyArray<readonly [string, string]>, deletions: ReadonlyArray<string> = []) => commitIn(origin, files, deletions),
    request: (base: Oid, head: Oid, checks: ReadonlyArray<CheckSpec> = []): AttemptRef => ({ remote: origin, base, head, checks }),
  };
};

const ok = <A>(effect: Effect.Effect<A, ScoreError>) => Effect.runPromise(effect);

const failure = async <A>(effect: Effect.Effect<A, ScoreError>) => {
  const exit = await Effect.runPromiseExit(effect);
  const error = Exit.isFailure(exit) ? Option.getOrUndefined(Exit.findErrorOption(exit)) : undefined;

  if (error === undefined) {
    throw new Error("expected a typed failure");
  }

  return error;
};

const ROOT = '[[check]]\nname = "has-greeting"\nrun = "grep -q hello greeting.txt"\n\n[[check]]\nname = "no-todo"\nrun = "! grep -rq TODO --include=*.txt ."\n';

const passes = (report: Parameters<typeof scoreOf>[0]) => {
  const scored = scoreOf(report);

  return Result.isSuccess(scored) && scored.success.checks_passed === scored.success.checks_total;
};

describe("scoring", () => {
  test("runs the root's checks and costs the diff", async () => {
    const repo = fixture();
    const base = repo.commit([["ficus.toml", ROOT], ["greeting.txt", "hi\n"]]);
    const head = repo.commit([["greeting.txt", "hello\nworld\n"]]);
    const { report } = await ok(score(repo.work, repo.request(base, head)));

    expect(report.checks.map((outcome) => [outcome.name, outcome.passed])).toEqual([
      ["has-greeting", true],
      ["no-todo", true],
    ]);
    // greeting.txt: 1 line deleted, 2 added.
    expect(report.cost).toBe(3);
    expect(passes(report)).toBe(true);
  });

  test("the root's fetch runs between prepare and check, and names its hosts", async () => {
    const repo = fixture();
    const root = '[fetch]\nhosts = ["static.crates.io"]\nrun = "echo fetched > deps.txt"\n\n[[check]]\nname = "has-deps"\nrun = "grep -q fetched deps.txt"\n';
    const base = repo.commit([["ficus.toml", root], ["a.txt", "a\n"]]);
    const head = repo.commit([["a.txt", "b\n"]]);
    const prepared = await ok(prepare(repo.work, repo.request(base, head)));

    expect(prepared.hosts).toEqual(["static.crates.io"]);
    await ok(fetch(prepared.workdir));

    const { report } = await ok(check(prepared.workdir));

    expect(passes(report)).toBe(true);
  });

  test("a failed fetch fails every check with its output", async () => {
    const repo = fixture();
    const base = repo.commit([["ficus.toml", '[fetch]\nrun = "echo no such crate >&2; exit 3"\n\n[[check]]\nname = "t"\nrun = "true"\n']]);
    const head = repo.commit([["a.txt", "a\n"]]);
    const only = (await ok(score(repo.work, repo.request(base, head)))).report.checks[0];

    expect(only?.passed).toBe(false);
    expect(only?.tail).toContain("the root's fetch failed");
    expect(only?.tail).toContain("no such crate");
  });

  test("a failing check fails, and keeps its output", async () => {
    const repo = fixture();
    const base = repo.commit([["ficus.toml", ROOT], ["greeting.txt", "hello\n"]]);
    const head = repo.commit([["notes.txt", "TODO: finish\n"]]);
    const { report } = await ok(score(repo.work, repo.request(base, head)));

    expect(report.checks.find((outcome) => outcome.name === "no-todo")?.passed).toBe(false);
    expect(passes(report)).toBe(false);
  });

  test("the attempt cannot rewrite or delete the root's checks", async () => {
    const repo = fixture();
    const base = repo.commit([["ficus.toml", ROOT], ["greeting.txt", "hi\n"]]);
    // The agent replaces the checks with one that always passes, and adds a devenv.nix the root never had.
    const head = repo.commit([["ficus.toml", '[[check]]\nname = "has-greeting"\nrun = "true"\n'], ["devenv.nix", "{ }"]]);
    const { report } = await ok(score(repo.work, repo.request(base, head)));

    expect(report.checks.find((outcome) => outcome.name === "has-greeting")?.passed).toBe(false);
    // The root's two checks, not the attempt's one; locked files are not part of the cost.
    expect([report.checks.length, report.cost]).toEqual([2, 0]);

    const deleted = repo.commit([], ["ficus.toml", "devenv.nix"]);

    expect((await ok(score(repo.work, repo.request(base, deleted)))).report.checks).toHaveLength(2);
  });

  test("hands the root's judges the diff, without locked files", async () => {
    const repo = fixture();
    const base = repo.commit([["ficus.toml", `${ROOT}\n[[judge]]\nname = "greets"\nask = "Does \`diff\` greet?"\n`], ["greeting.txt", "hi\n"]]);
    const head = repo.commit([["greeting.txt", "hello\n"], ["ficus.toml", '[[check]]\nname = "x"\nrun = "true"\n']]);
    const run = await ok(score(repo.work, repo.request(base, head)));

    expect(run.judges.map((judge) => judge.name)).toEqual(["greets"]);
    expect(run.diff).toContain("+hello");
    expect(run.diff).not.toContain("ficus.toml");
    // Judges are not run in the container.
    expect(run.report.checks).toHaveLength(2);
  });

  test("a root without judges hands over no diff", async () => {
    const repo = fixture();
    const base = repo.commit([["ficus.toml", ROOT], ["greeting.txt", "hi\n"]]);
    const run = await ok(score(repo.work, repo.request(base, repo.commit([["greeting.txt", "hello\n"]]))));

    expect([run.judges.length, run.diff]).toEqual([0, ""]);
  });

  test("a root without ficus.toml cannot score anything", async () => {
    const repo = fixture();
    const base = repo.commit([["greeting.txt", "hi\n"]]);
    const error = await failure(score(repo.work, repo.request(base, repo.commit([["greeting.txt", "hello\n"]]))));

    expect(error.kind).toBe("NoRootChecks");
    expect(isInputProblem(error)).toBe(true);
  });

  test("head must descend from base", async () => {
    const repo = fixture();
    const base = repo.commit([["ficus.toml", ROOT], ["greeting.txt", "hello\n"]]);

    repo.git(["checkout", "--quiet", "--orphan", "other"]);

    // Different content: an identical tree, message and second would make the very same root commit.
    const unrelated = repo.commit([["greeting.txt", "hello, elsewhere\n"]]);

    expect((await failure(score(repo.work, repo.request(base, unrelated)))).kind).toBe("NotDescendant");
  });

  test("a check that overruns its timeout fails", async () => {
    const repo = fixture();
    const base = repo.commit([["ficus.toml", '[[check]]\nname = "slow"\nrun = "sleep 5"\ntimeout_secs = 1\n']]);
    const { report } = await ok(score(repo.work, repo.request(base, repo.commit([["a.txt", "a\n"]]))));

    expect([report.checks[0]?.passed, report.checks[0]?.tail]).toEqual([false, "timed out after 1s"]);
  });

  test("the task's checks run after the root's, and say whose they are", async () => {
    const repo = fixture();
    const base = repo.commit([["ficus.toml", ROOT], ["greeting.txt", "hello\n"]]);
    const head = repo.commit([["greeting.txt", "hello\n"], ["notes.txt", "fine\n"]]);

    const checks: ReadonlyArray<CheckSpec> = [
      { name: "did-the-task", run: "grep -q dark notes.txt" },
      { name: "has-notes", run: "test -f notes.txt", timeout_secs: 5 },
    ];

    const { report } = await ok(score(repo.work, repo.request(base, head, checks)));

    expect(report.checks.map((outcome) => [outcome.name, outcome.origin, outcome.passed])).toEqual([
      ["has-greeting", "root", true],
      ["no-todo", "root", true],
      ["did-the-task", "task", false],
      ["has-notes", "task", true],
    ]);
    // The root's checks alone are not done.
    expect(passes(report)).toBe(false);
    expect(report.touched).toEqual(["notes.txt"]);
  });

  test("touched paths leave out the locked files", async () => {
    const repo = fixture();
    const base = repo.commit([["ficus.toml", ROOT], ["greeting.txt", "hello\n"]]);
    const head = repo.commit([["ficus.toml", "cheat"], ["b.txt", "b\n"], ["a.txt", "a\n"]]);

    expect((await ok(score(repo.work, repo.request(base, head)))).report.touched).toEqual(["a.txt", "b.txt"]);
  });
});

describe("output", () => {
  test("numstat counts lines, and a binary file as one", () => {
    expect([numstatCost("3\t2\tsrc/a.rs"), numstatCost("-\t-\timage.png"), numstatCost("")]).toEqual([5, 1, 0]);
  });

  test("devenv names the shell it could not build", () => {
    const output = "  × Failed to realize shell derivation: error: Cannot build '/nix/store/xdmf-devenv-shell.drv'.\n    Reason: 1 dependency failed.";

    expect([failedDerivation(output), failedDerivation("Cannot build 'x'"), failedDerivation("all fine")]).toEqual(["/nix/store/xdmf-devenv-shell.drv", undefined, undefined]);
  });

  test("a tail keeps the errors its cut dropped, without colours", () => {
    const noise = "evaluating file x\n".repeat(TAIL_CHARS / 10);
    const kept = tail(`\u001b[31;1merror:\u001b[0m cannot download bun-linux-x64.zip\n${noise}Reason: 1 dependency failed\n`);

    expect(kept.startsWith("error: cannot download bun-linux-x64.zip\n…\n")).toBe(true);
    expect(kept.endsWith("Reason: 1 dependency failed\n")).toBe(true);
    expect(kept).not.toContain("\u001b");
  });

  test("a tail keeps the end", () => {
    const kept = tail(`${"a".repeat(10)}é${"b".repeat(TAIL_CHARS - 1)}`);

    expect(kept.length <= TAIL_CHARS && kept.endsWith("b") && !kept.includes("a")).toBe(true);
  });
});

/** Two repos as Artifacts would hold them: the behind attempt, forked from the old head, and the fresh one, forked from the new head. */
const orchard = (attemptFiles: ReadonlyArray<readonly [string, string]>, headFiles: ReadonlyArray<readonly [string, string]>) => {
  const dir = tempDir();
  const behind = join(dir, "behind");
  const fresh = join(dir, "fresh");

  mkdirSync(behind);
  gitIn(behind, ["init", "--quiet", "-b", "main"]);

  const root = commitIn(behind, [["ficus.toml", ROOT], ["greeting.txt", "hello\n"]]);

  gitIn(dir, ["clone", "--quiet", "behind", "fresh"]);

  const behindHead = commitIn(behind, attemptFiles);
  const newHead = commitIn(fresh, headFiles);

  // Pushing into a checked-out branch is what Artifacts allows.
  gitIn(fresh, ["config", "receive.denyCurrentBranch", "updateInstead"]);

  return {
    fresh,
    work: join(dir, "work"),
    newHead,
    job: { from: behind, from_base: root, from_head: behindHead, onto: fresh, onto_head: newHead, onto_branch: "main" },
  };
};

describe("rebasing", () => {
  test("replays the attempt onto the new head, and pushes", async () => {
    const grown = orchard([["search.rs", "fn search() {}\n"]], [["auth.rs", "fn auth() {}\n"]]);
    const report = await ok(rebase(grown.work, grown.job));

    expect(report.replayed).toBe(1);
    expect(gitIn(grown.fresh, ["rev-parse", "main"])).toBe(report.commit);
    // Single parent: the new head.
    expect(gitIn(grown.fresh, ["rev-parse", "main^"])).toBe(grown.newHead);

    const files = gitIn(grown.fresh, ["ls-tree", "--name-only", "main"]);

    expect(files.includes("auth.rs") && files.includes("search.rs")).toBe(true);
  });

  test("a conflicting rebase names the paths, and pushes nothing", async () => {
    const grown = orchard([["greeting.txt", "hello from the attempt\n"]], [["greeting.txt", "hello from the head\n"]]);
    const error = await failure(rebase(grown.work, grown.job));

    expect(error.kind).toBe("Conflict");
    expect(error.message).toContain("greeting.txt");
    expect(isInputProblem(error)).toBe(true);
    expect(gitIn(grown.fresh, ["rev-parse", "main"])).toBe(grown.newHead);
  });
});
