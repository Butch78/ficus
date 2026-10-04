// The Ficus stack:
//
//   Api      src/api/worker.ts     the one public entry: Better Auth on D1
//                                  (users, organizations, API keys); forwards
//                                  /v1/orgs/<org>/trees/... to Tree
//   Worker   src/tree/worker.ts    the tree service (TreeObject, Artifacts);
//                                  internal only, no public URL: reached
//                                  through Api's service binding, which
//                                  vouches for the tenant
//   Sandbox  src/sandbox/worker.ts untrusted work in containers with the
//                                  internet off; Egress decides, per phase,
//                                  which hosts they reach (and adds the
//                                  credentials they never see); asks Clef
//                                  the root's judges once a container is gone
//   Agents   src/agents/worker.ts  one AgentActor per attempt an agent works:
//                                  pi on Workers AI, working in a sandbox,
//                                  Clef at its handovers; the tree
//                                  dispatches and polls them
//   Deploys  src/deploys/worker.ts Effect-native: the `Deploy` Workflow, one
//                                  instance per release, running the root's
//                                  `[deploy]` in the deployer's sandboxes.
//                                  Only with FICUS_DEPLOYS=true, after
//                                  secrets.run.ts and deployer.run.ts
//
//   The web UI is a stack of its own (web.run.ts), deployed after this one
//   to the same stage; it binds `Api` by reference.
//
//   bun run plan | deploy | destroy        STAGE defaults to dev
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Drizzle from "alchemy/Drizzle";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import DeploysWorker from "./src/deploys/worker.ts";
import { artifactsNamespace, COMPATIBILITY, OBSERVABILITY } from "./src/platform.ts";
import { SandboxWorker } from "./src/sandbox/stack.ts";

export default Alchemy.Stack(
  "Ficus",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Command.providers(), Drizzle.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;

    const sandbox = yield* SandboxWorker;

    // Agents: one AgentActor per attempt an agent works, a pi agent on Workers
    // AI (Clef judges its plan and diff) working in its own sandbox. Internal:
    // only the tree reaches it.
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
        // An agent's workspace is a sandbox: the scorer's image, its egress.
        SANDBOX: Cloudflare.DurableObject("SANDBOX", { className: "Sandbox", scriptName: `ficus-sandbox-${stage}` }),
        FICUS_SANDBOX_SCRIPT: sandbox.workerName,
      },
    });

    // One namespace per stage; Artifacts creates it with the first repo.
    const artifacts = yield* artifactsNamespace;

    // Deploys: on a stage deployed with FICUS_DEPLOYS=true, a tree's release
    // runs the root's `[deploy]` (src/deploys) with the deploy token
    // secrets.run.ts keeps for the stage; elsewhere releases do not deploy.
    const deploysEnabled = yield* Config.Boolean("FICUS_DEPLOYS").pipe(Config.withDefault(false));
    let deploys = {};

    if (deploysEnabled) {
      const host = yield* DeploysWorker;

      deploys = {
        // The `Deploy` Workflow the deploys Worker hosts, by literal script
        // name like SANDBOX, with the same deploy-order edge.
        DEPLOYS: Cloudflare.Workflow("Deploy", { className: "Deploy", scriptName: `ficus-deploys-${stage}` }),
        FICUS_DEPLOYS_SCRIPT: host.workerName,
      };
    }

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
        // `TreeObject` is the Durable Object class src/tree/worker.ts exports;
        // the same name since the first deploy, so trees and their storage carry over.
        TREES: Cloudflare.DurableObject("TREES", { className: "TreeObject" }),
        // Sandboxes that score attempts: the `Sandbox` class in the sandbox Worker.
        // By literal name: `alchemy dev` cannot coerce a deploy-time Output
        // into a class's scriptName. The env value below keeps the edge that
        // deploys the sandbox Worker (and its class) before this one.
        SANDBOX: Cloudflare.DurableObject("SANDBOX", { className: "Sandbox", scriptName: `ficus-sandbox-${stage}` }),
        FICUS_SANDBOX_SCRIPT: sandbox.workerName,
        // The agents that work attempts: `AgentActor` in the agents Worker, by
        // literal name like SANDBOX, with the same deploy-order edge.
        AGENTS: Cloudflare.DurableObject("AGENTS", { className: "AgentActor", scriptName: `ficus-agents-${stage}` }),
        FICUS_AGENTS_SCRIPT: agents.workerName,
        ...deploys,
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

    // Every tree's export, nightly (src/api/backups.ts), kept for 90 days.
    const backups = yield* Cloudflare.R2.Bucket("Backups", {
      name: `ficus-backups-${stage}`,
      lifecycleRules: [{ id: "expire", deleteObjectsTransition: { condition: { type: "Age", maxAge: 90 * 24 * 60 * 60 } } }],
    });

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
        BACKUPS: backups,
      },
      // The nightly backup.
      crons: ["17 3 * * *"],
    });

    return { api: api.url.as<string>() };
  }),
);
