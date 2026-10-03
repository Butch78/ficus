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
