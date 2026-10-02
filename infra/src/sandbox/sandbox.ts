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
 *     2. check:   nothing; `ficus-scorer check` runs the root's checks
 *   then the container is destroyed. The answer is the ScoreReport, or 422
 *   when the leaf or root cannot be scored (retrying will not help).
 */
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type { EgressProps } from "./egress.ts";
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

/** crates/ficus-core `ScoreRequest`. */
export const ScoreRequest = Schema.Struct({
  remote: Schema.String,
  token: Schema.String,
  base: Oid,
  head: Oid,
});

export interface ScoreRequest extends Schema.Schema.Type<typeof ScoreRequest> {}

const Prepared = Schema.Struct({ workdir: Schema.String });

/** crates/ficus-core `ScoreReport`, checked before it is passed on. */
const ScoreReport = Schema.Struct({
  checks: Schema.Array(
    Schema.Struct({ name: Schema.String, passed: Schema.Boolean, millis: Schema.Number, tail: Schema.String }),
  ),
  cost: Schema.Number,
});

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

export class Sandbox extends DurableObject<object> {
  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method !== "POST" || pathname !== "/score") {
      return new Response("not found", { status: 404 });
    }

    return Effect.runPromise(
      this.#score(request).pipe(
        Effect.map((report) => Response.json(report)),
        Effect.catchTag("Sandbox.Failure", (error) => Effect.succeed(new Response(error.message, { status: error.status }))),
      ),
    );
  }

  readonly #score = Effect.fn("Sandbox.score")(function* (this: Sandbox, request: Request) {
    const body = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () => failure(400, "the score request is not JSON"),
    });

    const score = yield* Schema.decodeUnknownEffect(ScoreRequest)(body).pipe(
      Effect.mapError((error) => failure(400, `not a score request: ${String(error)}`)),
    );

    const repo = repoOf(score.remote);
    const leaf = JSON.stringify({ remote: score.remote, base: score.base, head: score.head });

    yield* this.#ready();
    yield* this.#route(repo.host, { mode: "artifacts", repoPath: repo.repoPath, token: score.token });

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
    const report = yield* this.#json(checked, ScoreReport, "check");

    yield* Effect.promise(() => this.#container().destroy());

    return report;
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
