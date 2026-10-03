/**
 * Score an attempt: clone it, put the root's locked files back from the base
 * commit, build the root's devenv and run its `[fetch]`, run the root's
 * checks then the task's (inside that devenv when there is one), and measure
 * the diff. The root's judges are not run here (the container has no
 * network): `check` hands them over with the diff they judge.
 *
 * Also rebase an attempt: replay its commits onto a newer head in a fresh
 * attempt, so the checks can run there. Conflicts are reported, never
 * resolved: that is the agent's job, with the history in hand.
 *
 * And deploy a released node: clone its commit and run the `[deploy]` its own
 * `ficus.toml` names.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { DeployPrepared, type DeployRef, type DeployReport } from "../core/deploy.ts";
import { stepLine, type ScoreStep, type StepState } from "../core/progress.ts";
import {
  AttemptRef,
  type CheckOrigin,
  type CheckOutcome,
  type CheckRun,
  type CheckSpec,
  checkRoot,
  checkTimeoutSecs,
  clipDiff,
  decodeRoot,
  DeploySpec,
  deployTimeoutSecs,
  FetchSpec,
  LOCKED_PATHS,
  type RebaseRef,
  type RebaseReport,
  type RootChecks,
} from "../core/scoring.ts";
import { Oid } from "../core/values.ts";
import { git, removeAll, run, ScoreError, succeeds } from "./shell.ts";

/** Building a root's devenv shell from cold can take a while; it is paid once per container. */
const DEVENV_PREPARE_SECS = 1200;

/** A root's fetch gets this long unless its `[fetch]` says otherwise. */
const FETCH_DEFAULT_SECS = 1800;

/** The prefix of a progress line on stderr: the sandbox forwards these as the attempt's scoring steps. */
export const PROGRESS_PREFIX = "ficus-progress ";

const PREPARED_FILE = "prepared.json";

/** What `prepare` and `fetch` leave in the workdir for `check`. */
const Prepared = Schema.Struct({
  attempt: AttemptRef,
  /** Whether the root has a devenv: its checks run inside its shell. */
  in_devenv: Schema.Boolean,
  /** The root's `[fetch]`, as of the base commit. */
  fetch: FetchSpec,
  /** Set by `fetch`: the reason every check fails when the root's devenv did not build or its fetch failed; `""` when all went well. */
  fetched: Schema.optional(Schema.String),
});

type Prepared = typeof Prepared.Type;

/** What `prepare` hands the sandbox: where the attempt is, and the hosts the root's `[fetch]` opens next. */
export interface PreparedAttempt {
  readonly workdir: string;
  readonly hosts: ReadonlyArray<string>;
}

const io = (message: string) => (cause: unknown) => new ScoreError({ kind: "Io", message: `${message}: ${String(cause)}` });

/** Say a step changed state, on stderr, as it happens. */
const progress = (step: ScoreStep, state: StepState, item?: string, detail?: string) =>
  Effect.sync(() => {
    process.stderr.write(PROGRESS_PREFIX + stepLine(step, state, item, detail));
  });

/** Run `work` as `step`: active before, complete or error after. */
const stepped = <A, R>(step: ScoreStep, work: Effect.Effect<A, ScoreError, R>) =>
  progress(step, "active").pipe(
    Effect.andThen(work),
    Effect.tap(() => progress(step, "complete")),
    Effect.tapError((error) => progress(step, "error", undefined, error.message)),
  );

const readPrepared = Effect.fn("Scorer.readPrepared")(function* (workdir: string) {
  const text = yield* Effect.tryPromise({ try: () => readFile(join(workdir, PREPARED_FILE), "utf8"), catch: io("reading the prepared attempt") });

  return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Prepared))(text).pipe(Effect.mapError(io("decoding the prepared attempt")));
});

const writePrepared = (workdir: string, prepared: Prepared) =>
  Effect.tryPromise({ try: () => writeFile(join(workdir, PREPARED_FILE), JSON.stringify(prepared)), catch: io("writing the prepared attempt") });

