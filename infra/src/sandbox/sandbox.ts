/**
 * `Sandbox`: one Durable Object per piece of untrusted work (a attempt being
 * scored, later an agent's workspace), driving its container with the
 * platform's native API (`ctx.container`: start, exec, outbound interception).
 *
 * The container always runs with the internet off. What it may reach is
 * decided here, per phase, by routing hosts through `Egress`:
 *
 *   POST /score  (a ScoreRequest, from the tree)
 *     0. boot:    a fresh container, from the base's snapshot when the tree
 *        sent one; with `warm`, first warm one: prepare and fetch the base
 *        alone (no attempt's code), clear the workdir, snapshot. A snapshot
 *        that fails gives way to the image in the same scoring
 *     1. prepare: the attempt's repo (token added by Egress) and the nix/devenv
 *        caches; `ficus-scorer prepare` clones and restores the root's locked
 *        files, then `ficus-scorer fetch` builds the root's devenv shell and
 *        runs its `[fetch]`, with the hosts that names opened too
 *     2. check:   nothing; `ficus-scorer check` runs the root's checks, then
 *        the task's
 *   then the container is destroyed, and the root's judges (`[[judge]]` in
 *   its ficus.toml) are put to Clef here, through the Workers AI binding,
 *   with the task's intent and the attempt's diff. The answer is the ScoreReport,
 *   judges included as checks, or 422 when the attempt or root cannot be scored
 *   (retrying will not help). Beside the report (ScoreAnswer): the id of a
 *   snapshot it warmed, and `stale` when the one it was sent failed.
 *
 *   POST /rebase  (a RebaseRequest, from the tree)
 *     the behind attempt's repo (read) and the fresh attempt's repo (write), both
 *     with their tokens added by Egress; `ficus-scorer rebase` replays
 *     the behind commits onto the head and pushes. Nothing from either repo
 *     is run. The answer is the RebaseReport, or 422 on a conflict.
 *
 *   POST /deploy  (a DeployRequest plus the Cloudflare credentials, from the
 *                 Deploy Workflow, src/deploys)
 *     the released node's repo (read, token added by Egress) and the nix
 *     caches; `ficus-scorer deploy-prepare` clones the commit and reads its
 *     own `[deploy]`; then its hosts and the Cloudflare API (token added by
 *     Egress: the container sees a placeholder) while `ficus-scorer deploy`
 *     runs the part asked for: `run` in the deployer (deployer.run.ts),
 *     `deployer` here in a scoring sandbox. The answer is the DeployReport.
 *
 *   `/score` with `Accept: application/x-ndjson` answers with a stream
 *   instead (src/core/progress.ts): each step as it happens, the
 *   sandbox's own and `ficus-scorer`'s, then the outcome: what the plain
 *   answer would have been.
 *
 *   An agent's workspace (from AgentActor, src/agents):
 *   POST /workspace {remote, token}   start the container; for the agent's
 *                                     whole run it may reach its attempt's repo
 *                                     (token added by Egress) and the
 *                                     nix/devenv caches, nothing else
 *   POST /fs/<op>, POST /exec         pi's file and shell operations, run as
 *                                     `ficus-scorer fs <op>` / `exec` with the
 *                                     request on stdin; the answer is pi's
 *                                     Result, as JSON
 *   DELETE /workspace                 the agent is done: destroy the container
 *                                     and forget the workspace
 */
import { DurableObject } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as DecisionModel from "effect/ai/DecisionModel";
import { Clef } from "../clef/clef.ts";
import { DeployPrepared, DeployReport, DeployRequest } from "../core/deploy.ts";
import { phasesFirst, RebaseReport, RebaseRequest, ScoreRequest } from "../core/scoring.ts";
import { TOKEN_PLACEHOLDER } from "./deploy-token.ts";
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
  // Where github.com now redirects release downloads (a devenv's fetchurl).
  "release-assets.githubusercontent.com",
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
  // A root whose devenv uses secretspec (Ficus's own) asks why its shell is
  // entered; nothing in a sandbox reads a secret.
  SECRETSPEC_REASON: "Ficus sandbox: build and check, no secrets",
} as const;

const SCORER = "/usr/local/bin/ficus-scorer";

/** Where the platform writes a container's egress CA (context/trust-egress.sh). */
const EGRESS_CA = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";

