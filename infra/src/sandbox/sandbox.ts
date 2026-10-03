/**
 * `Scorer`: one Durable Object per attempt being scored or rebased, driving
 * its container with the runtime's native API. The container always runs
 * with the internet off; what it may reach is decided here, per phase, by
 * routing hosts through Egress.
 *
 *   POST /score  (a ScoreRequest, from the tree)
 *     0. boot:    from the base's warmed snapshot when the tree has one;
 *                 with `take_snapshot`, warm one first: prepare the base
 *                 alone (its devenv shell, no attempt's code), clear the
 *                 workdir, snapshot
 *     1. prepare: the attempt's repo (token added by Egress) and the
 *                 nix/devenv caches; `ficus-scorer prepare` clones, restores
 *                 the root's locked files and builds the root's devenv shell
 *     2. check:   nothing; `ficus-scorer check` runs the root's checks, then
 *                 the task's
 *   then the container is destroyed, and the root's judges (`[[judge]]` in
 *   its ficus.toml) are put to Clef with the task's intent and the attempt's
 *   diff. The answer is the ScoreReport, judges included as checks, or 422
 *   when the attempt or root cannot be scored (retrying will not help). A
 *   snapshot taken is reported in `x-ficus-snapshot`; a snapshot that would
 *   not restore, in `x-ficus-snapshot-stale`.
 *
 *   POST /rebase  (a RebaseRequest, from the tree)
 *     the behind attempt's repo (read) and the fresh attempt's repo (write),
 *     both with their tokens added by Egress; `ficus-scorer rebase` replays
 *     the behind commits onto the head and pushes. Nothing from either repo
 *     is run. The answer is the RebaseReport, or 422 on a conflict.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as DecisionModel from "effect/ai/DecisionModel";
import type { HttpBodyError } from "effect/http/HttpBody";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Clef } from "../clef/clef.ts";
import { ScorerContainer } from "./containers.ts";
import { type CheckOutcome, CheckRun, judged, judging } from "./judges.ts";
import {
  boot,
  type Booted,
  destroy,
  exec,
  failure,
  machineOf,
  type Machine,
  NIX_HOSTS,
  type Ran,
  route,
  SCORER,
  snapshot,
  trustEgress,
} from "./machine.ts";
import { repoOf } from "./repo.ts";

/** crates/ficus-core `SNAPSHOT_TAKEN_HEADER` and `SNAPSHOT_STALE_HEADER`. */
export const SNAPSHOT_TAKEN_HEADER = "x-ficus-snapshot";

export const SNAPSHOT_STALE_HEADER = "x-ficus-snapshot-stale";

/** Where `ficus-scorer prepare` puts workdirs. */
const WORK_ROOT = "/work/score";

const Oid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/));

/** crates/ficus-core `CheckSpec`: a task's check, run after the root's. */
const CheckSpec = Schema.Struct({
  name: Schema.String,
  run: Schema.String,
  timeout_secs: Schema.optional(Schema.Number),
});

/** crates/ficus-core `ScoreRequest`. */
export const ScoreRequest = Schema.Struct({
  remote: Schema.String,
  token: Schema.String,
  base: Oid,
  head: Oid,
  // Optional: a tree Worker from before judges, task checks or snapshots sends none.
  intent: Schema.optional(Schema.String),
  checks: Schema.optional(Schema.Array(CheckSpec)),
  snapshot: Schema.optional(Schema.String),
  take_snapshot: Schema.optional(Schema.Boolean),
});

export interface ScoreRequest extends Schema.Schema.Type<typeof ScoreRequest> {}

/** crates/ficus-core `RebaseRequest`. */
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

export interface RebaseRequest extends Schema.Schema.Type<typeof RebaseRequest> {}

const Prepared = Schema.Struct({ workdir: Schema.String });

/** crates/ficus-core `RebaseReport`. */
const RebaseReport = Schema.Struct({ commit: Oid, replayed: Schema.Number });