/** The root's config from `ficus.toml` text, decoded strictly and checked. */
export const parseRoot = (text: string) =>
  Result.try({ try: () => Bun.TOML.parse(text), catch: (cause) => new ScoreError({ kind: "RootChecks", message: `ficus.toml does not parse: ${String(cause)}` }) }).pipe(
    Result.flatMap((parsed) =>
      decodeRoot(parsed, { onExcessProperty: "error" }).pipe(Result.mapError((issue) => new ScoreError({ kind: "RootChecks", message: `ficus.toml does not parse: ${issue.message}` }))),
    ),
    Result.flatMap((root) => checkRoot(root).pipe(Result.mapError((error) => new ScoreError({ kind: "RootChecks", message: error.message })))),
  );

/** The root's checks, always read from the base commit. */
const rootChecks = Effect.fn("Scorer.rootChecks")(function* (repo: string, base: string) {
  const text = yield* git(repo, "show ficus.toml", ["show", `${base}:ficus.toml`]).pipe(
    Effect.mapError((error) =>
      error.kind === "Git" ? new ScoreError({ kind: "NoRootChecks", message: "the base commit has no ficus.toml, so the root defines no checks" }) : error,
    ),
  );

  return yield* Effect.fromResult(parseRoot(text));
});

/**
 * Phase one, with the network open to the attempt's repo: clone it into a
 * fresh workdir under `root`, check `head` descends from `base`, and put the
 * root's locked files back. Answers the workdir and the hosts the root's
 * `[fetch]` needs for phase two.
 */
export const prepare = Effect.fn("Scorer.prepare")(function* (root: string, attempt: AttemptRef) {
  const workdir = join(root, attempt.head);
  const repo = join(workdir, "attempt");
  const [base, head] = [attempt.base, attempt.head];

  yield* removeAll(workdir);
  yield* Effect.tryPromise({ try: () => mkdir(workdir, { recursive: true }), catch: io("making the workdir") });

  yield* stepped(
    "clone",
    Effect.gen(function* () {
      yield* git(workdir, "clone", ["clone", "--quiet", "--no-checkout", attempt.remote, repo]);
      yield* git(repo, "checkout", ["checkout", "--quiet", "--detach", head]);

      if (!(yield* succeeds(repo, ["merge-base", "--is-ancestor", base, head]))) {
        return yield* new ScoreError({ kind: "NotDescendant", message: "head does not descend from base" });
      }
    }),
  );

  // Fail now, while it is cheap, if the root defines nothing to run.
  const fetch = (yield* rootChecks(repo, base)).fetch ?? {};

  const inDevenv = yield* stepped(
    "restore",
    Effect.gen(function* () {
      let hasDevenv = false;

      for (const path of LOCKED_PATHS) {
        if (yield* succeeds(repo, ["cat-file", "-e", `${base}:${path}`])) {
          yield* git(repo, "restore locked file", ["checkout", "--quiet", base, "--", path]);
          hasDevenv ||= path === "devenv.nix";
        } else {
          yield* removeAll(join(repo, path));
        }
      }

      return hasDevenv;
    }),
  );

  yield* writePrepared(workdir, { attempt, in_devenv: inDevenv, fetch });

  return { workdir, hosts: fetch.hosts ?? [] } satisfies PreparedAttempt;
});

/** `command` under bash in `repo`, inside the root's devenv shell when it has one. */
const inShell = (inDevenv: boolean, command: string) => (inDevenv ? ["devenv", "--quiet", "shell", "--", "bash", "-c", command] : ["bash", "-c", command]);

/** The derivation devenv says it could not build, from its output. */
export const failedDerivation = (output: string) => /Cannot build '(\/nix\/store\/[^']+\.drv)'/.exec(output)?.[1];

/** devenv says only that a dependency failed: build the shell again with nix itself, which names it and prints its log. */
const whyNotBuilt = Effect.fn("Scorer.whyNotBuilt")(function* (repo: string, derivation: string) {
  const again = yield* run(repo, ["nix", "build", "--no-link", "--print-build-logs", `${derivation}^*`], DEVENV_PREPARE_SECS);

  return `\n\nnix build ${derivation}:\n${again.tail}`;
});

