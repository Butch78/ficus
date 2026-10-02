/**
 * `Sandbox`: one Durable Object per piece of untrusted work (a leaf being
 * scored, later an agent's workspace), driving its container with the
 * platform's native API (`ctx.container`: start, exec, outbound interception).
 *
 * The container always runs with the internet off. What it may reach is
 * decided here, per phase, by routing hosts through `Egress`:
 *
 *   POST /score  (a ScoreRequest, from the tree)
 *     1. prepare: the leaf's repo (token added by Egress) and the nix/devenv
 *        caches; `ficus-scorer prepare` clones, restores the root's locked
 *        files and builds the root's devenv shell
 *     2. check:   nothing; `ficus-scorer check` runs the root's checks, then
 *        the bud's
 *   then the container is destroyed, and the root's judges (`[[judge]]` in
 *   its ficus.toml) are put to Clef here, through the Workers AI binding,
 *   with the bud's intent and the leaf's diff. The answer is the ScoreReport,
 *   judges included as checks, or 422 when the leaf or root cannot be scored
 *   (retrying will not help).
 *
 *   POST /transplant  (a TransplantRequest, from the tree)
 *     the stale leaf's repo (read) and the fresh leaf's repo (write), both
 *     with their tokens added by Egress; `ficus-scorer transplant` replays
 *     the stale commits onto the head and pushes. Nothing from either repo
 *     is run. The answer is the TransplantReport, or 422 on a conflict.
 */
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as DecisionModel from "effect/ai/DecisionModel";
import { Clef } from "../clef/clef.ts";
import type { EgressProps } from "./egress.ts";
import { type CheckOutcome, CheckRun, judged, judging } from "./judges.ts";
import { repoOf } from "./repo.ts";

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import("./worker.ts");
    }
  }
}

/**
 * What a root's devenv shell downloads while it builds: binary caches, and
 * GitHub for flake inputs such as cachix/devenv-nixpkgs.
 */
export const NIX_HOSTS = [
  "cache.nixos.org",
  "devenv.cachix.org",
  "github.com",
  "api.github.com",
  "codeload.github.com",
  "objects.githubusercontent.com",
] as const;

/**
 * The environment every exec runs with: the image's (context/Dockerfile), so
 * it does not depend on what the platform's exec inherits. The CA bundle is
 * the one the entrypoint extends with the egress CA.
 */
const EXEC_ENV = {
  PATH: "/usr/local/bin:/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/nix/var/nix/profiles/default/sbin",
  HOME: "/root",
  USER: "root",
  SSL_CERT_FILE: "/etc/ssl/certs/ca-bundle.crt",
  NIX_SSL_CERT_FILE: "/etc/ssl/certs/ca-bundle.crt",
  GIT_SSL_CAINFO: "/etc/ssl/certs/ca-bundle.crt",
} as const;

const SCORER = "/usr/local/bin/ficus-scorer";

const Oid = Schema.String.check(Schema.isPattern(/^[0-9a-f]{40}([0-9a-f]{24})?$/));

/** crates/ficus-core `CheckSpec`: a bud's check, run after the root's. */
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
  // Optional: a tree Worker from before judges sends none.
  intent: Schema.optional(Schema.String),
  checks: Schema.optional(Schema.Array(CheckSpec)),
});

export interface ScoreRequest extends Schema.Schema.Type<typeof ScoreRequest> {}

/** crates/ficus-core `TransplantRequest`. */
export const TransplantRequest = Schema.Struct({
  from: Schema.String,
  from_token: Schema.String,
  from_base: Oid,
  from_head: Oid,
  onto: Schema.String,
  onto_token: Schema.String,
  onto_head: Oid,
  onto_branch: Schema.String,
});

export interface TransplantRequest extends Schema.Schema.Type<typeof TransplantRequest> {}

const Prepared = Schema.Struct({ workdir: Schema.String });

/** crates/ficus-core `TransplantReport`. */
const TransplantReport = Schema.Struct({ commit: Oid, replayed: Schema.Number });

export class SandboxFailure extends Schema.TaggedError<SandboxFailure>()("Sandbox.Failure", {
  status: Schema.Number,
  message: Schema.String,
}) {}

const failure = (status: number, message: string) => new SandboxFailure({ status, message });

interface Ran {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface Bindings {
  readonly AI: Clef.AiBinding;
}

/** The report as JSON, or the failure's status and message. */
const respond = <A>(run: Effect.Effect<A, SandboxFailure>): Promise<Response> =>
  Effect.runPromise(
    run.pipe(
      Effect.map((report) => Response.json(report)),
      Effect.catchTag("Sandbox.Failure", (error) => Effect.succeed(new Response(error.message, { status: error.status }))),
    ),
  );

export class Sandbox extends DurableObject<Bindings> {
  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    switch (pathname) {
      case "/score": {
        return respond(
          this.#score(request).pipe(
            // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a request is an entry point
            Effect.provide(Clef.layerBinding(this.env.AI)),
          ),
        );
      }

      case "/transplant": {
        return respond(this.#transplant(request));
      }

      default: {
        return new Response("not found", { status: 404 });
      }
    }
  }

