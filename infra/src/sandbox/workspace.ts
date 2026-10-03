/**
 * `Worktree`: one Durable Object per agent, driving the container the
 * agent works in, with the runtime's native API. `AgentActor`'s
 * `ContainerEnv` (src/agents/sandbox-env.ts) is its one caller.
 *
 *   POST /prepare  { remote, token, base_commit, agent, snapshot? }
 *                  boot (from the base's warmed snapshot when given), open
 *                  the attempt's repo (token added by Egress, never in the
 *                  container) and the nix caches, clone the attempt
 *   POST /exec     { command, cwd?, env?, timeout_ms? }    pi's Result; a
 *                  command runs with no stdin and stops at its timeout, or
 *                  at DEFAULT_EXEC_MS
 *   POST /fs/<op>  pi's file operations, through `ficus-scorer fs`
 *
 * The attempt's repo and the caches stay open while the agent works: it pushes
 * its commits and runs the root's checks through devenv. A container the
 * platform reaped is booted and cloned again on the next call; what the
 * agent had not pushed is gone, which its rules (commit, push, then
 * submit) already account for.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { WorktreeContainer } from "./containers.ts";
import {
  boot,
  EXEC_ENV,
  exec,
  failure,
  machineOf,
  type Machine,
  NIX_HOSTS,
  route,
  SCORER,
  trustEgress,
} from "./machine.ts";
import { repoOf } from "./repo.ts";
import { answered, bodyAs } from "./sandbox.ts";

/** Where the attempt is checked out; src/agents/actor.ts `ATTEMPT_DIR`. */
export const ATTEMPT_DIR = "/work/attempt";

/**
 * How long a command may run when the agent sets no timeout (pi's bash tool
 * has none): past the 20 minutes a cold devenv shell may take to build. A
 * command that never ends would otherwise hold the agent forever.
 */
export const DEFAULT_EXEC_MS = 30 * 60 * 1000;

/** How long an idle workspace container lives: an agent can think for a while between tool calls. */
const IDLE_MS = 60 * 60 * 1000;

export const Preparation = Schema.Struct({
  remote: Schema.String,
  token: Schema.String,
  base_commit: Schema.String,
  agent: Schema.String,
  snapshot: Schema.optional(Schema.String),
});

export interface Preparation extends Schema.Schema.Type<typeof Preparation> {}

const PREPARATION_KEY = "preparation";

const ExecRequest = Schema.Struct({
  command: Schema.String,
  cwd: Schema.optional(Schema.String),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  timeout_ms: Schema.optional(Schema.Number),
});

/** Single-quote `value` for /bin/sh. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Boot, open the attempt's repo and the caches, and clone the attempt. */
const prepare = Effect.fn("Workspace.prepare")(function* (machine: Machine, preparation: Preparation) {
  const booted = yield* boot(machine, preparation.snapshot);
  const repo = repoOf(preparation.remote);

  yield* Effect.tryPromise({
    try: () => machine.container.setInactivityTimeout(IDLE_MS),
    catch: (cause) => failure(503, `setting the idle timeout: ${String(cause)}`),
  });

  yield* route(machine, repo.host, { mode: "artifacts", repos: [{ repoPath: repo.repoPath, token: preparation.token }] });

  for (const host of NIX_HOSTS) {
    yield* route(machine, host, { mode: "pass" });
  }

  yield* trustEgress(machine);

  const script = [
    `rm -rf ${ATTEMPT_DIR} && mkdir -p /work`,
    `git clone --quiet ${quote(preparation.remote)} ${ATTEMPT_DIR}`,
    `cd ${ATTEMPT_DIR}`,
    `git config user.name ${quote(preparation.agent)}`,
    `git config user.email ${quote(`${preparation.agent}@agents.ficus.dev`)}`,
  ].join(" && ");

  const cloned = yield* exec(machine, ["/bin/sh", "-c", script]);

  if (cloned.exitCode !== 0) {
    return yield* failure(502, `cloning the attempt: ${cloned.stderr.trim()}`);
  }

  return booted;
});

/** What a finished command answers: sandbox-env.ts `ExecAnswer`. */
interface ExecValue {
  readonly exitCode: number;
  readonly output: string;
}

/** pi's `Result`, as `ContainerEnv` decodes it. */
const ok = (value: ExecValue) => HttpServerResponse.json({ ok: true, value });

/** A file operation's request, passed to `ficus-scorer fs` as it came (fs.rs `FsRequest` checks it). */
const FsRequest = Schema.Record(Schema.String, Schema.Json);

type FsRequest = Schema.Schema.Type<typeof FsRequest>;

const refused = (code: string, message: string) => HttpServerResponse.json({ ok: false, error: { code, message } });