/**
 * Phase two, with the network open to the root's `[fetch]` hosts and the nix
 * caches: build the root's devenv shell, then run the root's fetch in it. A
 * failure here is the root's or the attempt's, so it is recorded for `check`,
 * not raised.
 */
export const fetch = Effect.fn("Scorer.fetch")(function* (workdir: string) {
  const prepared = yield* readPrepared(workdir);
  const repo = join(workdir, "attempt");
  let fetched = "";

  if (prepared.in_devenv) {
    yield* progress("devenv", "active");

    const built = yield* run(repo, ["devenv", "--quiet", "shell", "--", "true"], DEVENV_PREPARE_SECS);

    yield* progress("devenv", built.passed ? "complete" : "error");

    if (!built.passed) {
      const derivation = failedDerivation(built.tail);
      const why = derivation === undefined ? "" : yield* whyNotBuilt(repo, derivation);

      fetched = `the root's devenv shell did not build:\n${built.tail}${why}`;
    }
  }

  const command = prepared.fetch.run;

  if (fetched === "" && command !== undefined) {
    yield* progress("fetch", "active");

    const ran = yield* run(repo, inShell(prepared.in_devenv, command), prepared.fetch.timeout_secs ?? FETCH_DEFAULT_SECS);

    yield* progress("fetch", ran.passed ? "complete" : "error");

    if (!ran.passed) {
      fetched = `the root's fetch failed:\n${ran.tail}`;
    }
  }

  yield* writePrepared(workdir, { ...prepared, fetched });
});

const runChecks = Effect.fn("Scorer.runChecks")(function* (repo: string, specs: ReadonlyArray<readonly [CheckOrigin, CheckSpec]>, inDevenv: boolean) {
  const outcomes: Array<CheckOutcome> = [];

  for (const [origin, check] of specs) {
    yield* progress("check", "active", check.name);

    const ran = yield* run(repo, inShell(inDevenv, check.run), checkTimeoutSecs(check));

    yield* progress("check", ran.passed ? "complete" : "error", check.name);
    outcomes.push({ name: check.name, origin, passed: ran.passed, millis: ran.millis, tail: ran.tail });
  }

  return outcomes;
});

/** `git diff <flags> base head`, outside the locked files. */
const diffArgs = (flags: ReadonlyArray<string>, base: string, head: string) => [
  "diff",
  ...flags,
  base,
  head,
  "--",
  ".",
  ...LOCKED_PATHS.map((path) => `:(exclude)${path}`),
];

/** One `git diff --numstat` line: `added<TAB>deleted<TAB>path`, `-` for both on a binary file, which counts as one line. */
export const numstatCost = (line: string) => {
  const [added, deleted] = line.split("\t");

  if (added === "-" && deleted === "-") {
    return 1;
  }

  return (Number.parseInt(added ?? "", 10) || 0) + (Number.parseInt(deleted ?? "", 10) || 0);
};

/** Lines added plus deleted between base and head, outside the locked files. */
const diffCost = Effect.fn("Scorer.diffCost")(function* (repo: string, base: string, head: string) {
  const numstat = yield* git(repo, "diff", diffArgs(["--numstat"], base, head));

  return numstat
    .split("\n")
    .filter((line) => line !== "")
    .reduce((sum, line) => sum + numstatCost(line), 0);
});

