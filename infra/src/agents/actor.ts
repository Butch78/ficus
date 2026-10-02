/**
 * `AgentActor`: one Durable Object per leaf, running one pi agent that grows
 * that leaf. The tree is the only thing that talks to it.
 *
 * - `POST /grow` (from `TreeObject`): the assignment. The actor clones the
 *   leaf into its container, then hands pi the bud's intent and the compost of
 *   earlier attempts. pi's run is durable from there: every model turn and
 *   tool call is checkpointed in this object's SQLite, so an eviction resumes
 *   the run rather than losing it.
 * - `GET /status`: whether the agent is still working, and its last words.
 *
 * The agent works in a container (`ScorerContainer`, the same image the
 * scorer uses: nix, devenv, git), through pi's read/write/edit/bash tools, so
 * it can run the root's own checks before it submits. It submits with the
 * `submit_leaf` tool, which freezes the leaf and queues it for scoring.
 */
import { DurableObject } from "cloudflare:workers";
import { createModels } from "@earendil-works/pi-ai/models";
import { BACKGROUND_CONTEXT as BACKGROUND } from "@earendil-works/chord/context";
import { createRegistry, defineExtension, defineTool, Harness } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { PiHarness } from "agents/harness/pi";
import { Lifecycle } from "agents/lifecycle";
import { CLOUDFLARE_PROVIDER_ID, createAI } from "agents/models/pi-ai";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Type } from "typebox";
import { ContainerEnv, type SandboxStub } from "./sandbox-env.ts";

/** Where the leaf is checked out inside the agent's container. */
const LEAF_DIR = "/work/leaf";

/** The model an agent runs when its assignment names none. */
export const DEFAULT_MODEL = "@cf/moonshotai/kimi-k2.7-code";

const CompostEntry = Schema.Struct({
  leaf: Schema.Number,
  agent: Schema.String,
  reason: Schema.Json,
  score: Schema.NullOr(Schema.Json),
});

/** What `TreeObject` sends when it starts this leaf. */
export const Assignment = Schema.Struct({
  tree: Schema.String,
  leaf: Schema.Number,
  bud: Schema.Number,
  intent: Schema.String,
  agent: Schema.String,
  model: Schema.optional(Schema.String),
  remote: Schema.String,
  token: Schema.String,
  base_commit: Schema.String,
  compost: Schema.Array(CompostEntry),
});

export interface Assignment extends Schema.Schema.Type<typeof Assignment> {}

const ASSIGNMENT_KEY = "assignment";

interface Bindings {
  readonly AI: Ai;
  readonly SCORER: DurableObjectNamespace;
  readonly TREES: DurableObjectNamespace;
}

export class GrowRejected extends Schema.TaggedError<GrowRejected>()("Agent.GrowRejected", {
  status: Schema.Number,
  message: Schema.String,
}) {}

/** The tree refused the submission, or could not be reached. */
export class SubmitFailed extends Schema.TaggedError<SubmitFailed>()("Agent.SubmitFailed", {
  message: Schema.String,
}) {}

/** A promise from storage or pi whose rejection the caller should see as `onFail`. */
const attempt = <A, E>(run: () => Promise<A>, onFail: (cause: unknown) => E): Effect.Effect<A, E> =>
  Effect.tryPromise({ try: run, catch: onFail });

const toolText = (text: string, isError: boolean) => ({ content: [{ type: "text" as const, text }], isError });

/** The instructions an agent starts from. */
export const prompt = (assignment: Assignment): string => {
  const compost =
    assignment.compost.length === 0
      ? "No earlier attempts at this bud."
      : assignment.compost
          .map((entry) => `- leaf ${entry.leaf} by ${entry.agent}: ${JSON.stringify(entry.reason)}; score ${JSON.stringify(entry.score)}`)
          .join("\n");

  return [
    `You are ${assignment.agent}, one of several agents working on the same task in parallel. Each of you has your own copy of the repository; the smallest change that passes every check wins.`,
    "",
    `Task: ${assignment.intent}`,
    "",
    `Your checkout is ${LEAF_DIR} (git, on main, already configured to push). It starts at commit ${assignment.base_commit}.`,
    "",
    "Rules:",
    "- The repository's `ficus.toml` lists the checks your change must pass. Run each one yourself before submitting. If the repository has a `devenv.nix`, run checks as `devenv shell -- <command>` (the first run builds the environment and can take a few minutes).",
    "- You cannot change the checks: `ficus.toml` and the devenv files are restored from the base before scoring.",
    "- Keep the change as small as the task allows. Do not reformat or touch unrelated code.",
    "- When the checks pass, commit, `git push origin HEAD:main`, then call the `submit_leaf` tool. Submitting freezes your leaf; you cannot push after it.",
    "- If you cannot complete the task, say why instead of submitting.",
    "",
    "Earlier attempts at this task (the compost):",
    compost,
  ].join("\n");
};

export class AgentActor extends DurableObject<Bindings> {
  readonly #ai = createAI({ binding: this.env.AI });

