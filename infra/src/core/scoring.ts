/**
 * How an attempt is scored: the root's `ficus.toml`, the request the tree
 * sends the sandbox, and the report that comes back.
 *
 * The checks always come from the attempt's **base** commit, never from the
 * attempt: an agent that edits `ficus.toml` or the devenv files has edited
 * files the scorer puts back before it runs anything (`LOCKED_PATHS`).
 *
 * A root has two kinds of check. A `[[check]]` is a command the scorer runs in
 * the container. A `[[judge]]` is a yes/no question about the diff, asked of
 * Clef by the sandbox once the container is gone. Both count the same
 * towards a score. Its `[fetch]` names the hosts its checks need before the
 * network closes.
 */
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Oid, type Score, TreeError } from "./values.ts";

/** Files the root owns: restored from the base before anything runs, and out of the cost. */
export const LOCKED_PATHS = ["ficus.toml", "devenv.nix", "devenv.yaml", "devenv.lock", ".envrc"] as const;

/** A check that runs longer than this fails, unless `ficus.toml` says otherwise. */
export const DEFAULT_CHECK_TIMEOUT_SECS = 600;

/** A judge passes when Clef answers yes with at least this probability, unless `ficus.toml` says otherwise. */
export const DEFAULT_PASS_AT = 0.5;

/** Characters of diff a judge sees; a longer diff is cut at a line end and marked. */
export const JUDGE_DIFF_CHARS = 120_000;

/** The most hosts a root may open for its fetch. */
export const MAX_FETCH_HOSTS = 20;

const Seconds = Schema.Int.check(Schema.isGreaterThan(0));

export const CheckSpec = Schema.Struct({
  name: Schema.String,
  /** A bash command, run from the repo root (inside `devenv shell` when the root has a `devenv.nix`). */
  run: Schema.String,
  timeout_secs: Schema.optionalKey(Seconds),
});

export type CheckSpec = typeof CheckSpec.Type;

export const checkTimeoutSecs = (check: CheckSpec) => check.timeout_secs ?? DEFAULT_CHECK_TIMEOUT_SECS;

/** Whose check it is: the root's `ficus.toml`, or the task's own. */
export const CheckOrigin = Schema.Literals(["root", "task"]);

export type CheckOrigin = typeof CheckOrigin.Type;

export const JudgeSpec = Schema.Struct({
  /** Also Clef's question id: letters, digits, `_`, `.`, `-`, at most 100. */
  name: Schema.String,
  /** The question, phrased so that yes passes. */
  ask: Schema.String,
  /** What a yes means. Given together with `no`, or not at all. */
  yes: Schema.optionalKey(Schema.String),
  no: Schema.optionalKey(Schema.String),
  /** The least probability of yes that passes; in (0, 1]. */
  pass_at: Schema.optionalKey(Schema.Number),
});

export type JudgeSpec = typeof JudgeSpec.Type;

export const passAt = (judge: JudgeSpec) => judge.pass_at ?? DEFAULT_PASS_AT;

/**
 * The root's `[fetch]`: what its checks need from the network before it
 * closes. While the root's devenv builds and `run` runs, the sandbox lets the
 * attempt reach `hosts` (on top of its own repo and the nix caches); the
 * checks then run with nothing. Like the checks it comes from the base.
 */
export const FetchSpec = Schema.Struct({
  /** Hostnames, exactly: `static.crates.io`, not `*.crates.io`. */
  hosts: Schema.optionalKey(Schema.Array(Schema.String)),
  /** A bash command, run from the repo root inside the root's devenv shell when it has one. */
  run: Schema.optionalKey(Schema.String),
  timeout_secs: Schema.optionalKey(Seconds),
});

export type FetchSpec = typeof FetchSpec.Type;

/** The root's `ficus.toml`, as TOML parses it. */
export const RootChecks = Schema.Struct({
  check: Schema.optionalKey(Schema.Array(CheckSpec)),
  judge: Schema.optionalKey(Schema.Array(JudgeSpec)),
  fetch: Schema.optionalKey(FetchSpec),
});

export type RootChecks = typeof RootChecks.Type;

export const ChecksErrorKind = Schema.Literals([
  "Unparsable",
  "NoChecks",
  "DuplicateName",
  "EmptyRun",
  "EmptyAsk",
  "JudgeName",
  "HalfCriteria",
  "PassAt",
  "FetchHost",
  "TooManyHosts",
  "EmptyFetch",
]);

