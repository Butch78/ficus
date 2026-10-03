/**
 * `Scorer`: one Durable Object per attempt being scored or rebased, driving
 * its container with the runtime's native API (machine.ts). The container
 * always runs with the internet off; what it may reach is decided here, per
 * phase, by routing hosts through Egress.
 *
 *   POST /score  (a ScoreRequest, from the tree)
 *     0. boot:    from the base's warmed snapshot when the tree has one;
 *                 with `take_snapshot`, warm one first: prepare and fetch
 *                 the base alone (its devenv shell, its `[fetch]`, no
 *                 attempt's code), clear the workdir, snapshot
 *     1. prepare: the attempt's repo (token added by Egress) and the
 *                 nix/devenv caches; `ficus-scorer prepare` clones and
 *                 restores the root's locked files, then `ficus-scorer fetch`
 *                 builds the root's devenv shell and runs its `[fetch]`, with
 *                 the hosts that names opened too
 *     2. check:   nothing; `ficus-scorer check` runs the root's checks, then
 *                 the task's
 *   then the container is destroyed, and the root's judges (`[[judge]]` in
 *   its ficus.toml) are put to Clef with the task's intent and the attempt's
 *   diff. The answer is the ScoreReport, judges included as checks, or 422
 *   when the attempt or root cannot be scored (retrying will not help). A
 *   snapshot taken, or one that would not restore, is reported in the
 *   snapshot headers (src/core/scoring.ts `SnapshotNews`).
 *
 *   `/score` with `Accept: application/x-ndjson` answers with a stream
 *   instead (src/core/progress.ts): each step as it happens, the sandbox's
 *   own and `ficus-scorer`'s, then the outcome, the snapshot news in it.
 *
 *   POST /rebase  (a RebaseRequest, from the tree)
 *     the behind attempt's repo (read) and the fresh attempt's repo (write),
 *     both with their tokens added by Egress; `ficus-scorer rebase` replays
 *     the behind commits onto the head and pushes. Nothing from either repo
 *     is run. The answer is the RebaseReport, or 422 on a conflict.
 */
import type * as cf from "@cloudflare/workers-types";
import * as Cloudflare from "alchemy/Cloudflare";
import * as DecisionModel from "effect/ai/DecisionModel";
import type { HttpBodyError } from "effect/http/HttpBody";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { Clef } from "../clef/clef.ts";
import { CONTENT_TYPE as PROGRESS, outcomeLine } from "../core/progress.ts";
import {
  RebaseReport,
  RebaseRequest,
  ScoreRequest,
  type ScoreReport,
  type SnapshotNews,
  SNAPSHOT_STALE_HEADER,
  SNAPSHOT_TAKEN_HEADER,
} from "../core/scoring.ts";
import { ScorerContainer } from "./containers.ts";
import { type CheckOutcome, CheckRun, judged, judging } from "./judges.ts";
import {
  boot,
  destroy,
  exec,
  failure,
  machineOf,
  type Machine,
  NIX_HOSTS,
  quiet,
  type Ran,
  type Report,
  route,
  type SandboxFailure,
  SCORER,
  snapshot,
  trustEgress,
} from "./machine.ts";
import { repoOf } from "./repo.ts";

/** Where `ficus-scorer prepare` puts workdirs. */
const WORK_ROOT = "/work/score";

/** `ficus-scorer prepare`: the workdir, and the hosts the root's `[fetch]` opens next. */
const Prepared = Schema.Struct({ workdir: Schema.String, hosts: Schema.Array(Schema.String) });

const stepLine = (step: string, state: "active" | "complete" | "error", detail?: string) =>
  JSON.stringify(detail === undefined ? { kind: "step", step, state } : { kind: "step", step, state, detail });

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

/** Every host the prepare phase opened, closed again before any of the root's checks run. */
const closeAll = Effect.fn("Sandbox.closeAll")(function* (machine: Machine, hosts: ReadonlyArray<string>) {
  for (const host of new Set(hosts)) {
    yield* route(machine, host, { mode: "deny" });
  }
});

