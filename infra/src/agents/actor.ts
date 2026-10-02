/**
 * `AgentActor`: one Durable Object per attempt, running one pi agent that grows
 * that attempt. The tree is the only thing that talks to it.
 *
 * - `POST /grow` (from `TreeObject`): the assignment. The actor opens a
 *   workspace for the attempt, clones it there, then hands pi the task's
 *   intent and the history of earlier attempts. pi's run is durable from
 *   there: every model turn and tool call is checkpointed in this object's
 *   SQLite, so an eviction resumes the run rather than losing it.
 * - `GET /status` (from `TreeObject`, which polls it): `working` while the run
 *   goes on, `submitted` once the agent called `submit`, `stopped` if the run
 *   ended without it, `failed` if it could not start; with the phase, the
 *   agent's recent tool calls and last words (activity.ts), for the UI.
 *
 * The agent works in a sandbox container (src/sandbox: the scorer's image,
 * nix, devenv, git) through pi's read/write/edit/bash tools, so it can run the
 * root's own checks before it submits. The container reaches only its
 * attempt's repo, with the token added by the sandbox's egress (never in the
 * container), and the nix caches. Nothing here calls the tree back: the tree
 * asks. An attempt grows in two
 * phases, one pi conversation throughout, each phase with its own model, tools
 * and rules (pi's per-conversation agent state):
 *
 * - `scout`: a cheap model reads the code and runs the checks, without edit
 *   tools, and hands over a plan with `plan_change`.
 * - `change`: a second model takes over the same conversation, so it sees
 *   everything the scout read, makes the change, and submits it with
 *   `submit`, which freezes the attempt and queues it for scoring.
 *
 * Clef judges both handovers (`gates.ts`): it can turn back a vague or
 * off-task plan, and a diff that misses the task or weakens a test. With the
 * plan it also routes the change: a mechanical plan stays with the scout's
 * cheap model, anything else goes to the assignment's.
 */
import { DurableObject } from "cloudflare:workers";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  type AgentChange,
  configure,
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  type ToolExecutionApi,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";
import type * as Decision from "effect/ai/Decision";
import * as DecisionModel from "effect/ai/DecisionModel";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { Type } from "typebox";
import { Clef } from "../clef/clef.ts";
import { activity } from "./activity.ts";
import { clip, describe, DIFF, effort, MAX_REJECTIONS, objections, type Objection, PLAN } from "./gates.ts";
import { ContainerEnv, type SandboxStub } from "./sandbox-env.ts";

/** Where the attempt is checked out inside the agent's container. */
const ATTEMPT_DIR = "/work/attempt";

/** The model that makes the change when the assignment names none. */
export const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.7-code";

/** The model that scouts when the assignment names none: fast and cheap, since it only reads. */
export const DEFAULT_SCOUT_MODEL = "@cf/zai-org/glm-5.3-flash";

const CompostEntry = Schema.Struct({
  attempt: Schema.Number,
  agent: Schema.String,
  reason: Schema.Json,
  score: Schema.NullOr(Schema.Json),
});

/** A task's own check: what done means, on top of the root's `ficus.toml`. */
const TaskCheck = Schema.Struct({
  name: Schema.String,
  run: Schema.String,
  timeout_secs: Schema.optional(Schema.Number),
});

/** What `TreeObject` sends when it starts this attempt. */
export const Assignment = Schema.Struct({
  tree: Schema.String,
  attempt: Schema.Number,
  task: Schema.Number,
  intent: Schema.String,
  checks: Schema.optional(Schema.Array(TaskCheck)),
  agent: Schema.String,
  /** Makes the change. */
  model: Schema.optional(Schema.String),
  /** Reads the code and plans the change. */
  scout_model: Schema.optional(Schema.String),
  remote: Schema.String,
  token: Schema.String,
  base_commit: Schema.String,
  history: Schema.Array(CompostEntry),
});

export interface Assignment extends Schema.Schema.Type<typeof Assignment> {}

const ASSIGNMENT_KEY = "assignment";

/** The plan `plan_change` accepted, for the diff gate. */
const PLAN_KEY = "plan";

