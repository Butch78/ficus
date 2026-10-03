/**
 * `Worktree`: one Durable Object per agent, driving the container the agent
 * works in, with the runtime's native API (machine.ts). `AgentActor`'s
 * `ContainerEnv` (src/agents/sandbox-env.ts) is its one caller.
 *
 *   POST /workspace {remote, token, checkout, author, snapshot?}
 *                     boot (from the base's warmed snapshot when given); for
 *                     the agent's whole run it may reach its attempt's repo
 *                     (token added by Egress, never in the container), the
 *                     nix/devenv caches and the hosts its root's `[fetch]`
 *                     names, nothing else; check the attempt out
 *   POST /fs/<op>, POST /exec
 *                     pi's file and shell operations, run as
 *                     `ficus-scorer fs <op>` / `exec` with the request on
 *                     stdin; the answer is pi's Result, as JSON
 *   DELETE /workspace the agent is done: destroy the container and forget
 *                     the workspace
 *
 * Egress routes belong to this Durable Object's instance, not to the
 * container: an agent's run outlives instances, so every new instance opens
 * the workspace again before its first operation. A container the platform
 * reaped comes back empty and is checked out again; what the agent had not
 * pushed is gone, which its rules (commit, push, then submit) account for.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { WorktreeContainer } from "./containers.ts";
import { boot, destroy, exec, failure, machineOf, type Machine, NIX_HOSTS, route, SCORER, trustEgress } from "./machine.ts";
import { repoOf } from "./repo.ts";
import { answered, bodyAs } from "./sandbox.ts";

/**
 * What an agent's workspace starts from: its attempt's remote and write
 * token, where to check it out, who commits there, and the base's snapshot.
 */
const Workspace = Schema.Struct({
  remote: Schema.String,
  token: Schema.String,
  checkout: Schema.String.check(Schema.isPattern(/^\/work\/[A-Za-z0-9._-]+$/)),
  author: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,64}$/)),
  snapshot: Schema.optional(Schema.String),
});

type Workspace = typeof Workspace.Type;

/** Where a workspace keeps what it was opened with, to open it again. */
const WORKSPACE_KEY = "workspace";

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