  /** The leaf's container: one `ScorerContainer` instance per agent. */
  readonly #sandbox: SandboxStub = this.env.SCORER.get(this.env.SCORER.idFromName(`agent:${this.ctx.id.name ?? this.ctx.id.toString()}`));

  readonly #workspace = new ContainerEnv(this.#sandbox, `agent:${this.ctx.id.toString()}`, LEAF_DIR);

  readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
      const models = createModels();

      models.setProvider(this.#ai.provider);

      const registry = createRegistry();

      registry.install(CodingTools);
      registry.install(defineExtension({ name: "ficus", tools: [this.#submitTool()] }));

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
          Effect.map(() => Response.json({ state: "growing" }, { status: 202 })),
          Effect.catchTag("Agent.GrowRejected", (error) => Effect.succeed(Response.json({ error: error.message }, { status: error.status }))),
        ),
      );
    }

    if (request.method === "GET" && url.pathname === "/status") {
      const session = this.harness.session();
      const messages = await session.messages();
      const last = messages.at(-1);

      return Response.json({
        busy: await session.busy(),
        entries: messages.length,
        assignment: await this.ctx.storage.get(ASSIGNMENT_KEY),
        last: last === undefined ? null : last.kind,
      });
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

    const session = this.harness.session();
    const model = { provider: CLOUDFLARE_PROVIDER_ID, id: assignment.model ?? DEFAULT_MODEL };

    yield* attempt(() => session.setModel(model), failed("choosing the model"));

    yield* attempt(
      () => session.submit([{ type: "text", text: prompt(assignment) }], { operationId: `grow-${assignment.leaf}` }),
      failed("starting the run"),
    );
  });

  /** Clone the leaf into the container and set the identity it commits as. */
  readonly #prepare = Effect.fn("Agent.prepare")(function* (this: AgentActor, assignment: Assignment) {
    const auth = `Authorization: Bearer ${assignment.token}`;

    const script = [
      `rm -rf ${LEAF_DIR} && mkdir -p /work`,
      `git -c http.extraHeader='${auth}' clone --quiet '${assignment.remote}' ${LEAF_DIR}`,
      `cd ${LEAF_DIR}`,
      `git config http.extraHeader '${auth}'`,
      `git config user.name '${assignment.agent}'`,
      `git config user.email '${assignment.agent}@agents.ficus.dev'`,
    ].join(" && ");

    const ran = yield* attempt(
      () => this.#workspace.exec(script, { cwd: "/", timeout: 300_000 }, BACKGROUND),
      (cause) => new GrowRejected({ status: 502, message: `preparing the leaf: ${String(cause)}` }),
    );

    if (!ran.ok) {
      return yield* new GrowRejected({ status: 502, message: `preparing the leaf: ${ran.error.message}` });
    }

    if (ran.value.exitCode !== 0) {
      return yield* new GrowRejected({ status: 502, message: `preparing the leaf: exit ${ran.value.exitCode}` });
    }
  });

  /** Freeze this leaf and queue it for the root's checks, via its tree. */
  readonly #submit = Effect.fn("Agent.submitLeaf")(function* (this: AgentActor) {
    const stored = yield* attempt(
      () => this.ctx.storage.get(ASSIGNMENT_KEY),
      (cause) => new SubmitFailed({ message: `reading the assignment: ${String(cause)}` }),
    );

    const assignment = yield* Schema.decodeUnknownEffect(Assignment)(stored).pipe(
      Effect.mapError(() => new SubmitFailed({ message: "this agent has no assignment" })),
    );

    const tree = this.env.TREES.get(this.env.TREES.idFromName(assignment.tree));
    const url = `http://tree/trees/${assignment.tree}/leaves/${assignment.leaf}/ripe`;

    const response = yield* attempt(
      () => tree.fetch(url, { method: "POST" }),
      (cause) => new SubmitFailed({ message: `the tree is unreachable: ${String(cause)}` }),
    );

    const text = yield* attempt(
      () => response.text(),
      (cause) => new SubmitFailed({ message: `reading the tree's answer: ${String(cause)}` }),
    );

    if (!response.ok) {
      return yield* new SubmitFailed({ message: `submit refused (${response.status}): ${text}` });
    }

    return text;
  });

  /** `submit_leaf`, as a pi tool: the Effect above, rendered as a tool result. */
  #submitTool() {
    return defineTool({
      name: "submit_leaf",
      description:
        "Submit your leaf for scoring once your change is committed and pushed and the checks pass. This freezes the leaf: you cannot push after it. Takes no arguments.",
      parameters: Type.Object({}, { additionalProperties: false }),
      replay: "unsafe" as const,
      execute: () =>
        Effect.runPromise(
          this.#submit().pipe(
            Effect.match({
              onSuccess: (text) => toolText(`Submitted: ${text}. Your work is done; stop here.`, false),
              onFailure: (error) => toolText(error.message, true),
            }),
          ),
        ),
    });
  }
}