/** The root's files, as `crates/ficus-core` `LOCKED_PATHS`: restored before scoring, so out of the diff. */
const LOCKED_PATHS = ["ficus.toml", "devenv.nix", "devenv.yaml", "devenv.lock", ".envrc"] as const;

type Gate = "plan" | "submit";

interface Bindings {
  readonly AI: Ai;
  /** `Sandbox` in the sandbox Worker: one container per agent. */
  readonly SANDBOX: DurableObjectNamespace;
}

/** How the agent's run ended, once it has: the tree reads it from `/status`. */
const Outcome = Schema.Union([
  Schema.Struct({ state: Schema.Literal("submitted") }),
  Schema.Struct({ state: Schema.Literal("failed"), reason: Schema.String }),
]);

type Outcome = typeof Outcome.Type;

const OUTCOME_KEY = "outcome";

export class GrowRejected extends Schema.TaggedError<GrowRejected>()("Agent.GrowRejected", {
  status: Schema.Number,
  message: Schema.String,
}) {}

/** A tool ran in an actor that was never assigned a attempt. */
export class NoAssignment extends Schema.TaggedError<NoAssignment>()("Agent.NoAssignment", {
  message: Schema.String,
}) {}

/** Clef objected to a plan or a diff, and the gate has turns left. */
export class Rejected extends Schema.TaggedError<Rejected>()("Agent.Rejected", {
  message: Schema.String,
}) {}

/** This object's storage, or the container, failed a gate. */
export class GateFailed extends Schema.TaggedError<GateFailed>()("Agent.GateFailed", {
  message: Schema.String,
}) {}

/** pi did not take the switch to the change phase. */
export class PlanFailed extends Schema.TaggedError<PlanFailed>()("Agent.PlanFailed", {
  message: Schema.String,
}) {}

/** The submission could not be recorded. */
export class SubmitFailed extends Schema.TaggedError<SubmitFailed>()("Agent.SubmitFailed", {
  message: Schema.String,
}) {}

/** A promise from storage or pi whose rejection the caller should see as `onFail`. */
const attempt = <A, E>(run: () => Promise<A>, onFail: (cause: unknown) => E): Effect.Effect<A, E> =>
  Effect.tryPromise({ try: run, catch: onFail });

/**
 * A gate's answers, or `undefined` when Clef cannot give them. The gates are
 * advice ahead of the root's checks, which still run on every attempt, so a
 * Clef outage lets the agent through rather than stalling it.
 */
const advice = <Input extends Schema.Constraint, Decisions extends Record<string, Decision.Any>>(
  definition: Decision.Definition<Input, Decisions>,
  input: Input["Type"],
) =>
  DecisionModel.decide(definition, { input }).pipe(
    Effect.map(({ answers }): Decision.Answers<Decisions> | undefined => answers),
    Effect.catchTag("AiError", (error) =>
      Effect.logWarning("Clef did not answer; the gate lets this through", error).pipe(Effect.as(undefined)),
    ),
  );

const toolText = (text: string, isError: boolean) => ({ content: [{ type: "text" as const, text }], isError });

/** Objections a gate let through after its last turn-back, for the record. */
const remaining = (doubts: ReadonlyArray<Objection>): string =>
  doubts.length === 0 ? "" : `\nClef's remaining doubts:\n${describe(doubts)}`;

