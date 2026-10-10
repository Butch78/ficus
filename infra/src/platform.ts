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

/** Where a stage is reached besides workers.dev: the web UI and the Api, in a zone of the account. */
export interface StageDomains {
  /** The zone the hostnames live in; its deploy token may manage that zone's Worker domains (src/permissions.ts). */
  readonly zoneId: string;
  readonly web: string;
  readonly api: string;
}

/** Custom domains by stage; a stage without one is on workers.dev alone. */
export const DOMAINS = new Map<string, StageDomains>([
  ["prod", { zoneId: "ea300a13840c91c573093da75c0965f3", web: "ficus.fruit.cards", api: "api.ficus.fruit.cards" }],
]);

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