/** Phase three, with no network: the root's checks then the task's, the cost, and what the root's judges need. */
export const check = Effect.fn("Scorer.check")(function* (workdir: string) {
  const prepared = yield* readPrepared(workdir);
  const repo = join(workdir, "attempt");
  const { base, head } = prepared.attempt;
  const root: RootChecks = yield* rootChecks(repo, base);

  // The root's checks first, then the task's: what must not break, then what must be done.
  const specs = [
    ...(root.check ?? []).map((spec) => ["root", spec] as const),
    ...(prepared.attempt.checks ?? []).map((spec) => ["task", spec] as const),
  ];

  const failure = prepared.fetched ?? "";

  const checks =
    failure === ""
      ? yield* runChecks(repo, specs, prepared.in_devenv)
      : specs.map(([origin, spec]): CheckOutcome => ({ name: spec.name, origin, passed: false, millis: 0, tail: failure }));

  const cost = yield* stepped("cost", diffCost(repo, base, head));
  const touched = (yield* git(repo, "diff", diffArgs(["--name-only"], base, head))).split("\n").filter((line) => line !== "");
  const judges = root.judge ?? [];
  const diff = judges.length === 0 ? "" : clipDiff(yield* git(repo, "diff", diffArgs(["--no-color"], base, head)));

  yield* removeAll(workdir);

  return { report: { checks, cost, touched }, judges, diff } satisfies CheckRun;
});

/** All three phases back to back, for callers with no network policy to switch. */
export const score = Effect.fn("Scorer.score")(function* (root: string, attempt: AttemptRef) {
  const prepared = yield* prepare(root, attempt);

  yield* fetch(prepared.workdir);

  return yield* check(prepared.workdir);
});

/**
 * The hosts `checkout`'s committed `ficus.toml` opens for its fetch: what an
 * agent's workspace may reach, read when it opens (at the base commit).
 * Empty without a ficus.toml, or with one that does not parse: the scorer
 * says why when it scores.
 */
export const fetchHosts = Effect.fn("Scorer.fetchHosts")(function* (checkout: string) {
  if (!(yield* succeeds(checkout, ["cat-file", "-e", "HEAD:ficus.toml"]))) {
    return [];
  }

  const text = yield* git(checkout, "read ficus.toml", ["show", "HEAD:ficus.toml"]);
  const root = parseRoot(text);

  return Result.isSuccess(root) ? (root.success.fetch?.hosts ?? []) : [];
});

/**
 * Replay the commits of `from` after `from_base` onto `onto_head`, and push
 * the result to `onto`'s branch. Both remotes are reached through the
 * sandbox's egress, which holds the tokens. Nothing is run from the repo.
 */
export const rebase = Effect.fn("Scorer.rebase")(function* (root: string, job: RebaseRef) {
  const workdir = join(root, `rebase-${job.from_head}`);
  const repo = join(workdir, "onto");

  yield* removeAll(workdir);
  yield* Effect.tryPromise({ try: () => mkdir(workdir, { recursive: true }), catch: io("making the workdir") });
  yield* git(workdir, "clone", ["clone", "--quiet", "--no-checkout", job.onto, repo]);
  yield* git(repo, "fetch the behind attempt", ["fetch", "--quiet", job.from, job.from_head]);

  if (!(yield* succeeds(repo, ["merge-base", "--is-ancestor", job.from_base, job.from_head]))) {
    return yield* new ScoreError({ kind: "NotDescendant", message: "head does not descend from base" });
  }

  yield* git(repo, "checkout", ["checkout", "--quiet", "--detach", job.from_head]);

  const replayed = Number.parseInt((yield* git(repo, "count commits", ["rev-list", "--count", `${job.from_base}..${job.from_head}`])).trim(), 10) || 0;

  // A rebase has no author of its own; the commits keep theirs.
  const rebased = yield* git(repo, "rebase", [
    "-c",
    "user.name=ficus",
    "-c",
    "user.email=ficus@rebase",
    "-c",
    "commit.gpgsign=false",
    "rebase",
    "--quiet",
    "--onto",
    job.onto_head,
    job.from_base,
  ]).pipe(Effect.result);

  if (Result.isFailure(rebased)) {
    const conflicts = yield* git(repo, "list conflicts", ["diff", "--name-only", "--diff-filter=U"]).pipe(Effect.orElseSucceed(() => ""));

    yield* succeeds(repo, ["rebase", "--abort"]);

    const paths = conflicts.split("\n").filter((line) => line !== "");

    return yield* new ScoreError({
      kind: "Conflict",
      message: `the attempt's commits do not apply on the head: conflicts in ${(paths.length === 0 ? [rebased.failure.message] : paths).join(", ")}`,
    });
  }

  const commit = yield* Schema.decodeUnknownEffect(Oid)((yield* git(repo, "rev-parse", ["rev-parse", "HEAD"])).trim()).pipe(Effect.mapError(io("reading the rebased head")));

  yield* git(repo, "push", ["push", "--quiet", "origin", `HEAD:refs/heads/${job.onto_branch}`]);
  yield* removeAll(workdir);

  return { commit, replayed } satisfies RebaseReport;
});

