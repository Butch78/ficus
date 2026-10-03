/**
 * The `ficus-sandbox` Worker, Effect-native: hosts `Scorer` (scores an
 * attempt; also rebases one) and `Worktree` (an agent's container), each a Durable Object
 * driving its own container. No public routes: the tree and the agents
 * reach them through Durable Object bindings.
 *
 * Its default export is Egress. A container's HTTPS goes nowhere unless its
 * Durable Object routes a host here, through `ctx.exports.default({ props })`
 * (machine.ts `route`); the props say what that host may be used for. A
 * call without them (anyone else's) is refused. An Effect-native Worker
 * exports only alchemy's generated entrypoints, so Egress cannot be a named
 * WorkerEntrypoint of its own.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { COMPATIBILITY, OBSERVABILITY } from "../stack.ts";
import { egress, EgressProps, refuse } from "./egress.ts";
import { Scorer } from "./sandbox.ts";
import { Worktree } from "./workspace.ts";

const propsOf = Schema.decodeUnknownOption(EgressProps);

export default class SandboxWorker extends Cloudflare.Worker<SandboxWorker>()(
  "Sandbox",
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;

    return {
      name: `ficus-sandbox-${stage}`,
      main: import.meta.url,
      compatibility: COMPATIBILITY,
      observability: OBSERVABILITY,
      workersDev: false,
    };
  }),
  Effect.gen(function* () {
    yield* Scorer;
    yield* Worktree;

    return {
      fetch: Effect.gen(function* () {
        const request = yield* Cloudflare.Request;
        const context = yield* Cloudflare.WorkerExecutionContext;
        const props = propsOf(context.raw.props);

        if (Option.isNone(props)) {
          return HttpServerResponse.fromWeb(refuse("only a sandbox's own containers go out this way"));
        }

        const response = yield* Effect.tryPromise({
          try: () => egress(props.value, request),
          catch: (cause) => new Response(`ficus sandbox egress: ${String(cause)}\n`, { status: 502 }),
        }).pipe(Effect.catch(Effect.succeed));

        return HttpServerResponse.fromWeb(response);
      }),
    };
  }),
) {}
