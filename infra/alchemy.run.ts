// The Ficus stack:
//
//   Api      src/api/worker.ts     the one public entry: Better Auth on D1
//                                  (users, organizations, API keys); forwards
//                                  /v1/orgs/<org>/trees/... to Tree
//   Worker   crates/ficus-worker   the tree service (TreeObject, Artifacts);
//                                  internal only, no public URL: reached
//                                  through Api's service binding, which
//                                  vouches for the tenant
//   Sandbox  src/sandbox/worker.ts Effect-native: untrusted work in
//                                  containers with the internet off (Sandbox
//                                  scores a leaf, Workspace is an agent's);
//                                  Egress decides which hosts they reach and
//                                  adds the credentials they never see; a
//                                  base's warmed snapshot boots them fast
//   Agents   src/agents/worker.ts  AgentActor: a pi agent per attempt, working
//                                  in its Workspace; started by Api
//
//   bun run plan | deploy | destroy        STAGE defaults to dev
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import { OWNER, REPO } from "./src/github.ts";
import SandboxWorker from "./src/sandbox/worker.ts";
import { COMPATIBILITY, OBSERVABILITY } from "./src/stack.ts";

export default Alchemy.Stack(
  "Ficus",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Command.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;

    const bundle = yield* Command.Build("WorkerBundle", {
      cwd: "../crates/ficus-worker",
      command: "worker-build --release",
      outdir: "build",
      // The memo hashes what `include` matches, never `command`: this file
      // is listed so a changed build line rebuilds.
      memo: {
        include: [
          "**/*",
          "../ficus-core/**",
          "../../Cargo.toml",
          "../../Cargo.lock",
          "../../rust-toolchain.toml",
          "../../infra/alchemy.run.ts",
        ],
        lockfile: false,
      },
    });

    // Effect-native: the Sandbox and Workspace Durable Objects, their
    // container applications, and ficus-scorer's build (src/sandbox).
    const sandbox = yield* SandboxWorker;

    // One namespace per stage; Artifacts creates it with the first repo.
    const artifacts = yield* Cloudflare.Artifacts.Namespace("Artifacts", { namespace: `ficus-${stage}` });

    const worker = yield* Cloudflare.Worker("Worker", {
      name: `ficus-${stage}`,
      // index.js, not build/worker/shim.mjs: the shim is a back-compat
      // re-export that only resolves the wasm under one bundling mode.
      main: "../crates/ficus-worker/build/index.js",
      compatibility: COMPATIBILITY,
      observability: OBSERVABILITY,
      // Internal: trusts the tenant header, so only Api may reach it.
      workersDev: false,
      env: {
        // The edge that orders the build before the upload.
        FICUS_BUNDLE_HASH: Output.map(bundle.hash.output, (hash) => hash ?? "unhashed"),
        ARTIFACTS: artifacts,
        // `TreeObject` is the #[durable_object] struct in crates/ficus-worker.
        TREES: Cloudflare.DurableObject("TREES", { className: "TreeObject" }),
        // Sandboxes that score attempts: the `Sandbox` class in the sandbox Worker.
        // By literal name: `alchemy dev` cannot coerce a deploy-time Output
        // into a class's scriptName. The env value below keeps the edge that
        // deploys the sandbox Worker (and its class) before this one.
        SANDBOX: Cloudflare.DurableObject("SANDBOX", { className: "Sandbox", scriptName: `ficus-sandbox-${stage}` }),
        FICUS_SANDBOX_SCRIPT: sandbox.workerName,
      },
    });

    // A pi agent per attempt. Async, not Effect-native: AgentActor is a plain
    // Durable Object class (pi's PiHarness installs itself on `this`), which
    // an Effect-native Worker cannot export. Its bindings name the other
    // scripts literally (`alchemy dev` cannot coerce a deploy-time Output into
    // a class's scriptName); the script env values keep the deploy order.
    const agents = yield* Cloudflare.Worker("Agents", {
      name: `ficus-agents-${stage}`,
      main: "./src/agents/worker.ts",
      compatibility: COMPATIBILITY,
      observability: OBSERVABILITY,
      workersDev: false,
      env: {
        AI: Cloudflare.Workers.AI(),
        AGENTS: Cloudflare.DurableObject("AGENTS", { className: "AgentActor" }),
        WORKSPACES: Cloudflare.DurableObject("WORKSPACES", {
          className: "Workspace",
          scriptName: `ficus-sandbox-${stage}`,
        }),
        TREES: Cloudflare.DurableObject("TREES", { className: "TreeObject", scriptName: `ficus-${stage}` }),
        FICUS_SANDBOX_SCRIPT: sandbox.workerName,
        FICUS_TREE_SCRIPT: worker.workerName,
      },
    });

    // Accounts. The schema is Better Auth's for src/api/auth.ts's plugins,
    // compiled by `bun run auth:schema`; applied in order on deploy.
    const authDb = yield* Cloudflare.D1.Database("AuthDb", {
      name: `ficus-auth-${stage}`,
      migrations: "./src/api/migrations",
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
        // Starts an attempt's agent when it starts or retries (src/api/agents.ts).
        AGENTS: Cloudflare.DurableObject("AGENTS", { className: "AgentActor", scriptName: `ficus-agents-${stage}` }),
        FICUS_AGENTS_SCRIPT: agents.workerName,
      },
    });

    // A pull request's preview stage says where it lives, on the pull request.
    // The logical id is stable, so each push edits the same comment.
    const pullRequest = yield* Config.option(Config.Int("PULL_REQUEST"));

    if (Option.isSome(pullRequest)) {
      yield* GitHub.Comment("PreviewComment", {
        owner: OWNER,
        repository: REPO,
        issueNumber: pullRequest.value,
        body: Output.interpolate`## 🌿 Ficus preview: \`${stage}\`

API: ${api.url}

Deployed from this pull request by \`deploy.yml\`; destroyed when it closes.`,
      });
    }

    return { api: api.url.as<string>() };
  }),
);
