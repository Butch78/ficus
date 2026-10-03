/**
 * Attempts worked by agents: `AgentActor`s in the agents Worker
 * (infra/src/agents), one per attempt, each in its own sandbox.
 *
 * The tree is the only side that talks: it starts the attempts, hands each
 * agent its assignment, then asks how it is doing on every alarm until it
 * has submitted (the tree freezes the attempt and scores it), stopped or
 * failed (the tree abandons it, keeping the agent's last words in the
 * history). Once an attempt stops working, its agent is stopped, which
 * frees its container.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as T from "../core/tree.ts";
import * as Result from "effect/Result";
import { AttemptId, type TaskId } from "../core/values.ts";
import { json, refuse, type Refused } from "./http.ts";
import type { Started } from "./tree-object.ts";

/** The most agents one request starts. */
const MAX_AGENTS = 5;

/** How often the tree asks its agents how they are doing. */
const POLL_MS = 15_000;

/** The attempts the tree is still tending: dispatched, or waiting to be. */
const TENDING_KEY = "agents";

/** The model an agent runs when the request names none. */
const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.7-code";

/** The model an attempt's agent runs, for every attempt an agent ever worked. */
const modelKey = (attempt: AttemptId) => `agent:${attempt}`;

/** An attempt's assignment until it is handed over: it carries the write token. */
const assignmentKey = (attempt: AttemptId) => `assignment:${attempt}`;

const Tended = Schema.Struct({ attempt: AttemptId, repo: Schema.String, dispatched: Schema.Boolean });

type Tended = typeof Tended.Type;

/** `AgentActor`'s `GET /status`, the fields the tree acts on. */
const Status = Schema.Struct({
  state: Schema.String,
  reason: Schema.optional(Schema.String),
  lastWords: Schema.optional(Schema.String),
});

const AgentsBody = Schema.Struct({ agents: Schema.Int, model: Schema.optional(Schema.String) });

/** What the tree lends this module. */
export interface Host {
  readonly storage: DurableObjectStorage;
  readonly agents: DurableObjectNamespace;
  readonly load: Effect.Effect<T.Tree | undefined>;
  readonly forkAttempt: (tree: T.Tree, attempt: AttemptId) => Effect.Effect<Started, Refused>;
  readonly submit: (attempt: AttemptId) => Effect.Effect<Response, Refused>;
  readonly abandon: (attempt: AttemptId, note: string) => Effect.Effect<Response, Refused>;
}

const stored = <A>(work: () => Promise<A>) => Effect.promise(work);

/** The model the agent working `attempt` runs; `undefined` for an attempt no agent worked. */
export const model = (storage: DurableObjectStorage, attempt: AttemptId) => stored(() => storage.get<string>(modelKey(attempt)));

const tending = Effect.fn("Agents.tending")(function* (storage: DurableObjectStorage) {
  const list = yield* stored(() => storage.get(TENDING_KEY));

  return Option.getOrElse(Schema.decodeUnknownOption(Schema.Array(Tended))(list), () => []);
});

const agent = (host: Host, repo: string) => host.agents.get(host.agents.idFromName(repo));

/** An agent's name for its attempt: the model's last part, numbered. */
const agentName = (chosen: string | undefined, n: number) => `${(chosen ?? DEFAULT_MODEL).split("/").at(-1) ?? "agent"}-${n}`;

/** Keep a freshly forked attempt's assignment until the next alarm hands it to an agent. */
export const tendStarted = Effect.fn("Agents.tendStarted")(function* (storage: DurableObjectStorage, tree: string, chosen: string | undefined, started: Started) {
  yield* stored(() => storage.put(modelKey(started.attempt), chosen ?? DEFAULT_MODEL));
  // JSON leaves out an absent model: the agent then runs its default.
  yield* stored(() => storage.put(assignmentKey(started.attempt), JSON.stringify({ tree, model: chosen, ...started })));

  const list = yield* tending(storage);

  yield* stored(() => storage.put(TENDING_KEY, [...list, { attempt: started.attempt, repo: started.repo, dispatched: false }]));
});

