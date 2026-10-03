// The Ficus stack:
//
//   Api      src/api/worker.ts     the one public entry: Better Auth on D1
//                                  (users, organizations, API keys); forwards
//                                  /v1/orgs/<org>/trees/... to Tree
//   Worker   src/tree/worker.ts    the tree service (TreeObject, Artifacts);
//                                  internal only, no public URL: reached
//                                  through Api's service binding, which
//                                  vouches for the tenant
//   Sandbox  src/sandbox/worker.ts Effect-native: untrusted work in
//                                  containers with the internet off (Scorer
//                                  scores and rebases attempts, Worktree is
//                                  an agent's); Egress decides which hosts
//                                  they reach and adds the credentials they
//                                  never see; a base's warmed snapshot boots
//                                  them fast; asks Clef the root's judges
//   Agents   src/agents/worker.ts  one AgentActor per attempt an agent works:
//                                  pi on Workers AI, working in its Worktree,
//                                  Clef at its handovers; the tree
//                                  dispatches and polls them
//
//   The web UI is a stack of its own (web.run.ts), deployed after this one
//   to the same stage; it binds `Api` by reference.
//
//   bun run plan | deploy | destroy        STAGE defaults to dev
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Drizzle from "alchemy/Drizzle";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import SandboxWorker from "./src/sandbox/worker.ts";
import { COMPATIBILITY, OBSERVABILITY } from "./src/platform.ts";

export default Alchemy.Stack(
  "Ficus",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Command.providers(), Drizzle.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;

    // Effect-native: the Scorer and Worktree Durable Objects, their
    // container applications, and ficus-scorer's bundle (src/sandbox).
    const sandbox = yield* SandboxWorker;

    // Agents: one AgentActor per attempt an agent works, a pi agent on Workers
    // AI (Clef judges its plan and diff) working in its own Worktree. Async,
    // not Effect-native: AgentActor is a plain Durable Object class (pi's
    // PiHarness installs itself on `this`). Internal: only the tree reaches it.
    const agents = yield* Cloudflare.Worker("Agents", {
      name: `ficus-agents-${stage}`,
      main: "./src/agents/worker.ts",
      compatibility: COMPATIBILITY,
      observability: OBSERVABILITY,
      workersDev: false,
      env: {
        AI: Cloudflare.Workers.AI(),
        // `AgentActor` is the Durable Object class src/agents/worker.ts exports.
        AGENTS: Cloudflare.DurableObject("AGENTS", { className: "AgentActor" }),
        // An agent's container: the `Worktree` class in the sandbox Worker.
        // By literal name: `alchemy dev` cannot coerce a deploy-time Output
        // into a class's scriptName. The env value below keeps the edge that
        // deploys the sandbox Worker (and its class) before this one.
        WORKSPACES: Cloudflare.DurableObject("WORKSPACES", { className: "Worktree", scriptName: `ficus-sandbox-${stage}` }),
        FICUS_SANDBOX_SCRIPT: sandbox.workerName,
      },
    });

    // One namespace per stage; Artifacts creates it with the first repo.
    const artifacts = yield* Cloudflare.Artifacts.Namespace("Artifacts", { namespace: `ficus-${stage}` });

    const worker = yield* Cloudflare.Worker("Worker", {
      name: `ficus-${stage}`,
      // The tree Worker and its TreeObject (src/tree), in Effect TypeScript.
      main: "./src/tree/worker.ts",
      compatibility: COMPATIBILITY,
      observability: OBSERVABILITY,
      // Internal: trusts the tenant header, so only Api may reach it.
      workersDev: false,
      env: {
        ARTIFACTS: artifacts,
        // `TreeObject` is the Durable Object class src/tree/worker.ts exports.
        TREES: Cloudflare.DurableObject("TREES", { className: "TreeObject" }),
        // Containers that score and rebase attempts: the `Scorer` class in the
        // sandbox Worker, by literal name like WORKSPACES, with the same edge.
        SANDBOX: Cloudflare.DurableObject("SANDBOX", { className: "Scorer", scriptName: `ficus-sandbox-${stage}` }),
        FICUS_SANDBOX_SCRIPT: sandbox.workerName,
        // The agents that work attempts: `AgentActor` in the agents Worker.
        AGENTS: Cloudflare.DurableObject("AGENTS", { className: "AgentActor", scriptName: `ficus-agents-${stage}` }),
        FICUS_AGENTS_SCRIPT: agents.workerName,
      },
    });

    // Accounts and the tree directory. Migrations are drizzle-kit's: on each
    // deploy, Drizzle.Schema writes one for any change to src/api/schema.ts
    // (Ficus's tables), and the database applies the pending ones in order.
    // Better Auth's tables come from `bun run auth:schema <name>`, which
    // writes a custom migration into the same chain.
    const apiSchema = yield* Drizzle.Schema("ApiSchema", {
      schema: "./src/api/schema.ts",
      out: "./src/api/migrations",
      dialect: "sqlite",
    });

    const authDb = yield* Cloudflare.D1.Database("AuthDb", {
      name: `ficus-auth-${stage}`,
      migrations: apiSchema,
    });

    // Signs sessions. Generated once per stage and kept in state.
    const authSecret = yield* Alchemy.Random("BetterAuthSecret");

    const api = yield* Cloudflare.Worker("Api", {
      name: `ficus-api-${stage}`,
      main: "./src/api/worker.ts",
      compatibility: COMPATIBILITY,
      observability: OBSERVABILITY,
      env: {
        AUTH_DB: authDb,
        BETTER_AUTH_SECRET: authSecret.text,
        // A service binding: the only way into the tree Worker.
        TREE: worker,
      },
    });

    return { api: api.url.as<string>() };
  }),
);