export class ChecksError extends Schema.TaggedError<ChecksError>()("Checks.Error", {
  kind: ChecksErrorKind,
  message: Schema.String,
}) {}

const refuse = (kind: typeof ChecksErrorKind.Type, message: string) => Result.fail(new ChecksError({ kind, message }));

/** Checks must be nameable and runnable: unique names, non-empty commands. */
export const validateChecks = (checks: ReadonlyArray<CheckSpec>) =>
  Result.gen(function* () {
    const seen = new Set<string>();

    for (const check of checks) {
      if (seen.has(check.name)) {
        return yield* refuse("DuplicateName", `check ${JSON.stringify(check.name)} appears twice`);
      }

      seen.add(check.name);

      if (check.run.trim() === "") {
        return yield* refuse("EmptyRun", `check ${JSON.stringify(check.name)} has an empty \`run\``);
      }
    }
  });

/** A hostname a root may open: lowercase dot-separated labels, at least two. No wildcards, ports or schemes. */
export const isHostname = (host: string) => host.length <= 253 && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(host);

const JUDGE_NAME = /^[A-Za-z0-9_.-]{1,100}$/;

const checkJudges = (checks: ReadonlyArray<CheckSpec>, judges: ReadonlyArray<JudgeSpec>) =>
  Result.gen(function* () {
    const names = new Set(checks.map((check) => check.name));

    for (const judge of judges) {
      const named = JSON.stringify(judge.name);

      if (names.has(judge.name)) {
        return yield* refuse("DuplicateName", `check ${named} appears twice in ficus.toml`);
      }

      names.add(judge.name);

      if (!JUDGE_NAME.test(judge.name)) {
        return yield* refuse("JudgeName", `judge ${named}: a name is letters, digits, \`_\`, \`.\` and \`-\`, at most 100 of them`);
      }

      if (judge.ask.trim() === "") {
        return yield* refuse("EmptyAsk", `judge ${named} has an empty \`ask\``);
      }

      if ((judge.yes === undefined) !== (judge.no === undefined)) {
        return yield* refuse("HalfCriteria", `judge ${named}: \`yes\` and \`no\` come together or not at all`);
      }

      const pass = passAt(judge);

      if (!(pass > 0 && pass <= 1)) {
        return yield* refuse("PassAt", `judge ${named}: \`pass_at\` must be above 0 and at most 1`);
      }
    }
  });

const checkFetch = (fetch: FetchSpec | undefined) =>
  Result.gen(function* () {
    const hosts = fetch?.hosts ?? [];

    if (hosts.length > MAX_FETCH_HOSTS) {
      return yield* refuse("TooManyHosts", `[fetch] opens more than ${MAX_FETCH_HOSTS} hosts`);
    }

    const badHost = hosts.find((host) => !isHostname(host));

    if (badHost !== undefined) {
      return yield* refuse("FetchHost", `[fetch] host ${JSON.stringify(badHost)} is not a hostname (lowercase, no wildcards, ports or schemes)`);
    }

    if (fetch?.run?.trim() === "") {
      return yield* refuse("EmptyFetch", "[fetch] has an empty `run`");
    }
  });

/**
 * The root's config, as `RootChecks` decoded it (strictly: an unknown key
 * is a typo), checked: it must run something, and say so clearly.
 */
export const checkRoot = (root: RootChecks) =>
  Result.gen(function* () {
    const checks = root.check ?? [];
    const judges = root.judge ?? [];

    if (checks.length === 0 && judges.length === 0) {
      return yield* refuse("NoChecks", "ficus.toml defines no checks or judges, so nothing could ever pass");
    }

    yield* validateChecks(checks);
    yield* checkJudges(checks, judges);
    yield* checkFetch(root.fetch);

    return root;
  });

/** Decode a root's parsed `ficus.toml`, strictly, as `checkRoot` expects. */
export const decodeRoot = Schema.decodeUnknownResult(RootChecks);

/** How `decodeRoot` refuses, as a `ChecksError`. */
export const unparsable = (issue: { readonly message: string }) => new ChecksError({ kind: "Unparsable", message: `ficus.toml does not parse: ${issue.message}` });