export class Worktree extends Cloudflare.DurableObject<Worktree>()(
  "Worktree",
  Effect.gen(function* () {
    // Attached, not started: `/workspace`, or the first operation of a new instance, starts it.
    yield* Cloudflare.Containers.bind(WorktreeContainer);

    const state = yield* Cloudflare.DurableObjectState;

    /** The root's fetch hosts for this workspace: kept from its first open, or read now. */
    const fetchHosts = Effect.fn("Workspace.fetchHosts")(function* (machine: Machine, checkout: string) {
      const stored = yield* state.storage.get(WORKSPACE_HOSTS_KEY);

      if (stored !== undefined) {
        return yield* Schema.decodeUnknownEffect(Hosts)(stored).pipe(Effect.mapError(() => failure(500, "the kept fetch hosts are unreadable")));
      }

      const read = yield* exec(machine, [SCORER, "hosts", checkout]);

      if (read.exitCode !== 0) {
        return yield* failure(500, `reading the root's fetch hosts: ${read.stderr.trim()}`);
      }

      const hosts = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Hosts))(read.stdout.trim()).pipe(
        Effect.mapError(() => failure(500, `ficus-scorer hosts printed ${read.stdout.slice(0, 200)}`)),
      );

      yield* state.storage.put(WORKSPACE_HOSTS_KEY, hosts);

      return hosts;
    });

    /**
     * Start the container if it is not running, route its egress, trust the
     * egress CA, check the attempt out if the container does not have it,
     * and warm the root's devenv shell in the background.
     */
    const open = Effect.fn("Workspace.open")(function* (machine: Machine, { remote, token, checkout, author, snapshot }: Workspace) {
      const repo = repoOf(remote);

      yield* boot(machine, snapshot);
      yield* Effect.tryPromise({
        try: () => machine.container.setInactivityTimeout(WORKSPACE_IDLE_MS),
        catch: (cause) => failure(503, `setting the idle timeout: ${String(cause)}`),
      });
      yield* route(machine, repo.host, { mode: "artifacts", repos: [{ repoPath: repo.repoPath, token }] });

      for (const host of NIX_HOSTS) {
        yield* route(machine, host, { mode: "pass" });
      }

      yield* trustEgress(machine);

      // The checkout, as last pushed, if this container does not have it: a
      // container that was stopped comes back empty. The token stays with
      // Egress; git here never sees it.
      const cloned = yield* exec(machine, [
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

      for (const host of yield* fetchHosts(machine, checkout)) {
        yield* route(machine, host, { mode: "pass" });
      }

      // Warm the root's devenv shell in the background: built cold it takes
      // minutes, and an agent's first `devenv shell` then waits for this one
      // rather than starting its own. Once per container.
      yield* exec(machine, [
        "/bin/sh",
        "-c",
        `cd '${checkout}' && [ -f devenv.nix ] && [ ! -e ${DEVENV_WARM_LOG} ] && (nohup devenv shell -- true > ${DEVENV_WARM_LOG} 2>&1 &) ; true`,
      ]);
    });

    // oxlint-disable-next-line effecttsgo/return-effect-in-gen -- alchemy's Durable Object shape: the outer Effect binds, the returned one builds each instance
    return Effect.gen(function* () {
      /** Whether this instance has routed the workspace's egress. */
      let opened = false;

      /** The container, opened again first if this instance has not opened it. */
      const live = Effect.gen(function* () {
        const machine = yield* machineOf(state.raw);

        if (!opened) {
          const stored = yield* state.storage.get(WORKSPACE_KEY);
          const workspace = yield* Schema.decodeUnknownEffect(Workspace)(stored).pipe(Effect.mapError(() => failure(409, "no workspace here: POST /workspace first")));

          yield* open(machine, workspace);
          opened = true;
        }

        return machine;
      });

      /** One of pi's operations, its answer (pi's Result) passed through. */
      const operate = Effect.fn("Workspace.operate")(function* (argv: ReadonlyArray<string>, input: string) {
        const ran = yield* exec(yield* live, argv, { stdin: input });

        if (ran.exitCode !== 0) {
          const why = `${argv.slice(1).join(" ")} exited ${ran.exitCode}: ${ran.stderr.trim() || ran.stdout.trim()}`;

          console.error(`workspace: ${why}`);

          return yield* failure(500, why);
        }

        return HttpServerResponse.text(ran.stdout, { headers: { "content-type": "application/json" } });
      });

      return {
        fetch: Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          const { pathname } = new URL(request.url, "http://workspace");

          const handled = Effect.gen(function* () {
            if (pathname === "/workspace" && request.method === "POST") {
              const workspace = yield* bodyAs(request, Workspace, "a workspace request");

              yield* state.storage.put(WORKSPACE_KEY, workspace);
              yield* open(yield* machineOf(state.raw), workspace);
              opened = true;

              return yield* HttpServerResponse.json({ ready: true });
            }

            if (pathname === "/workspace" && request.method === "DELETE") {
              opened = false;
              yield* state.storage.delete([WORKSPACE_KEY, WORKSPACE_HOSTS_KEY]);

              const machine = yield* machineOf(state.raw);

              if (machine.container.running) {
                yield* destroy(machine);
              }

              return yield* HttpServerResponse.json({ closed: true });
            }

            const op = /^\/(?:fs\/([a-z]+)|exec)$/.exec(pathname);

            if (request.method !== "POST" || op === null) {
              return HttpServerResponse.text("not found", { status: 404 });
            }

            const input = yield* request.text.pipe(Effect.mapError(() => failure(400, "the request body could not be read")));

            return yield* operate(op[1] === undefined ? [SCORER, "exec"] : [SCORER, "fs", op[1]], input);
          });

          return yield* answered(handled);
        }),
      };
    });
  }),
) {}