/**
 * Clone and restore `attempt`, then build its root's devenv shell and run its
 * `[fetch]`, with the hosts the root names opened for it. Answers the
 * workdir, those hosts, and how the fetch went.
 */
const prepareAndFetch = Effect.fn("Sandbox.prepareAndFetch")(function* (machine: Machine, attempt: string, report: Report) {
  const prepared = yield* scorerJson(yield* exec(machine, [SCORER, "prepare", attempt], { report }), Prepared, "prepare");

  // The root's own fetch hosts (packages), read from the base commit by
  // `prepare`: open while its devenv builds and its fetch runs.
  for (const host of prepared.hosts) {
    yield* route(machine, host, { mode: "pass" });
  }

  const fetched = yield* exec(machine, [SCORER, "fetch", prepared.workdir], { report });

  return { ...prepared, fetched };
});

/**
 * Warm a snapshot of the base: prepare and fetch it as if it were an attempt
 * (its devenv shell builds into the nix store, its `[fetch]` fills the
 * package caches), clear the workdir, snapshot. Only the base's files are
 * ever in it, never an attempt's.
 */
const warm = Effect.fn("Sandbox.warm")(function* (machine: Machine, score: ScoreRequest) {
  const base = JSON.stringify({ remote: score.remote, base: score.base, head: score.base, checks: [] });
  const { fetched } = yield* prepareAndFetch(machine, base, quiet);

  if (fetched.exitCode !== 0) {
    return yield* failure(500, `warming the base: fetch exited ${fetched.exitCode}: ${fetched.stderr.trim()}`);
  }

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

  return { ...run.report, checks: [...run.report.checks, ...outcomes] };
});

/** What scoring answers: the report, and what it did to the base's snapshot. */
interface Scored {
  readonly report: ScoreReport;
  readonly news: SnapshotNews;
}