/** The task an agent starts from, the same in both phases. Each phase's rules are its pi instructions. */
export const prompt = (assignment: Assignment): string => {
  const history =
    assignment.history.length === 0
      ? "No earlier attempts at this task."
      : assignment.history
          .map((entry) => `- attempt ${entry.attempt} by ${entry.agent}: ${JSON.stringify(entry.reason)}; score ${JSON.stringify(entry.score)}`)
          .join("\n");

  const taskChecks = assignment.checks ?? [];

  const done =
    taskChecks.length === 0
      ? "The task has no checks of its own: the root's checks decide."
      : [
          "The task is done when each of these passes, run from the repository root (they are not in the repository and you cannot change them):",
          ...taskChecks.map((check) => `- ${check.name}: \`${check.run}\``),
        ].join("\n");

  return [
    `You are ${assignment.agent}, one of several agents working on the same task in parallel. Each of you has your own copy of the repository; the smallest change that passes every check wins.`,
    "",
    `Task: ${assignment.intent}`,
    "",
    done,
    "",
    `Your checkout is ${ATTEMPT_DIR} (git, on main, already configured to push). It starts at commit ${assignment.base_commit}.`,
    "",
    "The repository's `ficus.toml` lists the checks the change must not break; the task's own checks above say when it is done. If the repository has a `devenv.nix`, run checks as `devenv shell -- <command>` (the first run builds the environment and can take a few minutes). The checks cannot be changed: `ficus.toml` and the devenv files are restored from the base before scoring.",
    "",
    "Your environment:",
    "- The network reaches only your attempt's git remote (pushing is already authorised: just `git push origin HEAD:main`) and the nix/devenv binary caches. Everything else is closed, so do not install packages from the internet.",
    "- The first `devenv shell -- <command>` builds the environment from the caches and can take several minutes: give it a long timeout (10 minutes). Later runs are fast.",
    "",
    "Earlier attempts at this task (the history):",
    history,
  ].join("\n");
};

type Phase = "scout" | "change";

/** The tools each phase is offered, by name; pi drops the rest. */
const PHASE_TOOLS: Readonly<Record<Phase, ReadonlySet<string>>> = {
  scout: new Set(["read", "bash", "plan_change"]),
  change: new Set(["read", "write", "edit", "bash", "submit"]),
};

const SCOUT_RULES = [
  "You are scouting. A stronger model takes over this conversation after you to make the change, and sees everything you read and ran.",
  "- Read the code the task touches and `ficus.toml`.",
  "- Run the checks once, to see where they stand before any change.",
  "- Do not change, commit or push anything.",
  "- When you know the smallest change that does the task, call `plan_change` with the files and the exact edits, the checks to run, and anything surprising you found.",
  "- If the task cannot be done, say why instead of planning.",
].join("\n");

const changeRules = (plan: string): string =>
  [
    "The scout has read the code; its plan is below. Follow it unless the code says otherwise.",
    "- Keep the change as small as the task allows. Do not reformat or touch unrelated code.",
    "- Run every check in `ficus.toml` yourself.",
    "- When the checks pass, commit, `git push origin HEAD:main`, then call the `submit` tool. Submitting freezes your attempt; you cannot push after it.",
    "- If you cannot complete the task, say why instead of submitting.",
    "",
    "The scout's plan:",
    plan,
  ].join("\n");

export class AgentActor extends DurableObject<Bindings> {
  readonly #ai = createAI({ binding: this.env.AI });

  /** The attempt's container: one `Sandbox` instance per agent. */
  readonly #sandbox: SandboxStub = this.env.SANDBOX.get(this.env.SANDBOX.idFromName(`agent:${this.ctx.id.name ?? this.ctx.id.toString()}`));

  readonly #workspace = new ContainerEnv(this.#sandbox, `agent:${this.ctx.id.toString()}`, ATTEMPT_DIR);

  readonly #ficus = defineExtension({ name: "ficus", tools: [this.#planTool(), this.#submitTool()] });

  readonly #clef = Clef.layerBinding(this.env.AI);

  readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
      const models = createModels();