/** A `ficus-scorer` result: 2 is the attempt's or root's fault (or a conflict), other failures the sandbox's. */
const scorerJson = Effect.fn("Sandbox.scorerJson")(function* <A>(ran: Ran, schema: Schema.Decoder<A>, phase: string) {
  if (ran.exitCode === 2) {
    return yield* failure(422, ran.stderr.trim());
  }

  if (ran.exitCode !== 0) {
    return yield* failure(500, `${phase} exited ${ran.exitCode}: ${ran.stderr.trim()}`);
  }

  const parsed = yield* Effect.try({
    try: () => JSON.parse(ran.stdout),
    catch: () => failure(500, `${phase} printed no JSON: ${ran.stdout.slice(0, 200)}`),
  });

  return yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(
    Effect.mapError((error) => failure(500, `${phase} printed an unexpected shape: ${String(error)}`)),
  );
});

/** Open the attempt's repo and the nix caches; the check phase closes them again. */
const openPrepare = Effect.fn("Sandbox.openPrepare")(function* (machine: Machine, score: ScoreRequest) {
  const repo = repoOf(score.remote);

  yield* route(machine, repo.host, { mode: "artifacts", repos: [{ repoPath: repo.repoPath, token: score.token }] });

  for (const host of NIX_HOSTS) {
    yield* route(machine, host, { mode: "pass" });
  }

  yield* trustEgress(machine);
});

const closeAll = Effect.fn("Sandbox.closeAll")(function* (machine: Machine, score: ScoreRequest) {
  yield* route(machine, repoOf(score.remote).host, { mode: "deny" });

  for (const host of NIX_HOSTS) {
    yield* route(machine, host, { mode: "deny" });
  }
});

/**
 * Warm a snapshot of the base: prepare it as if it were an attempt (its
 * devenv shell builds into the nix store), clear the workdir, snapshot. Only
 * the base's files are ever in it, never an attempt's.
 */
const warm = Effect.fn("Sandbox.warm")(function* (machine: Machine, score: ScoreRequest) {
  const base = JSON.stringify({ remote: score.remote, base: score.base, head: score.base, checks: [] });

  yield* scorerJson(yield* exec(machine, [SCORER, "prepare", base]), Prepared, "warm");

  const cleared = yield* exec(machine, ["rm", "-rf", WORK_ROOT]);

  if (cleared.exitCode !== 0) {
    return yield* failure(500, `clearing the warm workdir: ${cleared.stderr.trim()}`);
  }

  return yield* snapshot(machine, `base-${score.base.slice(0, 12)}`);
});

/** The report with the root's judges' outcomes added. A Clef failure is retryable: 503. */
const judge = Effect.fn("Sandbox.judge")(function* (run: Schema.Schema.Type<typeof CheckRun>, task: string) {
  if (run.judges.length === 0) {
    return run.report;
  }

  const started = Date.now();

  const { answers } = yield* DecisionModel.decide(judging(run.judges), { input: { task, diff: run.diff } }).pipe(
    Effect.mapError((error) => failure(503, `judging the attempt: ${error.message}`)),
  );

  const millis = Date.now() - started;
  const outcomes: Array<CheckOutcome> = [];

  // DecisionModel has checked every judge got its answer.
  for (const each of run.judges) {
    outcomes.push(judged(each, answers[each.name]?.probability ?? 0, millis));
  }

  return { checks: [...run.report.checks, ...outcomes], cost: run.report.cost };
});

const score = Effect.fn("Sandbox.score")(function* (machine: Machine, request: ScoreRequest) {
  const booted: Booted = yield* boot(machine, request.snapshot);

  yield* openPrepare(machine, request);

  const taken = request.take_snapshot === true && !booted.restored ? yield* warm(machine, request) : undefined;

  const attempt = JSON.stringify({
    remote: request.remote,
    base: request.base,
    head: request.head,
    checks: request.checks ?? [],
  });

  const prepared = yield* scorerJson(yield* exec(machine, [SCORER, "prepare", attempt]), Prepared, "prepare");

  // Close everything before any of the root's checks run.
  yield* closeAll(machine, request);

  const checked = yield* exec(machine, [SCORER, "check", prepared.workdir]);
  const run = yield* scorerJson(checked, CheckRun, "check");

  yield* destroy(machine);

  const report = yield* judge(run, request.intent ?? "");
  const headers: Record<string, string> = {};

  if (taken !== undefined) {
    headers[SNAPSHOT_TAKEN_HEADER] = taken;
  }

  if (booted.stale) {
    headers[SNAPSHOT_STALE_HEADER] = "1";
  }

  return yield* HttpServerResponse.json(report, { headers });
});