  /** The request body, decoded as `schema`. */
  readonly #body = Effect.fn("Sandbox.body")(function* <A>(this: Sandbox, request: Request, schema: Schema.Decoder<A>, what: string) {
    const body = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () => failure(400, `the ${what} request is not JSON`),
    });

    return yield* Schema.decodeUnknownEffect(schema)(body).pipe(
      Effect.mapError((error) => failure(400, `not a ${what} request: ${String(error)}`)),
    );
  });

  readonly #transplant = Effect.fn("Sandbox.transplant")(function* (this: Sandbox, request: Request) {
    const job = yield* this.#body(request, TransplantRequest, "transplant");
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

    yield* this.#ready();

    // Both repos live in the same Artifacts namespace, so on one host.
    const grants = [
      { repoPath: from.repoPath, token: job.from_token },
      { repoPath: onto.repoPath, token: job.onto_token },
    ];

    yield* this.#route(from.host, { mode: "artifacts", repos: grants });

    if (onto.host !== from.host) {
      yield* this.#route(onto.host, { mode: "artifacts", repos: grants });
    }

    const trusted = yield* this.#exec(["/usr/local/bin/ficus-trust-egress"]);

    if (trusted.exitCode !== 0) {
      return yield* failure(503, `trusting the egress CA: ${trusted.stderr.trim()}`);
    }

    const replayed = yield* this.#exec([SCORER, "transplant", ref]);
    const report = yield* this.#json(replayed, TransplantReport, "transplant");

    yield* Effect.promise(() => this.#container().destroy());

    return report;
  });

  readonly #score = Effect.fn("Sandbox.score")(function* (this: Sandbox, request: Request) {
    const score = yield* this.#body(request, ScoreRequest, "score");
    const repo = repoOf(score.remote);
    const leaf = JSON.stringify({ remote: score.remote, base: score.base, head: score.head, checks: score.checks ?? [] });

    yield* this.#ready();
    yield* this.#route(repo.host, { mode: "artifacts", repos: [{ repoPath: repo.repoPath, token: score.token }] });

    for (const host of NIX_HOSTS) {
      yield* this.#route(host, { mode: "pass" });
    }

    // The egress CA exists only now that HTTPS interception is on.
    const trusted = yield* this.#exec(["/usr/local/bin/ficus-trust-egress"]);

    if (trusted.exitCode !== 0) {
      return yield* failure(503, `trusting the egress CA: ${trusted.stderr.trim()}`);
    }

    const prepared = yield* this.#exec([SCORER, "prepare", leaf]);

    // Close everything before any of the root's checks run.
    yield* this.#route(repo.host, { mode: "deny" });

    for (const host of NIX_HOSTS) {
      yield* this.#route(host, { mode: "deny" });
    }

    const { workdir } = yield* this.#json(prepared, Prepared, "prepare");
    const checked = yield* this.#exec([SCORER, "check", workdir]);
    const run = yield* this.#json(checked, CheckRun, "check");

    yield* Effect.promise(() => this.#container().destroy());

    return yield* this.#judge(run, score.intent ?? "");
  });

  /** The report with the root's judges' outcomes added. A Clef failure is retryable: 503. */
  readonly #judge = Effect.fn("Sandbox.judge")(function* (run: Schema.Schema.Type<typeof CheckRun>, task: string) {
    if (run.judges.length === 0) {
      return run.report;
    }

    const started = Date.now();

    const { answers } = yield* DecisionModel.decide(judging(run.judges), { input: { task, diff: run.diff } }).pipe(
      Effect.mapError((error) => failure(503, `judging the leaf: ${error.message}`)),
    );

    const millis = Date.now() - started;
    const outcomes: Array<CheckOutcome> = [];

    // DecisionModel has checked every judge got its answer.
    for (const judge of run.judges) {
      outcomes.push(judged(judge, answers[judge.name]?.probability ?? 0, millis));
    }

    return { checks: [...run.report.checks, ...outcomes], cost: run.report.cost };
  });

  #container(): Container {
    const container = this.ctx.container;

    if (container === undefined) {
      throw new Error("this Durable Object has no container: check the Sandbox class's container binding");
    }

    return container;
  }

  /** Start the container with the internet off, and wait for its entrypoint. */
  readonly #ready = Effect.fn("Sandbox.ready")(function* (this: Sandbox) {
    const container = this.#container();

    if (!container.running) {
      container.start({ enableInternet: false });
    }

    yield* Effect.tryPromise({
      try: async () => {
        const probe = await container.exec(["/bin/sh", "-c", "test -f /run/ficus-ready"], { env: { ...EXEC_ENV } });

        if ((await probe.exitCode) !== 0) {
          throw new Error("entrypoint still running");
        }
      },
      catch: (cause) => failure(503, `the sandbox did not become ready: ${String(cause)}`),
    }).pipe(Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 }));
  });

  /** Route `host`'s HTTPS through `Egress` with `props`. Replaces any earlier route. */
  readonly #route = Effect.fn("Sandbox.route")(function* (this: Sandbox, host: string, props: EgressProps) {
    const container = this.#container();

    yield* Effect.tryPromise({
      try: () => container.interceptOutboundHttps(host, this.ctx.exports.Egress({ props })),
      catch: (cause) => failure(500, `routing ${host}: ${String(cause)}`),
    });
  });

  readonly #exec = Effect.fn("Sandbox.exec")(function* (this: Sandbox, argv: ReadonlyArray<string>) {
    const container = this.#container();

    const output = yield* Effect.tryPromise({
      try: async () => (await container.exec([...argv], { env: { ...EXEC_ENV } })).output(),
      catch: (cause) => failure(503, `${argv.slice(0, 2).join(" ")}: ${String(cause)}`),
    });

    const decoder = new TextDecoder();

    return {
      exitCode: output.exitCode,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    } satisfies Ran;
  });

  /** A `ficus-scorer` result: 2 is the leaf's or root's fault, other failures the sandbox's. */
  readonly #json = Effect.fn("Sandbox.json")(function* <A>(
    this: Sandbox,
    ran: Ran,
    schema: Schema.Decoder<A>,
    phase: string,
  ) {
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
}