      models.setProvider(this.#ai.provider);

      const registry = createRegistry();

      registry.install(CodingTools);
      registry.install(this.#ficus);

      return Harness.open(
        storage,
        {
          models,
          registry,
          env: () => this.#workspace,
          settings: { retry: { enabled: true, maxRetries: 2, baseDelayMs: 500 } },
        },
        context,
      );
    },
    defaults: {
      model: { provider: CLOUDFLARE_PROVIDER_ID, id: DEFAULT_MODEL },
      thinkingLevel: "low",
    },
  });

  readonly lifecycle = Lifecycle.install(this).use(this.harness);

  /** Lifecycle hands every non-upgrade request here. */
  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/grow") {
      return Effect.runPromise(
        this.#grow(request).pipe(
          Effect.map(() => Response.json({ state: "working" }, { status: 202 })),
          Effect.catchTag("Agent.GrowRejected", (error) =>
            Effect.promise(() => this.ctx.storage.put(OUTCOME_KEY, { state: "failed", reason: error.message } satisfies Outcome)).pipe(
              Effect.as(Response.json({ error: error.message }, { status: error.status })),
            ),
          ),
        ),
      );
    }

    if (request.method === "GET" && url.pathname === "/status") {
      return Response.json(await this.#status());
    }

    return new Response("not found", { status: 404 });
  }

  readonly #grow = Effect.fn("Agent.grow")(function* (this: AgentActor, request: Request) {
    const body = yield* Effect.tryPromise({
      try: () => request.json(),
      catch: () => new GrowRejected({ status: 400, message: "the assignment is not JSON" }),
    });

    const assignment = yield* Schema.decodeUnknownEffect(Assignment)(body).pipe(
      Effect.mapError((error) => new GrowRejected({ status: 400, message: String(error) })),
    );

    const failed = (step: string) => (cause: unknown) =>
      new GrowRejected({ status: 500, message: `${step}: ${String(cause)}` });

    const existing = yield* attempt(() => this.ctx.storage.get(ASSIGNMENT_KEY), failed("reading the assignment"));

    // TreeObject retries a grow it saw fail; once the run started, a retry is a no-op.
    if (existing !== undefined) {
      return;
    }

    yield* this.#prepare(assignment);
    yield* attempt(() => this.ctx.storage.put(ASSIGNMENT_KEY, assignment), failed("storing the assignment"));

    const pi = yield* attempt(() => this.harness.pi(), failed("opening pi"));
    const root = yield* attempt(() => pi.root(BACKGROUND), failed("opening the conversation"));

    yield* attempt(() => root.configure(this.#phase("scout", assignment), BACKGROUND), failed("starting the scout"));

    const session = this.harness.session();

    yield* attempt(
      () => session.submit([{ type: "text", text: prompt(assignment) }], { operationId: `grow-${assignment.attempt}` }),
      failed("starting the run"),
    );
  });

  /**
   * Open the attempt's workspace and clone the attempt into it, as the
   * identity it commits as. The token goes to the sandbox, whose egress adds
   * it to requests for this attempt's repo: git in the container clones and
   * pushes without ever holding it.
   */
  readonly #prepare = Effect.fn("Agent.prepare")(function* (this: AgentActor, assignment: Assignment) {
    const opened = yield* attempt(
      () =>
        this.#sandbox.fetch(
          new Request("http://sandbox/workspace", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ remote: assignment.remote, token: assignment.token }),
          }),
        ),
      (cause) => new GrowRejected({ status: 502, message: `opening the workspace: ${String(cause)}` }),
    );

    if (!opened.ok) {
      const why = yield* attempt(
        () => opened.text(),
        () => new GrowRejected({ status: 502, message: `opening the workspace: ${opened.status}` }),
      );

      return yield* new GrowRejected({ status: 502, message: `opening the workspace: ${why}` });
    }

    const script = [
      `rm -rf ${ATTEMPT_DIR} && mkdir -p /work`,
      `git clone --quiet '${assignment.remote}' ${ATTEMPT_DIR}`,
      `cd ${ATTEMPT_DIR}`,
      `git config user.name '${assignment.agent}'`,
      `git config user.email '${assignment.agent}@agents.ficus.dev'`,
    ].join(" && ");

    const ran = yield* attempt(
      () => this.#workspace.exec(script, { cwd: "/", timeout: 300_000 }, BACKGROUND),
      (cause) => new GrowRejected({ status: 502, message: `preparing the attempt: ${String(cause)}` }),
    );

    if (!ran.ok) {
      return yield* new GrowRejected({ status: 502, message: `preparing the attempt: ${ran.error.message}` });
    }

    if (ran.value.exitCode !== 0) {
      return yield* new GrowRejected({ status: 502, message: `preparing the attempt: exit ${ran.value.exitCode}` });
    }
  });

  /**
   * pi's agent state for a phase: its model, its tools, its rules. A `light`
   * change keeps the scout's model.
   */
  #phase(phase: Phase, assignment: Assignment, plan = "", light = false): AgentChange {
    const scout = assignment.scout_model ?? DEFAULT_SCOUT_MODEL;
    const model = phase === "scout" || light ? scout : (assignment.model ?? DEFAULT_MODEL);
    const tools = [...(CodingTools.tools ?? []), ...(this.#ficus.tools ?? [])].filter((tool) => PHASE_TOOLS[phase].has(tool.name));

    return {
      model: { provider: CLOUDFLARE_PROVIDER_ID, modelId: model },
      tools,
      instructions: phase === "scout" ? SCOUT_RULES : changeRules(plan),
    };
  }

  /** The assignment `/grow` stored, for tools that run later. */
  readonly #assignment = Effect.fn("Agent.assignment")(function* (this: AgentActor) {
    const stored = yield* attempt(
      () => this.ctx.storage.get(ASSIGNMENT_KEY),
      (cause) => new NoAssignment({ message: `reading the assignment: ${String(cause)}` }),
    );

    return yield* Schema.decodeUnknownEffect(Assignment)(stored).pipe(
      Effect.mapError(() => new NoAssignment({ message: "this agent has no assignment" })),
    );
  });

  /**
   * Hand the conversation to the change phase. The switch is one pi commit,
   * so the next model request already runs the change model with its tools.
   */
  readonly #plan = Effect.fn("Agent.planChange")(function* (
    this: AgentActor,
    plan: string,
    api: ToolExecutionApi,
    context: Context,
  ) {
    const assignment = yield* this.#assignment();
    const answers = yield* advice(PLAN, { task: assignment.intent, plan });
    const doubts = answers === undefined ? [] : objections(PLAN.decisions, answers);

    if (doubts.length > 0 && (yield* this.#turnBack("plan"))) {
      return yield* new Rejected({
        message: `Clef doubts this plan. Revise it and call plan_change again:\n${describe(doubts)}`,
      });
    }

    // An assignment that names its change model gets it; otherwise Clef routes.
    const light = assignment.model === undefined && answers !== undefined && effort(answers) === "mechanical";
    const change = this.#phase("change", assignment, plan, light);

    yield* attempt(
      () => this.ctx.storage.put(PLAN_KEY, plan),
      (cause) => new GateFailed({ message: `storing the plan: ${String(cause)}` }),
    );

    yield* attempt(
      () => api.commit((tx) => configure(tx, api.conversationId, change), context),
      (cause) => new PlanFailed({ message: `switching to the change phase: ${String(cause)}` }),
    );

    return { model: change.model?.modelId ?? DEFAULT_MODEL, doubts };
  });

  /** Whether `gate` turns this call back: it does `MAX_REJECTIONS` times, then lets calls through. */
  readonly #turnBack = Effect.fn("Agent.turnBack")(function* (this: AgentActor, gate: Gate) {
    const key = `rejections:${gate}`;
    const failed = (cause: unknown) => new GateFailed({ message: `counting ${gate} rejections: ${String(cause)}` });
    const count = (yield* attempt(() => this.ctx.storage.get<number>(key), failed)) ?? 0;

    if (count >= MAX_REJECTIONS) {
      return false;
    }

    yield* attempt(() => this.ctx.storage.put(key, count + 1), failed);

    return true;
  });

  /** The attempt's committed change, base to HEAD, without the root's locked files. */
  readonly #diff = Effect.fn("Agent.diff")(function* (this: AgentActor, assignment: Assignment) {
    const excludes = LOCKED_PATHS.map((path) => `':(exclude)${path}'`).join(" ");
    let output = "";

    const ran = yield* attempt(
      () =>
        this.#workspace.exec(
          `git diff --no-color ${assignment.base_commit} HEAD -- . ${excludes}`,
          { cwd: ATTEMPT_DIR, timeout: 60_000, onOutput: (text) => (output += text) },
          BACKGROUND,
        ),
      (cause) => new GateFailed({ message: `diffing the attempt: ${String(cause)}` }),
    );

    if (!ran.ok || ran.value.exitCode !== 0) {
      return yield* new GateFailed({ message: `diffing the attempt: ${ran.ok ? `exit ${ran.value.exitCode}` : ran.error.message}` });
    }

    return output;
  });

  /**
   * Record the submission, once Clef has seen the diff. The tree, which polls
   * `/status`, freezes the attempt at its pushed head and queues it for the
   * root's checks.
   */
  readonly #submit = Effect.fn("Agent.submitLeaf")(function* (this: AgentActor) {
    const assignment = yield* this.#assignment();

    const plan = yield* attempt(
      () => this.ctx.storage.get<string>(PLAN_KEY),
      (cause) => new GateFailed({ message: `reading the plan: ${String(cause)}` }),
    );

    const diff = yield* this.#diff(assignment);
    const answers = yield* advice(DIFF, { task: assignment.intent, plan: plan ?? "", diff: clip(diff) });
    const doubts = answers === undefined ? [] : objections(DIFF.decisions, answers);

    if (doubts.length > 0 && (yield* this.#turnBack("submit"))) {
      return yield* new Rejected({
        message: `Clef doubts this diff. Fix it, commit, push, and call submit again:\n${describe(doubts)}`,
      });
    }

    yield* attempt(
      () => this.ctx.storage.put(OUTCOME_KEY, { state: "submitted" } satisfies Outcome),
      (cause) => new SubmitFailed({ message: `recording the submission: ${String(cause)}` }),
    );

    return { text: "the tree freezes your attempt at what you pushed and scores it", doubts };
  });

  /** Where the run stands, for the tree, and what the agent has been doing, for the UI. */
  async #status() {
    const session = this.harness.session();
    const pi = await this.harness.pi();

    const [stored, busy, entries, agent] = await Promise.all([
      this.ctx.storage.get(OUTCOME_KEY),
      session.busy(),
      session.messages(),
      pi.root(BACKGROUND).then((root) => root.agent(BACKGROUND)),
    ]);

    const outcome = Schema.decodeUnknownOption(Outcome)(stored);

    const state = Option.match(outcome, {
      onSome: (ended) => ended.state,
      onNone: () => (busy || entries.length === 0 ? "working" : "stopped"),
    });

    return {
      state,
      reason: Option.match(outcome, { onSome: (ended) => ("reason" in ended ? ended.reason : undefined), onNone: () => undefined }),
      phase: agent.tools.some((tool) => tool.name === "plan_change") ? "scout" : "change",
      model: agent.model?.modelId ?? DEFAULT_MODEL,
      ...activity(entries.flatMap((entry) => entry.model ?? [])),
    };
  }

  /** `plan_change`, as a pi tool: ends the scout phase. */
  #planTool() {
    return defineTool({
      name: "plan_change",
      description:
        "End scouting: hand your plan to the model that makes the change. Call once, when you know the smallest change that does the task.",
      parameters: Type.Object(
        {
          plan: Type.String({
            minLength: 1,
            description: "The files and the exact edits, the checks to run, and anything surprising you found.",
          }),
        },
        { additionalProperties: false },
      ),
      replay: "safe" as const,
      execute: ({ plan }, api, context) =>
        Effect.runPromise(
          this.#plan(plan, api, context).pipe(
            // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a tool call is an entry point
            Effect.provide(this.#clef),
            Effect.match({
              onSuccess: ({ model, doubts }) =>
                toolText(`Plan handed over; ${model} makes the change from here.${remaining(doubts)}`, false),
              onFailure: (error) => toolText(error.message, true),
            }),
          ),
        ),
    });
  }

  /** `submit`, as a pi tool: the Effect above, rendered as a tool result. */
  #submitTool() {
    return defineTool({
      name: "submit",
      description:
        "Submit your attempt for scoring once your change is committed and pushed and the checks pass. This freezes the attempt: you cannot push after it. Takes no arguments.",
      parameters: Type.Object({}, { additionalProperties: false }),
      replay: "unsafe" as const,
      execute: () =>
        Effect.runPromise(
          this.#submit().pipe(
            // oxlint-disable-next-line effecttsgo/strict-effect-provide -- a tool call is an entry point
            Effect.provide(this.#clef),
            Effect.match({
              onSuccess: ({ text, doubts }) =>
                toolText(`Submitted: ${text}. Your work is done; stop here.${remaining(doubts)}`, false),
              onFailure: (error) => toolText(error.message, true),
            }),
          ),
        ),
    });
  }
}

