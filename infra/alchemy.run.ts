// The Ficus stack:
//
//   Api      src/api/worker.ts     the one public entry: Better Auth on D1
//                                  (users, organizations, API keys); forwards
//                                  /v1/orgs/<org>/trees/... to Tree
//   Worker   crates/ficus-worker   the tree service (TreeObject, Artifacts);
//                                  internal only, no public URL: reached
//                                  through Api's service binding, which
//                                  vouches for the tenant
//   Sandbox  src/sandbox/worker.ts untrusted work in containers with the
//                                  internet off; Egress decides, per phase,
//                                  which hosts they reach (and adds the
//                                  credentials they never see); asks Clef
//                                  the root's judges once a container is gone
//
//   The web UI is a stack of its own (web.run.ts), deployed after this one
//   to the same stage; it binds `Api` by reference.
//
//   bun run plan | deploy | destroy        STAGE defaults to dev
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { COMPATIBILITY, OBSERVABILITY } from "./src/platform.ts";

export default Alchemy.Stack(
  "Ficus",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Command.providers()),
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

    // The scorer: ficus-scorer (static musl) in an image with nix + devenv.
    // The binary's hash rides into the container's env, which is the edge
    // that builds the binary before the image that copies it.
    const scorerBinary = yield* Command.Build("ScorerBinary", {
      cwd: "..",
      command: "scripts/build-scorer",
      outdir: "infra/src/sandbox/context",
      memo: {
        include: [
          "crates/ficus-scorer/**",
          "crates/ficus-core/**",
          "Cargo.toml",
          "Cargo.lock",
          "rust-toolchain.toml",
          "scripts/build-scorer",
        ],
        lockfile: false,
      },
    });

    const sandboxContainer = Cloudflare.Container("SandboxContainer", {
      name: `ficus-sandbox-${stage}`,
      // The Durable Object class in src/sandbox/sandbox.ts that drives it.
      className: "Sandbox",
      context: `${import.meta.dirname}/src/sandbox/context`,
      instances: 0,
      maxInstances: 20,
      // A root's devenv shell plus its checks: nix needs the disk and memory
      // the basic tier does not have.
      instanceType: "standard-1",
      observability: { logs: { enabled: true } },
      env: {
        FICUS_SCORER_HASH: Output.map(scorerBinary.hash.output, (hash) => hash ?? "unhashed"),
      },
    });

    const sandbox = yield* Cloudflare.Worker("Sandbox", {
      name: `ficus-sandbox-${stage}`,
      main: "./src/sandbox/worker.ts",
      compatibility: COMPATIBILITY,
      observability: OBSERVABILITY,
      workersDev: false,
      // Workers AI, for Clef: the root's judges are asked from here.
      env: { SANDBOX: sandboxContainer, AI: Cloudflare.Workers.AI() },
    });

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
      },
    });

    return { api: api.url.as<string>() };
  }),
);