/** Replay a behind attempt's commits onto the head, in the fresh attempt, and push. */
const rebase = Effect.fn("Sandbox.rebase")(function* (machine: Machine, job: RebaseRequest) {
  const from = repoOf(job.from);
  const onto = repoOf(job.onto);

  const ref = JSON.stringify({
    from: job.from,
    from_base: job.from_base,
    from_head: job.from_head,
    onto: job.onto,
    onto_head: job.onto_head,
    onto_branch: job.onto_branch,
  });

  yield* boot(machine, undefined);

  // Both repos live in the same Artifacts namespace, so on one host.
  const grants = [
    { repoPath: from.repoPath, token: job.from_token },
    { repoPath: onto.repoPath, token: job.onto_token },
  ];

  yield* route(machine, from.host, { mode: "artifacts", repos: grants });

  if (onto.host !== from.host) {
    yield* route(machine, onto.host, { mode: "artifacts", repos: grants });
  }

  yield* trustEgress(machine);

  const report = yield* scorerJson(yield* exec(machine, [SCORER, "rebase", ref]), RebaseReport, "rebase");

  yield* destroy(machine);

  return yield* HttpServerResponse.json(report);
});

/** The request's body, decoded as `schema`; anything else is the caller's 400. */
export const bodyAs = <A>(request: HttpServerRequest.HttpServerRequest, schema: Schema.Decoder<A>, what: string) =>
  request.json.pipe(
    Effect.mapError(() => failure(400, "the body is not JSON")),
    Effect.flatMap((json) =>
      Schema.decodeUnknownEffect(schema)(json).pipe(
        Effect.mapError((error) => failure(400, `not ${what}: ${String(error)}`)),
      ),
    ),
  );

export const failureResponse = (error: { readonly status: number; readonly message: string }) =>
  Effect.succeed(HttpServerResponse.text(error.message, { status: error.status }));

/** A Durable Object's `fetch` answers every failure: the bridge takes only HTTP errors. */
export const answered = <R>(
  handled: Effect.Effect<HttpServerResponse.HttpServerResponse, { readonly _tag: "Sandbox.Failure"; readonly status: number; readonly message: string } | HttpBodyError, R>,
) =>
  handled.pipe(
    Effect.catchTag("Sandbox.Failure", failureResponse),
    Effect.catchTag("HttpBodyError", (error) =>
      failureResponse({ status: 500, message: `writing the answer: ${error.reason._tag}` }),
    ),
  );

export class Scorer extends Cloudflare.DurableObject<Scorer>()(
  "Scorer",
  Effect.gen(function* () {
    // Attached, not started: each request starts it (machine.ts `boot`).
    yield* Cloudflare.Containers.bind(ScorerContainer);

    const ai = yield* Cloudflare.Workers.AI();
    const state = yield* Cloudflare.DurableObjectState;

    // oxlint-disable-next-line effecttsgo/return-effect-in-gen -- alchemy's Durable Object shape: the outer Effect binds, the returned one builds each instance
    return Effect.gen(function* () {
      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { pathname } = new URL(request.url, "http://sandbox");

          if (request.method === "POST" && pathname === "/rebase") {
            return yield* answered(
              Effect.gen(function* () {
                const machine = yield* machineOf(state.raw);

                return yield* rebase(machine, yield* bodyAs(request, RebaseRequest, "a rebase request"));
              }),
            );
          }

          if (request.method !== "POST" || pathname !== "/score") {
            return HttpServerResponse.text("not found", { status: 404 });
          }

          const binding = yield* ai.raw;

          const scored = Effect.gen(function* () {
            const machine = yield* machineOf(state.raw);

            return yield* score(machine, yield* bodyAs(request, ScoreRequest, "a score request"));
          });

          // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a request is an entry point
          return yield* answered(scored.pipe(Effect.provide(Clef.layerBinding(binding))));
        }),
      };
    });
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- alchemy's binding layer, provided where the Durable Object is declared
  }).pipe(Effect.provide(Cloudflare.Workers.AIBinding)),
) {}