/** `POST /trees/<t>/tasks/<id>/agents {agents, model}`: start that many attempts, each worked by its own agent. */
export const start = Effect.fn("Agents.start")(function* (host: Host, tree: string, task: TaskId, request: Request) {
  const body = yield* Effect.tryPromise({ try: () => request.json(), catch: () => refuse(400, "the body is not JSON") }).pipe(
    Effect.flatMap((raw) => Schema.decodeUnknownEffect(AgentsBody)(raw).pipe(Effect.mapError((issue) => refuse(400, `not the expected body: ${issue.message}`)))),
  );

  if (body.agents < 1 || body.agents > MAX_AGENTS) {
    return yield* refuse(400, `start 1 to ${MAX_AGENTS} agents`);
  }

  const loaded = yield* host.load;

  if (loaded === undefined) {
    return yield* refuse(404, "no such tree");
  }

  let changed = loaded;
  const attempts: Array<AttemptId> = [];

  for (let n = 1; n <= body.agents; n += 1) {
    const started = T.start(changed, task, agentName(body.model, n));

    if (Result.isFailure(started)) {
      return yield* refuse(started.failure.kind === "UnknownTask" ? 404 : 409, started.failure.message);
    }

    changed = started.success.tree;
    attempts.push(started.success.attempt);
  }

  yield* stored(() => host.storage.put("tree", JSON.stringify(changed)));

  for (const attempt of attempts) {
    yield* tendStarted(host.storage, tree, body.model, yield* host.forkAttempt(changed, attempt));
  }

  yield* stored(() => host.storage.setAlarm(Date.now()));

  return json({ attempts }, 202);
});

/** `GET /trees/<t>/attempts/<id>/agent`: the agent's status, as it reports it. */
export const status = Effect.fn("Agents.status")(function* (host: Host, attempt: AttemptId) {
  const tree = yield* host.load;
  const entry = tree === undefined ? undefined : T.attempt(tree, attempt);
  const chosen = yield* model(host.storage, attempt);

  if (entry === undefined || chosen === undefined) {
    return yield* refuse(404, "no agent worked this attempt");
  }

  // Until the alarm hands the assignment over, the agent would truthfully say `unassigned`: it is on its way.
  if ((yield* tending(host.storage)).some((tended) => tended.attempt === attempt && !tended.dispatched)) {
    return json({ model: chosen, state: "working", calls: [] });
  }

  const answer = yield* Effect.tryPromise({
    try: async () => (await agent(host, entry.repo).fetch("http://agent/status")).json(),
    catch: (cause) => refuse(502, `the agent did not answer: ${String(cause)}`),
  });

  return json({ model: chosen, ...Option.getOrElse(Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Json))(answer), () => ({})) });
});

/** How handing over an assignment went. */
type Dispatched = { readonly kind: "started" } | { readonly kind: "refused"; readonly reason: string } | { readonly kind: "unreachable"; readonly reason: string };

/** Hand an attempt's assignment to its agent. */
const dispatch = Effect.fn("Agents.dispatch")(function* (host: Host, tended: Tended) {
  const key = assignmentKey(tended.attempt);
  const assignment = yield* stored(() => host.storage.get<string>(key));

  // Gone once handed out: its agent has it, or says `unassigned` when asked.
  if (assignment === undefined) {
    return { kind: "started" } satisfies Dispatched;
  }

  const answer = yield* Effect.tryPromise({
    try: () => agent(host, tended.repo).fetch(new Request("http://agent/grow", { method: "POST", headers: { "content-type": "application/json" }, body: assignment })),
    catch: (cause) => String(cause),
  }).pipe(Effect.result);

  // Not reached at all: the assignment stays, and the next alarm tries again.
  if (Result.isFailure(answer)) {
    return { kind: "unreachable", reason: answer.failure } satisfies Dispatched;
  }

  // The token goes no further than the agent: forget it here.
  yield* stored(() => host.storage.delete(key));

  if (answer.success.status < 300) {
    return { kind: "started" } satisfies Dispatched;
  }

  return { kind: "refused", reason: yield* Effect.promise(() => answer.success.text()) } satisfies Dispatched;
});