/** The Cloudflare API, which a deploy reaches through Egress with the deploy token added. */
const CLOUDFLARE_API = "api.cloudflare.com";

/** A deploy: the released node, and the Cloudflare account and token it deploys with. The token goes to Egress only. */
const DeployCall = Schema.Struct({
  ...DeployRequest.fields,
  account_id: Schema.String,
  cloudflare_token: Schema.String,
});

/** `ficus-scorer`'s progress lines on stderr (src/scorer/scorer.ts `PROGRESS_PREFIX`). */
const PROGRESS_PREFIX = "ficus-progress ";

const PROGRESS = "application/x-ndjson";

/** Where progress lines go: the caller's stream, or nowhere. */
type Report = (line: string) => void;

const quiet: Report = () => undefined;

const stepLine = (step: string, state: "active" | "complete" | "error", detail?: string) =>
  JSON.stringify(detail === undefined ? { kind: "step", step, state } : { kind: "step", step, state, detail });

/** `ficus-scorer prepare`: the workdir, and the hosts the root's `[fetch]` opens next. */
const Prepared = Schema.Struct({ workdir: Schema.String, hosts: Schema.Array(Schema.String) });

/**
 * What an agent's workspace starts from: its attempt's remote and write token,
 * where to check it out, and who commits there.
 */
const Workspace = Schema.Struct({
  remote: Schema.String,
  token: Schema.String,
  checkout: Schema.String.check(Schema.isPattern(/^\/work\/[A-Za-z0-9._-]+$/)),
  author: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,64}$/)),
});

/**
 * The hosts the root's `[fetch]` opens for a workspace, read from the
 * checkout when it is first opened (at the base commit) and kept: an agent
 * that edits ficus.toml cannot widen its own network.
 */
const WORKSPACE_HOSTS_KEY = "workspace-hosts";

const Hosts = Schema.Array(Schema.String);

/** Where the background devenv build of a workspace writes its output. */
const DEVENV_WARM_LOG = "/tmp/devenv-warm.log";

/**
 * A workspace's container outlives an agent's slowest think between
 * operations. The agent closes it when it is done; this only catches one that
 * never says so, and every idle container holds one of the class's instances.
 */
const WORKSPACE_IDLE_MS = 20 * 60 * 1000;

/** Snapshotting the container may not hold its scoring up longer than this. */
const SNAPSHOT_TIMEOUT = "5 minutes";

/** One readiness probe: an exec into a container that cannot be placed can hang. */
const PROBE_TIMEOUT = "15 seconds";

type Workspace = typeof Workspace.Type;

/** Where a workspace keeps what it was opened with, to open it again. */
const WORKSPACE_KEY = "workspace";

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

