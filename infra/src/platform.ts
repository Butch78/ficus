import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

/**
 * Settings every Ficus Worker shares, across the stacks (alchemy.run.ts,
 * web.run.ts).
 */

// Stated here rather than inherited from alchemy's default, which moves
// between alchemy releases: the runtime's behaviour is ours to pin.
export const COMPATIBILITY = { date: "2026-09-10" } as const;

// Logs and traces for every Worker (Durable Object calls, service bindings,
// subrequests): queryable through the Workers Observability API, which is
// how a failed run is diagnosed without re-running it.
export const OBSERVABILITY = {
  enabled: true,
  logs: { enabled: true, invocationLogs: true },
  traces: { enabled: true },
} as const;

/**
 * The stage's Artifacts namespace, where every tree's repos live. A
 * namespace is implicit (Artifacts creates it with its first repo), so this
 * is only its description: any Worker that binds it declares the same one.
 */
export const artifactsNamespace = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  return yield* Cloudflare.Artifacts.Namespace("Artifacts", { namespace: `ficus-${stage}` });
});