/** The attempt is done: end its agent's run and free its container. Best effort: one it fails to close idles out. */
const stop = Effect.fn("Agents.stop")(function* (host: Host, tended: Tended) {
  yield* Effect.tryPromise(() => agent(host, tended.repo).fetch("http://agent/stop", { method: "POST" })).pipe(
    Effect.catch((error) => Effect.logError(`stopping the agent of attempt ${tended.attempt}: ${String(error)}`)),
  );
});

const giveUp = Effect.fn("Agents.giveUp")(function* (host: Host, attempt: AttemptId, note: string) {
  yield* host.abandon(attempt, note).pipe(Effect.catchTag("Tree.Refused", (refused) => Effect.logError(`abandoning attempt ${attempt}: ${refused.message}`)));
});

/** Ask a dispatched agent how it is doing; `undefined` if it did not answer. */
const askStatus = (host: Host, tended: Tended) =>
  Effect.tryPromise(async () => (await agent(host, tended.repo).fetch("http://agent/status")).json()).pipe(
    Effect.map((raw) => Option.getOrUndefined(Schema.decodeUnknownOption(Status)(raw))),
    Effect.catch((error) => Effect.logError(`asking the agent of attempt ${tended.attempt}: ${String(error)}`).pipe(Effect.as(undefined))),
  );

/** On every alarm: hand waiting attempts to their agents, ask the others how they are doing, and act on what they say. */
export const tend = Effect.fn("Agents.tend")(function* (host: Host) {
  const list = [...(yield* tending(host.storage))];

  if (list.length === 0) {
    return;
  }

  const tree = yield* host.load;

  if (tree === undefined) {
    return;
  }

  const still: Array<Tended> = [];

  for (const [at, tended] of list.entries()) {
    const id = tended.attempt;
    const attempt = T.attempt(tree, id);

    // Abandoned, retried or submitted by someone else meanwhile: done.
    if (attempt === undefined || attempt.state !== "Working") {
      if (tended.dispatched) {
        yield* stop(host, tended);
      }

      continue;
    }

    if (!tended.dispatched) {
      const dispatched = yield* dispatch(host, tended);

      if (dispatched.kind === "started") {
        // Recorded at once, not with the rest at the end: an alarm cut short and retried must not hand it out twice.
        list[at] = { ...tended, dispatched: true };
        yield* stored(() => host.storage.put(TENDING_KEY, list));
        still.push({ ...tended, dispatched: true });
      } else if (dispatched.kind === "unreachable") {
        yield* Effect.logError(`handing attempt ${id} to its agent: ${dispatched.reason}`);
        still.push(tended);
      } else {
        yield* giveUp(host, id, `the agent could not start: ${dispatched.reason}`);
      }

      continue;
    }

    const reported = yield* askStatus(host, tended);

    if (reported === undefined) {
      still.push(tended);

      continue;
    }

    switch (reported.state) {
      case "submitted": {
        yield* host.submit(id).pipe(Effect.catchTag("Tree.Refused", (refused) => giveUp(host, id, `the agent submitted, but: ${refused.message}`)));
        yield* stop(host, tended);
        break;
      }

      case "stopped": {
        yield* giveUp(host, id, `the agent stopped without submitting; its last words: ${reported.lastWords ?? "nothing"}`);
        yield* stop(host, tended);
        break;
      }

      case "unassigned": {
        yield* giveUp(host, id, "the agent never got its assignment");
        yield* stop(host, tended);
        break;
      }

      case "failed": {
        yield* giveUp(host, id, `the agent failed: ${reported.reason ?? "unknown"}`);
        yield* stop(host, tended);
        break;
      }

      default:
        still.push(tended);
    }
  }

  yield* stored(() => host.storage.put(TENDING_KEY, still));

  if (still.length > 0) {
    // Within `POLL_MS`, without postponing an earlier alarm.
    const due = Date.now() + POLL_MS;
    const set = yield* stored(() => host.storage.getAlarm());

    if (set === null || set > due) {
      yield* stored(() => host.storage.setAlarm(due));
    }
  }
});