/** The first `JUDGE_DIFF_CHARS` characters of `diff`, cut at a line end, marked when cut. */
export const clipDiff = (diff: string) => {
  const characters = Array.from(diff);

  if (characters.length <= JUDGE_DIFF_CHARS) {
    return diff;
  }

  const head = characters.slice(0, JUDGE_DIFF_CHARS).join("");
  const cut = head.lastIndexOf("\n");

  return `${cut === -1 ? head : head.slice(0, cut)}\n[diff truncated: ${characters.length} characters in all]`;
};

/**
 * What the tree asks the sandbox: score `head` against `base`, reading the
 * attempt at `remote` with `token`, with the task's `checks` after the root's.
 */
export const ScoreRequest = Schema.Struct({
  remote: Schema.String,
  token: Schema.String,
  base: Oid,
  head: Oid,
  /** The task's intent: the `task` the root's judges see. */
  intent: Schema.String,
  checks: Schema.optionalKey(Schema.Array(CheckSpec)),
});

export type ScoreRequest = typeof ScoreRequest.Type;

/** What the container is told: no credentials, which the sandbox's egress adds. */
export const AttemptRef = Schema.Struct({
  remote: Schema.String,
  base: Oid,
  head: Oid,
  checks: Schema.optionalKey(Schema.Array(CheckSpec)),
});

export type AttemptRef = typeof AttemptRef.Type;

/**
 * When the head moved past a submitted attempt: replay `from`'s commits after
 * `from_base` onto `onto_head`, in the fresh attempt at `onto`, and push them
 * to its `onto_branch`.
 */
export const RebaseRequest = Schema.Struct({
  from: Schema.String,
  from_token: Schema.String,
  from_base: Oid,
  from_head: Oid,
  onto: Schema.String,
  onto_token: Schema.String,
  onto_head: Oid,
  onto_branch: Schema.String,
});

export type RebaseRequest = typeof RebaseRequest.Type;

export const RebaseRef = Schema.Struct({
  from: Schema.String,
  from_base: Oid,
  from_head: Oid,
  onto: Schema.String,
  onto_head: Oid,
  onto_branch: Schema.String,
});

export type RebaseRef = typeof RebaseRef.Type;

/** Where the replayed commits landed. */
export const RebaseReport = Schema.Struct({ commit: Oid, replayed: Schema.Int });

export type RebaseReport = typeof RebaseReport.Type;

export const CheckOutcome = Schema.Struct({
  name: Schema.String,
  origin: Schema.optionalKey(CheckOrigin),
  passed: Schema.Boolean,
  millis: Schema.Number,
  /** The end of the check's output, for the agent that retries; for a judge, Clef's answer. */
  tail: Schema.String,
  /** A judge's probability of yes, in thousandths; absent for a command. */
  confidence: Schema.optional(Schema.Int),
});

export type CheckOutcome = typeof CheckOutcome.Type;

export const ScoreReport = Schema.Struct({
  checks: Schema.Array(CheckOutcome),
  /** Lines added plus deleted between base and head, outside `LOCKED_PATHS`; a binary file counts as one. */
  cost: Schema.Int,
  /** Paths changed between base and head, outside `LOCKED_PATHS`. */
  touched: Schema.optionalKey(Schema.Array(Schema.String)),
});

export type ScoreReport = typeof ScoreReport.Type;

/** The report as a score: every check counts, judges' confidence averaged. */
export const scoreOf = (report: ScoreReport): Result.Result<Score, TreeError> => {
  const passed = report.checks.filter((check) => check.passed).length;
  const total = report.checks.length;

  if (total === 0) {
    return Result.fail(new TreeError({ kind: "ImpossibleScore", message: "0 of 0 checks passed is not a score" }));
  }

  const confidences = report.checks.flatMap((check) => (check.confidence === undefined ? [] : [check.confidence]));
  const confidence = confidences.length === 0 ? null : Math.min(1000, Math.floor(confidences.reduce((sum, value) => sum + value, 0) / confidences.length));

  return Result.succeed({ checks_passed: passed, checks_total: total, cost: report.cost, confidence });
};

/** What `ficus-scorer check` prints: the commands' report, and what the sandbox needs to ask the root's judges. */
export const CheckRun = Schema.Struct({
  report: ScoreReport,
  judges: Schema.Array(JudgeSpec),
  /** The attempt's diff from its base outside `LOCKED_PATHS`, clipped; empty without judges. */
  diff: Schema.String,
});

export type CheckRun = typeof CheckRun.Type;