const DEPLOY_FILE = "deploy.json";

/** What `deployPrepare` leaves in the workdir for `deploy`. */
const PreparedDeploy = Schema.Struct({
  in_devenv: Schema.Boolean,
  /** The released commit's own `[deploy]`; absent when it has none. */
  deploy: Schema.optionalKey(DeploySpec),
});

/**
 * Phase one of a deploy, with the network open to the node's repo: clone the
 * released commit into a fresh workdir under `root` and read its own
 * `ficus.toml`. Answers the workdir, whether it deploys at all, and the hosts
 * its `[deploy]` opens for phase two.
 */
export const deployPrepare = Effect.fn("Scorer.deployPrepare")(function* (root: string, ref: DeployRef) {
  const workdir = join(root, `deploy-${ref.commit}`);
  const repo = join(workdir, "node");

  yield* removeAll(workdir);
  yield* Effect.tryPromise({ try: () => mkdir(workdir, { recursive: true }), catch: io("making the workdir") });
  yield* git(workdir, "clone", ["clone", "--quiet", "--no-checkout", ref.remote, repo]);
  yield* git(repo, "checkout", ["checkout", "--quiet", "--detach", ref.commit]);

  const hasToml = yield* succeeds(repo, ["cat-file", "-e", "HEAD:ficus.toml"]);
  const deploy = hasToml ? (yield* Effect.fromResult(parseRoot(yield* git(repo, "read ficus.toml", ["show", "HEAD:ficus.toml"])))).deploy : undefined;
  const inDevenv = yield* succeeds(repo, ["cat-file", "-e", "HEAD:devenv.nix"]);
  const prepared: typeof PreparedDeploy.Type = deploy === undefined ? { in_devenv: inDevenv } : { in_devenv: inDevenv, deploy };

  yield* Effect.tryPromise({ try: () => writeFile(join(workdir, DEPLOY_FILE), JSON.stringify(prepared)), catch: io("writing the prepared deploy") });

  return DeployPrepared.make({ workdir, deploys: deploy !== undefined, hosts: deploy?.hosts ?? [] });
});

/**
 * Phase two, with the network open to the `[deploy]` hosts, the nix caches
 * and the Cloudflare API (credentials added by the sandbox): build the root's
 * devenv shell and run its deploy in it.
 */
export const deploy = Effect.fn("Scorer.deploy")(function* (workdir: string) {
  const text = yield* Effect.tryPromise({ try: () => readFile(join(workdir, DEPLOY_FILE), "utf8"), catch: io("reading the prepared deploy") });
  const prepared = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(PreparedDeploy))(text).pipe(Effect.mapError(io("decoding the prepared deploy")));
  const repo = join(workdir, "node");

  if (prepared.deploy === undefined) {
    return { deployed: false, passed: true, millis: 0, tail: "the released commit's ficus.toml has no [deploy]" } satisfies DeployReport;
  }

  if (prepared.in_devenv) {
    const built = yield* run(repo, ["devenv", "--quiet", "shell", "--", "true"], DEVENV_PREPARE_SECS);

    if (!built.passed) {
      return { deployed: true, passed: false, millis: built.millis, tail: `the root's devenv shell did not build:\n${built.tail}` } satisfies DeployReport;
    }
  }

  const ran = yield* run(repo, inShell(prepared.in_devenv, prepared.deploy.run), deployTimeoutSecs(prepared.deploy));

  yield* removeAll(workdir);

  return { deployed: true, passed: ran.passed, millis: ran.millis, tail: ran.tail } satisfies DeployReport;
});
