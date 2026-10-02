/**
 * Starting an attempt's agent. Starting or retrying an attempt answers with
 * what an agent needs (the tree's `Started`); unless the request said
 * `start_agent: false`, the Api hands that to a fresh `AgentActor` in the
 * agents Worker, one per attempt. The tree never calls the agents (they call
 * it, to submit), so this keeps the deploy order one way: tree, agents, Api.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** What a caller may say about the attempt's agent, beside `agent` itself. */
export const AgentOptions = Schema.Struct({
  start_agent: Schema.optional(Schema.Boolean),
  model: Schema.optional(Schema.String),
  scout_model: Schema.optional(Schema.String),
});

export interface AgentOptions extends Schema.Schema.Type<typeof AgentOptions> {}

const TaskCheck = Schema.Struct({
  name: Schema.String,
  run: Schema.String,
  timeout_secs: Schema.optional(Schema.Number),
});

/** crates/ficus-worker `Started`. */
export const Started = Schema.Struct({
  attempt: Schema.Number,
  task: Schema.Number,
  intent: Schema.String,
  checks: Schema.Array(TaskCheck),
  agent: Schema.String,
  remote: Schema.String,
  token: Schema.String,
  base_commit: Schema.String,
  history: Schema.Array(Schema.Json),
  snapshot: Schema.optional(Schema.NullOr(Schema.String)),
});

export interface Started extends Schema.Schema.Type<typeof Started> {}

/** Routes whose answer is a `Started`: starting an attempt, or retrying one. */
export const startsAnAttempt = (method: string, rest: string) =>
  method === "POST" && (/^\/tasks\/\d+\/attempts$/.test(rest) || /^\/attempts\/\d+\/retry$/.test(rest));

/** The request's options; a body that is empty or not an object asks for nothing. */
export const optionsOf = (body: string): AgentOptions => {
  if (body.trim() === "") {
    return {};
  }

  return Option.getOrElse(Schema.decodeUnknownOption(Schema.fromJsonString(AgentOptions))(body), (): AgentOptions => ({}));
};

/** What the Api sends `AgentActor`'s `/grow`: src/agents/actor.ts `Assignment`. */
export interface Assignment {
  readonly tenant: string;
  readonly tree: string;
  readonly attempt: number;
  readonly task: number;
  readonly intent: string;
  readonly checks: Started["checks"];
  readonly agent: string;
  readonly remote: string;
  readonly token: string;
  readonly base_commit: string;
  readonly history: Started["history"];
  readonly snapshot: string | null;
  model?: string;
  scout_model?: string;
}

export const assignmentOf = (tenant: string, tree: string, started: Started, options: AgentOptions): Assignment => {
  const assignment: Assignment = {
    tenant,
    tree,
    attempt: started.attempt,
    task: started.task,
    intent: started.intent,
    checks: started.checks,
    agent: started.agent,
    remote: started.remote,
    token: started.token,
    base_commit: started.base_commit,
    history: started.history,
    snapshot: started.snapshot ?? null,
  };

  if (options.model !== undefined) {
    assignment.model = options.model;
  }

  if (options.scout_model !== undefined) {
    assignment.scout_model = options.scout_model;
  }

  return assignment;
};

/** The agent's Durable Object name: one per attempt of one tree. */
export const agentName = (tenant: string, tree: string, attempt: number) => `${tenant}-${tree}-a${attempt}`;

export class AgentStartFailed extends Schema.TaggedError<AgentStartFailed>()("Api.AgentStartFailed", {
  message: Schema.String,
}) {}

/** Start the attempt's agent; nothing, or why it would not start. */
export const startAgent = Effect.fn("Api.startAgent")(function* (
  agents: DurableObjectNamespace,
  tenant: string,
  tree: string,
  started: Started,
  options: AgentOptions,
) {
  const stub = agents.getByName(agentName(tenant, tree, started.attempt));

  const response = yield* Effect.tryPromise({
    try: () =>
      stub.fetch("http://agent/grow", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(assignmentOf(tenant, tree, started, options)),
      }),
    catch: (cause) => new AgentStartFailed({ message: `the agents are unreachable: ${String(cause)}` }),
  });

  if (!response.ok) {
    const text = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => new AgentStartFailed({ message: `the agent refused (${response.status})` }),
    });

    return yield* new AgentStartFailed({ message: `the agent refused (${response.status}): ${text}` });
  }
});