const score = Effect.fn("Sandbox.score")(function* (machine: Machine, request: ScoreRequest, say: Report) {
  const repo = repoOf(request.remote);
  const failed = (detail: string) => Effect.sync(() => say(stepLine("sandbox", "error", detail)));

  say(stepLine("sandbox", "active"));

  const booted = yield* boot(machine, request.snapshot).pipe(Effect.tapError((error) => failed(error.message)));

  yield* route(machine, repo.host, { mode: "artifacts", repos: [{ repoPath: repo.repoPath, token: request.token }] });

  for (const host of NIX_HOSTS) {
    yield* route(machine, host, { mode: "pass" });
  }

  yield* trustEgress(machine).pipe(Effect.tapError(() => failed("could not trust the egress CA")));

  const warming = request.take_snapshot === true && !booted.restored;

  if (warming) {
    say(stepLine("sandbox", "active", "warming a snapshot of the base"));
  }

  // A snapshot that could not be warmed only costs later scorings their warm start.
  const taken = warming ? yield* warm(machine, request).pipe(Effect.catchTag("Sandbox.Failure", () => Effect.succeed(undefined))) : undefined;

  say(stepLine("sandbox", "complete"));

  const attempt = JSON.stringify({ remote: request.remote, base: request.base, head: request.head, checks: request.checks ?? [] });
  const { workdir, hosts, fetched } = yield* prepareAndFetch(machine, attempt, say);

  // Close everything before any of the root's checks run.
  yield* closeAll(machine, [repo.host, ...NIX_HOSTS, ...hosts]);

  if (fetched.exitCode !== 0) {
    return yield* failure(500, `fetch exited ${fetched.exitCode}: ${fetched.stderr.trim()}`);
  }

  const run = yield* scorerJson(yield* exec(machine, [SCORER, "check", workdir], { report: say }), CheckRun, "check");

  yield* destroy(machine);

  const news: SnapshotNews = taken === undefined ? (booted.stale ? { stale: true } : {}) : { taken };

  if (run.judges.length === 0) {
    return { report: run.report, news } satisfies Scored;
  }

  say(stepLine("judge", "active"));

  const report = yield* judge(run, request.intent).pipe(
    Effect.tap(() => Effect.sync(() => say(stepLine("judge", "complete")))),
    Effect.tapError((error) => Effect.sync(() => say(stepLine("judge", "error", error.message)))),
  );

  return { report, news } satisfies Scored;
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

/** The snapshot news as headers, for a plain answer. */
const newsHeaders = (news: SnapshotNews) => {
  const headers = new Headers();

  if (news.taken !== undefined) {
    headers.set(SNAPSHOT_TAKEN_HEADER, news.taken);
  }

  if (news.stale === true) {
    headers.set(SNAPSHOT_STALE_HEADER, "1");
  }

  return headers;
};

/**
 * Score, answering at once with the steps as they happen and the outcome
 * last. The work runs on past this handler, kept alive by `waitUntil`.
 */
const streamed = (state: cf.DurableObjectState, scoring: (say: Report) => Effect.Effect<Scored, SandboxFailure>) => {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  const say: Report = (line) => void writer.write(encoder.encode(`${line}\n`));

  const outcome = scoring(say).pipe(
    Effect.match({
      onSuccess: ({ report, news }) => outcomeLine(200, report, news),
      onFailure: (error) => outcomeLine(error.status, error.message),
    }),
  );

  state.waitUntil(
    Effect.runPromise(outcome).then(
      async (line) => {
        await writer.write(encoder.encode(line));
        await writer.close();
      },
      (cause) => writer.abort(cause),
    ),
  );

  return HttpServerResponse.fromWeb(new Response(readable, { headers: { "content-type": PROGRESS, "cache-control": "no-store" } }));
};

/** The request's body, decoded as `schema`; anything else is the caller's 400. */
export const bodyAs = <A>(request: HttpServerRequest.HttpServerRequest, schema: Schema.Decoder<A>, what: string) =>
  request.json.pipe(
    Effect.mapError(() => failure(400, "the body is not JSON")),
    Effect.flatMap((json) => Schema.decodeUnknownEffect(schema)(json).pipe(Effect.mapError((error) => failure(400, `not ${what}: ${String(error)}`)))),
  );

export const failureResponse = (error: { readonly status: number; readonly message: string }) =>
  Effect.succeed(HttpServerResponse.text(error.message, { status: error.status }));

/** A Durable Object's `fetch` answers every failure: the bridge takes only HTTP errors. */
export const answered = <R>(handled: Effect.Effect<HttpServerResponse.HttpServerResponse, SandboxFailure | HttpBodyError, R>) =>
  handled.pipe(
    Effect.catchTag("Sandbox.Failure", failureResponse),
    Effect.catchTag("HttpBodyError", (error) => failureResponse({ status: 500, message: `writing the answer: ${error.reason._tag}` })),
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
          const body = yield* request.json.pipe(Effect.orElseSucceed((): unknown => undefined));

          const scoring = (say: Report) =>
            Effect.gen(function* () {
              const machine = yield* machineOf(state.raw);
              const job = yield* Schema.decodeUnknownEffect(ScoreRequest)(body).pipe(Effect.mapError((error) => failure(400, `not a score request: ${String(error)}`)));

              return yield* score(machine, job, say);
              // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a request is an entry point
            }).pipe(Effect.provide(Clef.layerBinding(binding)));

          if (request.headers.accept?.includes(PROGRESS) === true) {
            return streamed(state.raw, scoring);
          }

          return yield* answered(
            scoring(quiet).pipe(Effect.flatMap(({ report, news }) => HttpServerResponse.json(report, { headers: newsHeaders(news) }))),
          );
        }),
      };
    });
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- alchemy's binding layer, provided where the Durable Object is declared
  }).pipe(Effect.provide(Cloudflare.Workers.AIBinding)),
) {}