/** Each line of `stream` as it arrives, the last one even without a newline. */
const eachLine = async (stream: ReadableStream | null, take: (line: string) => void) => {
  if (stream === null) {
    return;
  }

  let pending = "";

  for await (const chunk of stream.pipeThrough(new TextDecoderStream())) {
    const lines = (pending + chunk).split("\n");

    pending = lines.pop() ?? "";
    lines.forEach(take);
  }

  if (pending !== "") {
    take(pending);
  }
};

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
  /** Whether this instance has routed the workspace's egress (see `#open`). */
  #opened = false;

  override async fetch(request: Request): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (request.method === "POST" && pathname === "/workspace") {
      return respond(this.#workspace(request).pipe(Effect.as({ ready: true })));
    }

    if (request.method === "DELETE" && pathname === "/workspace") {
      return this.#respond(this.#close().pipe(Effect.as(Response.json({ closed: true }))));
    }

    const workspaceOp = /^\/(?:fs\/([a-z]+)|exec)$/.exec(pathname);

    if (request.method === "POST" && workspaceOp !== null) {
      const argv = workspaceOp[1] === undefined ? [SCORER, "exec"] : [SCORER, "fs", workspaceOp[1]];

      return this.#respond(this.#workspaceOp(argv, request));
    }

    if (request.method !== "POST") {
      return new Response("not found", { status: 404 });
    }

    switch (pathname) {
      case "/score": {
        if (request.headers.get("accept")?.includes(PROGRESS) === true) {
          return this.#streamed(request);
        }

        return respond(this.#scoreWithClef(request, quiet));
      }

      case "/rebase": {
        return respond(this.#rebase(request));
      }

      case "/deploy": {
        return respond(this.#deploy(request));
      }

      default: {
        return new Response("not found", { status: 404 });
      }
    }
  }

  /** Score, with the judges' Clef: a request is an entry point. */
  #scoreWithClef(request: Request, say: Report) {
    return this.#score(request, say).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a request is an entry point
      Effect.provide(Clef.layerBinding(this.env.AI)),
    );
  }

  #respond(answer: Effect.Effect<Response, SandboxFailure>): Promise<Response> {
    return Effect.runPromise(
      answer.pipe(
        Effect.catchTag("Sandbox.Failure", (error) => Effect.succeed(new Response(error.message, { status: error.status }))),
      ),
    );
  }

  /** Start an agent's container, its egress open to its attempt and the nix caches. */
  readonly #workspace = Effect.fn("Sandbox.workspace")(function* (this: Sandbox, request: Request) {
    const body = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () => failure(400, "the workspace request is not JSON"),
    });

    const workspace = yield* Schema.decodeUnknownEffect(Workspace)(body).pipe(
      Effect.mapError((error) => failure(400, `not a workspace request: ${String(error)}`)),
    );

    yield* Effect.promise(() => this.ctx.storage.put(WORKSPACE_KEY, workspace));
    yield* this.#open(workspace);
  });

  /** The agent is done: its container goes, and no later operation reopens it. */
  readonly #close = Effect.fn("Sandbox.close")(function* (this: Sandbox) {
    this.#opened = false;
    yield* Effect.promise(() => this.ctx.storage.delete([WORKSPACE_KEY, WORKSPACE_HOSTS_KEY]));

    if (this.#container().running) {
      yield* Effect.promise(() => this.#container().destroy());
    }
  });

  /**
   * Start the container if it is not running, route its egress, trust the
   * egress CA. The routes belong to this instance of the Durable Object, not
   * to the container: an agent's run outlives instances, so every new
   * instance opens the workspace again before its first operation.
   */
  readonly #open = Effect.fn("Sandbox.open")(function* (this: Sandbox, { remote, token, checkout, author }: Workspace) {
    const repo = repoOf(remote);

    yield* this.#ready();
    yield* Effect.promise(() => this.#container().setInactivityTimeout(WORKSPACE_IDLE_MS));
    yield* this.#route(repo.host, { mode: "artifacts", repos: [{ repoPath: repo.repoPath, token }] });

    for (const host of NIX_HOSTS) {
      yield* this.#route(host, { mode: "pass" });
    }

    const trusted = yield* this.#exec(["/usr/local/bin/ficus-trust-egress"]);

    if (trusted.exitCode !== 0) {
      return yield* failure(503, `trusting the egress CA: ${trusted.stderr.trim()}`);
    }

    // The checkout, as last pushed, if this container does not have it: a
    // container that was stopped comes back empty. The token stays with
    // Egress; git here never sees it.
    const cloned = yield* this.#exec([
      "/bin/sh",
      "-c",
      `if [ -d '${checkout}/.git' ]; then exit 0; fi; ${[
        `rm -rf '${checkout}'`,
        `mkdir -p "$(dirname '${checkout}')"`,
        `git clone --quiet '${remote}' '${checkout}'`,
        `git -C '${checkout}' config user.name '${author}'`,
        `git -C '${checkout}' config user.email '${author}@agents.ficus.dev'`,
      ].join(" && ")}`,
    ]);

    if (cloned.exitCode !== 0) {
      return yield* failure(502, `checking out the attempt: exit ${cloned.exitCode}: ${cloned.stderr.trim()}`);
    }

    for (const host of yield* this.#fetchHosts(checkout)) {
      yield* this.#route(host, { mode: "pass" });
    }

    // Warm the root's devenv shell in the background: built cold it takes
    // minutes, and an agent's first `devenv shell` then waits for this one
    // rather than starting its own. Once per container.
    yield* this.#exec([
      "/bin/sh",
      "-c",
      `cd '${checkout}' && [ -f devenv.nix ] && [ ! -e ${DEVENV_WARM_LOG} ] && (nohup devenv shell -- true > ${DEVENV_WARM_LOG} 2>&1 &) ; true`,
    ]);

    this.#opened = true;
  });

  /** The root's fetch hosts for this workspace: kept from its first open, or read now. */
  readonly #fetchHosts = Effect.fn("Sandbox.fetchHosts")(function* (this: Sandbox, checkout: string) {
    const stored = yield* Effect.promise(() => this.ctx.storage.get(WORKSPACE_HOSTS_KEY));

    if (stored !== undefined) {
      return yield* Schema.decodeUnknownEffect(Hosts)(stored).pipe(Effect.mapError(() => failure(500, "the kept fetch hosts are unreadable")));
    }

    const read = yield* this.#exec([SCORER, "hosts", checkout]);
    const hosts = yield* this.#json(read, Hosts, "hosts");

    yield* Effect.promise(() => this.ctx.storage.put(WORKSPACE_HOSTS_KEY, hosts));

    return hosts;
  });

  /** One of pi's operations in an agent's container, its answer passed through. */
  readonly #workspaceOp = Effect.fn("Sandbox.workspaceOp")(function* (this: Sandbox, argv: ReadonlyArray<string>, request: Request) {
    if (!this.#opened) {
      const stored = yield* Effect.promise(() => this.ctx.storage.get(WORKSPACE_KEY));

      const workspace = yield* Schema.decodeUnknownEffect(Workspace)(stored).pipe(
        Effect.mapError(() => failure(409, "no workspace here: POST /workspace first")),
      );

      yield* this.#open(workspace);
    }

    const container = this.#container();

    const input = yield* Effect.tryPromise({
      try: () => request.text(),
      catch: () => failure(400, "the request body could not be read"),
    });

    const answer = yield* Effect.tryPromise({
      try: async () => {
        const running = await container.exec([...argv], {
          env: { ...EXEC_ENV },
          stdin: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(input));
              controller.close();
            },
          }),
          stdout: "pipe",
          stderr: "pipe",
        });

        const [stdout, stderr] = await Promise.all([new Response(running.stdout).text(), new Response(running.stderr).text()]);

        return { exitCode: await running.exitCode, stdout, stderr } satisfies Ran;
      },
      catch: (cause) => failure(503, `${argv.slice(1).join(" ")}: ${String(cause)}`),
    });

    if (answer.exitCode !== 0) {
      const why = `${argv.slice(1).join(" ")} exited ${answer.exitCode}: ${answer.stderr.trim() || answer.stdout.trim()}`;

      console.error(`workspace: ${why}`);

      return yield* failure(500, why);
    }

    return new Response(answer.stdout, { headers: { "content-type": "application/json" } });
  });

  /** Score, answering at once with the steps as they happen, the outcome last. */
  #streamed(request: Request): Response {
    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();
    const report: Report = (line) => void writer.write(encoder.encode(`${line}\n`));

    const outcome = this.#scoreWithClef(request, report).pipe(
      Effect.match({
        onSuccess: (body) => ({ kind: "outcome", status: 200, body }),
        onFailure: (error) => ({ kind: "outcome", status: error.status, body: error.message }),
      }),
    );

    this.ctx.waitUntil(
      Effect.runPromise(outcome).then(
        (line) => {
          report(JSON.stringify(line));

          return writer.close();
        },
        (cause) => writer.abort(cause),
      ),
    );

    return new Response(readable, { headers: { "content-type": PROGRESS, "cache-control": "no-store" } });
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

  readonly #rebase = Effect.fn("Sandbox.rebase")(function* (this: Sandbox, request: Request) {
    const job = yield* this.#body(request, RebaseRequest, "rebase");
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

    const replayed = yield* this.#exec([SCORER, "rebase", ref]);
    const report = yield* this.#json(replayed, RebaseReport, "rebase");

    yield* Effect.promise(() => this.#container().destroy());

    return report;
  });

  /** Deploy a released node: clone its commit, then run its own `[deploy]` with the Cloudflare API open. */
  readonly #deploy = Effect.fn("Sandbox.deploy")(function* (this: Sandbox, request: Request) {
    const call = yield* this.#body(request, DeployCall, "deploy");

    // A container an earlier deploy left (one that failed half-way) carries
    // that deploy's state: start from a fresh one, and leave none behind.
    yield* this.#discard();

    return yield* this.#deployIn(call).pipe(Effect.ensuring(this.#discard()));
  });

  /** Stop and remove the container, if one is running. */
  #discard() {
    return Effect.promise(async () => {
      const container = this.#container();

      if (container.running) {
        await container.destroy();
      }
    });
  }

  readonly #deployIn = Effect.fn("Sandbox.deployIn")(function* (this: Sandbox, call: typeof DeployCall.Type) {
    const repo = repoOf(call.remote);
    const ref = JSON.stringify({ remote: call.remote, commit: call.commit, part: call.part });

    yield* this.#ready();
    yield* this.#route(repo.host, { mode: "artifacts", repos: [{ repoPath: repo.repoPath, token: call.token }] });

    for (const host of NIX_HOSTS) {
      yield* this.#route(host, { mode: "pass" });
    }

    const trusted = yield* this.#exec(["/usr/local/bin/ficus-trust-egress"]);

    if (trusted.exitCode !== 0) {
      return yield* failure(503, `trusting the egress CA: ${trusted.stderr.trim()}`);
    }

    const prepared = yield* this.#json(yield* this.#exec([SCORER, "deploy-prepare", ref]), DeployPrepared, "deploy-prepare");

    if (!prepared.deploys) {
      return DeployReport.make({ deployed: false, passed: true, millis: 0, tail: `the released commit's ficus.toml has no [deploy] ${call.part}` });
    }

    for (const host of prepared.hosts) {
      yield* this.#route(host, { mode: "pass" });
    }

    yield* this.#route(CLOUDFLARE_API, { mode: "cloudflare", token: call.cloudflare_token });

    const deployed = yield* this.#exec([SCORER, "deploy", prepared.workdir], quiet, {
      CLOUDFLARE_ACCOUNT_ID: call.account_id,
      CLOUDFLARE_API_TOKEN: TOKEN_PLACEHOLDER,
    });

    return yield* this.#json(deployed, DeployReport, "deploy");
  });

  readonly #score = Effect.fn("Sandbox.score")(function* (this: Sandbox, request: Request, say: Report) {
    const score = yield* this.#body(request, ScoreRequest, "score");
    const given = score.snapshot;
    const started = Date.now();

    // A snapshot that will not restore, or whose container fails before its
    // checks for the sandbox's own reasons, gives way to the image in this
    // same scoring, which warms a fresh one; the tree forgets the stale one.
    const { run, taken, stale } = yield* this.#scoreIn(score, say, given, given === undefined && score.warm === true).pipe(
      Effect.catchIf(
        (error) => given !== undefined && error.status !== 422,
        (error) => {
          console.log(`sandbox: snapshot ${given} failed (${error.message}); booting the image`);

          return this.#scoreIn(score, say, undefined, true).pipe(
            Effect.map((cold) => ({ ...cold, run: { ...cold.run, report: phasesFirst([{ name: "snapshot_failed", millis: cold.started - started }], cold.run.report) }, stale: true })),
          );
        },
      ),
    );

    if (run.judges.length === 0) {
      return { ...run.report, snapshot: taken, stale };
    }

    say(stepLine("judge", "active"));

    return yield* this.#judge(run, score.intent).pipe(
      Effect.map((report) => ({ ...report, snapshot: taken, stale })),
      Effect.tap(() => Effect.sync(() => say(stepLine("judge", "complete")))),
      Effect.tapError((error) => Effect.sync(() => say(stepLine("judge", "error", error.message)))),
    );
  });

  /**
   * One run of a scoring's container, in a fresh one: booted from `snapshot`
   * or the image, warming a snapshot of the base first when `warm`, then
   * prepare, fetch and check the attempt, then destroyed.
   */
  readonly #scoreIn = Effect.fn("Sandbox.scoreIn")(function* (this: Sandbox, score: ScoreRequest, say: Report, snapshot: string | undefined, warm: boolean) {
    const repo = repoOf(score.remote);
    const attempt = JSON.stringify({ remote: score.remote, base: score.base, head: score.head, checks: score.checks ?? [] });

    // A container an earlier run left holds its attempt: a snapshot must
    // hold the base alone, and a boot from one must be this one.
    yield* this.#discard();

    const started = Date.now();

    say(stepLine("sandbox", "active"));
    yield* this.#ready(snapshot).pipe(Effect.tapError((error) => Effect.sync(() => say(stepLine("sandbox", "error", error.message)))));

    const ready = Date.now();

    yield* this.#route(repo.host, { mode: "artifacts", repos: [{ repoPath: repo.repoPath, token: score.token }] });

    for (const host of NIX_HOSTS) {
      yield* this.#route(host, { mode: "pass" });
    }

    // The egress CA exists only now that HTTPS interception is on.
    const trusted = yield* this.#exec(["/usr/local/bin/ficus-trust-egress"]);

    if (trusted.exitCode !== 0) {
      say(stepLine("sandbox", "error", "could not trust the egress CA"));

      return yield* failure(503, `trusting the egress CA: ${trusted.stderr.trim()}`);
    }

    const opened = Date.now();
    const taken = warm ? yield* this.#warm(score) : undefined;

    say(stepLine("sandbox", "complete"));

    const sandbox = [
      // Whether the boot came from the base's snapshot.
      { name: snapshot === undefined ? "container" : "snapshot", millis: ready - started },
      { name: "egress", millis: opened - ready },
      ...(warm ? [{ name: "warm", millis: Date.now() - opened }] : []),
    ];

    const prepared = yield* this.#exec([SCORER, "prepare", attempt], say);
    const { workdir, hosts } = yield* this.#json(prepared, Prepared, "prepare");

    // The root's own fetch hosts (packages), read from the base
    // commit by `prepare`: open while its devenv builds and its fetch runs.
    for (const host of hosts) {
      yield* this.#route(host, { mode: "pass" });
    }

    const fetched = yield* this.#exec([SCORER, "fetch", workdir], say);

    // Close everything before any of the root's checks run.
    for (const host of new Set([repo.host, ...NIX_HOSTS, ...hosts])) {
      yield* this.#route(host, { mode: "deny" });
    }

    if (fetched.exitCode !== 0) {
      return yield* failure(500, `fetch exited ${fetched.exitCode}: ${fetched.stderr.trim()}`);
    }

    const checked = yield* this.#exec([SCORER, "check", workdir], say);
    const checkRun = yield* this.#json(checked, CheckRun, "check");
    const run = { ...checkRun, report: phasesFirst(sandbox, checkRun.report) };

    yield* Effect.promise(() => this.#container().destroy());

    return { run, taken, started, stale: false };
  });

  /**
   * Warm a snapshot of the base: prepare it alone (clone, its devenv shell
   * and its fetch; no attempt's code), clear the workdir, snapshot the
   * container. Its id, or nothing: a failure here only costs the base's
   * later scorings their warm boot, never this one.
   */
  readonly #warm = Effect.fn("Sandbox.warm")(
    function* (this: Sandbox, score: ScoreRequest) {
      const base = JSON.stringify({ remote: score.remote, base: score.base, head: score.base });
      const { workdir, hosts } = yield* this.#json(yield* this.#exec([SCORER, "prepare", base]), Prepared, "warm prepare");

      for (const host of hosts) {
        yield* this.#route(host, { mode: "pass" });
      }

      const fetched = yield* this.#exec([SCORER, "fetch", workdir]);

      // The base's checkout goes; what its devenv and fetch left outside it
      // (the nix store, package caches) stays. So does no egress CA: the
      // platform writes one per container.
      const cleared = yield* this.#exec(["/bin/sh", "-c", `rm -rf '${workdir}' && { rm -f ${EGRESS_CA} || true; }`]);

      if (fetched.exitCode !== 0 || cleared.exitCode !== 0) {
        return yield* failure(500, `warming: fetch exited ${fetched.exitCode}, clearing ${cleared.exitCode}: ${fetched.stderr.trim()} ${cleared.stderr.trim()}`);
      }

      const taken = yield* Effect.tryPromise({
        try: () => this.#container().snapshotContainer({ name: `base-${score.base.slice(0, 12)}` }),
        catch: (cause) => failure(503, `snapshotting: ${String(cause)}`),
      }).pipe(Effect.timeoutOrElse({ duration: SNAPSHOT_TIMEOUT, orElse: () => Effect.fail(failure(503, `snapshotting: no answer within ${SNAPSHOT_TIMEOUT}`)) }));

      console.log(`sandbox: took snapshot ${taken.id} of base ${score.base} (${taken.size} bytes)`);

      return taken.id;
    },
    (warming) => warming.pipe(Effect.catch((error) => Effect.sync(() => console.log(`sandbox: no snapshot of the base: ${error.message}`)).pipe(Effect.as(undefined)))),
  );

  /** The report with the root's judges' outcomes added. A Clef failure is retryable: 503. */
  readonly #judge = Effect.fn("Sandbox.judge")(function* (run: Schema.Schema.Type<typeof CheckRun>, task: string) {
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
    for (const judge of run.judges) {
      outcomes.push(judged(judge, answers[judge.name]?.probability ?? 0, millis));
    }

    return { ...run.report, checks: [...run.report.checks, ...outcomes] };
  });

  #container(): Container {
    const container = this.ctx.container;

    if (container === undefined) {
      throw new Error("this Durable Object has no container: check the Sandbox class's container binding");
    }

    return container;
  }

  /**
   * Start the container with the internet off, from `snapshot` when given,
   * and wait for its entrypoint. A boot started here carries a nonce the
   * entrypoint writes to the ready marker, so a marker restored from a
   * snapshot never passes for it; a container already running (a workspace's,
   * from an earlier instance) passes on any marker.
   */
  readonly #ready = Effect.fn("Sandbox.ready")(function* (this: Sandbox, snapshot?: string) {
    const container = this.#container();
    let boot = "";

    yield* Effect.tryPromise({
      try: async () => {
        // Started here, and again if it stopped while booting: several cold
        // containers starting at once can take minutes.
        if (!container.running) {
          boot = crypto.randomUUID();
          const env = { FICUS_BOOT: boot };

          container.start(snapshot === undefined ? { enableInternet: false, env } : { enableInternet: false, env, containerSnapshot: { id: snapshot } });
        }

        const probe = await container.exec(["/bin/sh", "-c", 'test -f /run/ficus-ready && { [ -z "$0" ] || [ "$(cat /run/ficus-ready)" = "$0" ]; }', boot], {
          env: { ...EXEC_ENV },
        });

        if ((await probe.exitCode) !== 0) {
          throw new Error("entrypoint still running");
        }
      },
      catch: (cause) => failure(503, `the sandbox did not become ready: ${String(cause)}`),
    }).pipe(
      Effect.timeoutOrElse({
        duration: PROBE_TIMEOUT,
        orElse: () => Effect.fail(failure(503, `the sandbox did not become ready: no answer within ${PROBE_TIMEOUT}`)),
      }),
      // A snapshot that will not restore gives way to the image sooner.
      Effect.retry({ schedule: Schedule.spaced("1 second"), times: snapshot === undefined ? 240 : 60 }),
    );
  });

  /** Route `host`'s HTTPS through `Egress` with `props`. Replaces any earlier route. */
  readonly #route = Effect.fn("Sandbox.route")(function* (this: Sandbox, host: string, props: EgressProps) {
    const container = this.#container();

    yield* Effect.tryPromise({
      try: () => container.interceptOutboundHttps(host, this.ctx.exports.Egress({ props })),
      catch: (cause) => failure(500, `routing ${host}: ${String(cause)}`),
    });
  });

  /**
   * Run `argv`. Its stderr is read as it is written: progress lines go to
   * `report` at once, the rest is kept as the command's error text.
   */
  readonly #exec = Effect.fn("Sandbox.exec")(function* (
    this: Sandbox,
    argv: ReadonlyArray<string>,
    report: Report = quiet,
    cloudflare?: { readonly CLOUDFLARE_ACCOUNT_ID: string; readonly CLOUDFLARE_API_TOKEN: string },
  ) {
    const container = this.#container();

    return yield* Effect.tryPromise({
      try: async () => {
        const running = await container.exec([...argv], { env: { ...EXEC_ENV, ...cloudflare }, stdout: "pipe", stderr: "pipe" });
        const kept: Array<string> = [];

        const [stdout] = await Promise.all([
          new Response(running.stdout).text(),
          eachLine(running.stderr, (line) => {
            if (line.startsWith(PROGRESS_PREFIX)) {
              report(line.slice(PROGRESS_PREFIX.length));
            } else {
              kept.push(line);
            }
          }),
        ]);

        return { exitCode: await running.exitCode, stdout, stderr: kept.join("\n") } satisfies Ran;
      },
      catch: (cause) => failure(503, `${argv.slice(0, 2).join(" ")}: ${String(cause)}`),
    });
  });

  /** A `ficus-scorer` result: 2 is the attempt's or root's fault, other failures the sandbox's. */
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