/** A command that did not finish: pi's `ExecutionError` code and why. */
class ExecFailed extends Schema.TaggedError<ExecFailed>()("Workspace.ExecFailed", {
  code: Schema.Literals(["timeout", "spawn_error"]),
  message: Schema.String,
}) {}

const runCommand = Effect.fn("Workspace.exec")(function* (
  machine: Machine,
  request: Schema.Schema.Type<typeof ExecRequest>,
) {
  const process = yield* Effect.tryPromise({
    try: () =>
      // No stdin: an interactive command (`devenv shell` without `--`, a
      // prompt) gets end-of-file at once instead of waiting for input forever.
      machine.container.exec(["/bin/sh", "-c", `exec </dev/null\n${request.command}`], {
        cwd: request.cwd ?? ATTEMPT_DIR,
        env: { ...EXEC_ENV, ...request.env },
        stderr: "combined",
      }),
    catch: (cause) => new ExecFailed({ code: "spawn_error", message: String(cause) }),
  });

  const output = Effect.tryPromise({
    try: () => process.output(),
    catch: (cause) => new ExecFailed({ code: "spawn_error", message: String(cause) }),
  });

  // A command past its time is killed; pi reads that as `timeout`.
  const limit = request.timeout_ms ?? DEFAULT_EXEC_MS;

  const timed = output.pipe(
    Effect.timeoutOption(Duration.millis(limit)),
    Effect.flatMap(
      Option.match({
        onSome: Effect.succeed,
        onNone: () =>
          Effect.sync(() => process.kill()).pipe(
            Effect.andThen(Effect.fail(new ExecFailed({ code: "timeout", message: `timed out after ${limit}ms` }))),
          ),
      }),
    ),
  );

  return yield* timed.pipe(
    Effect.flatMap((done) => ok({ exitCode: done.exitCode, output: new TextDecoder().decode(done.stdout) })),
  );
});

/** One file operation: `ficus-scorer fs` answers in pi's `Result` already. */
const fileOp = Effect.fn("Workspace.fs")(function* (machine: Machine, op: string, body: FsRequest) {
  const ran = yield* exec(machine, [SCORER, "fs", op], { stdin: JSON.stringify(body) });

  if (ran.exitCode !== 0) {
    return yield* refused("unknown", `ficus-scorer fs ${op} exited ${ran.exitCode}: ${ran.stderr.trim()}`);
  }

  return HttpServerResponse.text(ran.stdout, { headers: { "content-type": "application/json" } });
});

export class Worktree extends Cloudflare.DurableObject<Worktree>()(
  "Worktree",
  Effect.gen(function* () {
    // Attached, not started: `/prepare`, or the next call after a reap, starts it.
    yield* Cloudflare.Containers.bind(WorktreeContainer);

    const state = yield* Cloudflare.DurableObjectState;

    /** The container, booted and cloned again if the platform reaped it. */
    const live = Effect.gen(function* () {
      const machine = yield* machineOf(state.raw);

      if (!machine.container.running) {
        const stored = yield* state.storage.get(PREPARATION_KEY);

        const preparation = yield* Schema.decodeUnknownEffect(Preparation)(stored).pipe(
          Effect.mapError(() => failure(409, "this workspace was never prepared")),
        );

        yield* prepare(machine, preparation);
      }

      return machine;
    });

    // oxlint-disable-next-line effecttsgo/return-effect-in-gen -- alchemy's Durable Object shape: the outer Effect binds, the returned one builds each instance
    return Effect.gen(function* () {
      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { pathname } = new URL(request.url, "http://workspace");

          if (request.method !== "POST") {
            return HttpServerResponse.text("not found", { status: 404 });
          }

          const handled = Effect.gen(function* () {
            if (pathname === "/prepare") {
              const preparation = yield* bodyAs(request, Preparation, "a preparation");

              yield* state.storage.put(PREPARATION_KEY, preparation);

              const machine = yield* machineOf(state.raw);

              return yield* HttpServerResponse.json(yield* prepare(machine, preparation));
            }

            if (pathname === "/exec") {
              const command = yield* bodyAs(request, ExecRequest, "an exec request");

              return yield* runCommand(yield* live, command).pipe(
                Effect.catchTag("Workspace.ExecFailed", (error) => refused(error.code, error.message)),
              );
            }

            if (pathname.startsWith("/fs/")) {
              const fileRequest = yield* bodyAs(request, FsRequest, "a file request");

              return yield* fileOp(yield* live, pathname.slice("/fs/".length), fileRequest);
            }

            return HttpServerResponse.text("not found", { status: 404 });
          });

          return yield* answered(handled);
        }),
      };
    });
  }),
) {}
