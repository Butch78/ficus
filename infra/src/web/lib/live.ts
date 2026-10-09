/**
 * The live parts of pages, as TanStack Query reads them: what `/api/live`
 * answers (a task's race with its agents, an agent, an attempt), the keys
 * they are cached under, and when each is still moving and worth asking for
 * again. Pages render the first answer on the server; the browser keeps it
 * fresh, only while it moves.
 */
import * as Schema from "effect/Schema";
import { AgentStatus, AttemptDetail, TaskRace } from "./answers.ts";

/** A task's race and what each agent working in it reports (`null` where that cannot be read). */
export const LiveRace = Schema.Struct({
  race: TaskRace,
  agents: Schema.Record(Schema.String, Schema.NullOr(AgentStatus)),
});

export type LiveRace = typeof LiveRace.Type;

export type LiveKind = "race" | "agent" | "attempt";

/** `/api/live?kind=&org=&tree=&id=`: `id` is the task for a race, the attempt otherwise. */
export const LiveAsk = Schema.Struct({
  kind: Schema.Literals(["race", "agent", "attempt"]),
  org: Schema.NonEmptyString,
  tree: Schema.NonEmptyString,
  id: Schema.NumberFromString,
});

export type LiveAsk = typeof LiveAsk.Type;

/** One cache entry per thing: the tree page, the task page and the attempt page share a race's. */
export const liveKey = ({ kind, org, tree, id }: LiveAsk) => [kind, org, tree, id] as const;

export const liveUrl = ({ kind, org, tree, id }: LiveAsk) => `/api/live?${new URLSearchParams({ kind, org, tree, id: String(id) }).toString()}`;

/** A race with its agents, as `/api/live` sends it. */
export const toLive = (race: TaskRace, agents: ReadonlyMap<number, AgentStatus | undefined>): LiveRace => ({
  race,
  agents: Object.fromEntries([...agents].map(([attempt, status]) => [String(attempt), status ?? null])),
});

/** The agents of a live race, by attempt, as lib/growing.ts takes them. */
export const agentsOf = (live: LiveRace): ReadonlyMap<number, AgentStatus | undefined> =>
  new Map(Object.entries(live.agents).map(([attempt, status]) => [Number(attempt), status ?? undefined]));

export const raceMoving = (live: LiveRace) => live.race.attempts.some(({ standing }) => standing === "Working" || standing === "Checking");

export const agentMoving = (agent: AgentStatus) => agent.state === "working";

export const attemptMoving = (detail: typeof AttemptDetail.Type) => {
  const { state } = detail.attempt;

  return state === "Working" || "Checking" in state;
};
