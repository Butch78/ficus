/**
 * The sandbox Worker as a stack resource: ficus-scorer's bundle, the
 * container that runs it, and the Worker hosting `Sandbox` and `Egress`.
 * Its own module so every Worker that binds the sandbox by name can yield it
 * too: alchemy registers a resource once however often it is yielded, and
 * the yield is the edge that deploys the sandbox first.
 *
 * Two of them, the same code and image: `ficus-sandbox-<stage>` (scoring,
 * rebases, agents' workspaces, alchemy.run.ts) and `ficus-deployer-<stage>`
 * (the Deploy Workflow's deploys, deployer.run.ts). A deploy never replaces
 * the Worker it runs in: the deployer deploys the Ficus stack, then a
 * sandbox deploys the deployer.
 */
import { readFileSync } from "node:fs";
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { COMPATIBILITY, OBSERVABILITY } from "../platform.ts";

/** The repository root, where the image build runs. */
const REPO_ROOT = `${import.meta.dirname}/../../..`;

/** Where scripts/sandbox-image leaves the pushed image's reference, from the root (gitignored). */
const SANDBOX_IMAGE_DIR = "infra/.sandbox-image";

/** Which of the two: the name of its Worker and container, `ficus-<role>-<stage>`. */
export type SandboxRole = "sandbox" | "deployer";

export const sandboxWorker = (role: SandboxRole) => Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  // The scorer: ficus-scorer (src/scorer), bundled for bun into the image's context.
  const scorerBinary = yield* Command.Build("ScorerBinary", {
    cwd: "..",
    command: "scripts/build-scorer",
    outdir: "infra/src/sandbox/context",
    memo: {
      include: ["infra/src/scorer/**", "infra/src/core/**", "infra/package.json", "infra/bun.lock", "scripts/build-scorer"],
      lockfile: false,
    },
  });

  const scorerHash = Output.map(scorerBinary.hash.output, (hash) => hash ?? "unhashed");

  // The image. `alchemy dev` (stage local) builds context/Dockerfile with
  // Docker. Every other stage builds it with nix and pushes it to
  // Cloudflare's registry (scripts/sandbox-image), which a deploy sandbox can
  // do with no Docker: Ficus deploys itself that way. Memoized on what the
  // image is made of; the scorer's hash in its env rebuilds it for a new
  // scorer, and orders it after the scorer's build.
  const image =
    stage === "local"
      ? { context: `${import.meta.dirname}/context`, env: { FICUS_SCORER_HASH: scorerHash } }
      : {
          image: Output.map(
            (yield* Command.Build("SandboxImage", {
              cwd: "..",
              command: `scripts/sandbox-image ${stage} ${SANDBOX_IMAGE_DIR}`,
              outdir: SANDBOX_IMAGE_DIR,
              env: { FICUS_SCORER_HASH: scorerHash },
              memo: {
                include: [
                  "nix/sandbox-image.nix",
                  "infra/src/sandbox/context/**",
                  "devenv.lock",
                  "scripts/sandbox-image",
                  "scripts/build-sandbox-image",
                  "scripts/push-sandbox-image",
                ],
                lockfile: false,
              },
            })).hash.output,
            // The script wrote the pushed image's reference; read once it has run.
            () => readFileSync(`${REPO_ROOT}/${SANDBOX_IMAGE_DIR}/reference`, "utf8").trim(),
          ),
        };

  const container = Cloudflare.Container("SandboxContainer", {
    name: `ficus-${role}-${stage}`,
    // The Durable Object class in sandbox.ts that drives it.
    className: "Sandbox",
    ...image,
    instances: 0,
    // Scoring and agents run many at once; deploys one per tree at a time.
    maxInstances: role === "sandbox" ? 20 : 4,
    // A root's devenv shell plus its checks. Ficus's own, when it was
    // Rust, filled standard-1's disk; standard-4 stays until a TS-only
    // root is seen to fit a smaller one. Billed while a sandbox runs:
    // scoring, deploys, and agents' workspaces until idle.
    instanceType: "standard-4",
    observability: { logs: { enabled: true } },
  });

  return yield* Cloudflare.Worker("Sandbox", {
    name: `ficus-${role}-${stage}`,
    main: `${import.meta.dirname}/worker.ts`,
    compatibility: COMPATIBILITY,
    observability: OBSERVABILITY,
    workersDev: false,
    // Workers AI, for Clef: the root's judges are asked from here.
    env: { SANDBOX: container, AI: Cloudflare.Workers.AI() },
  });
});

/** The scoring sandbox, `ficus-sandbox-<stage>`. */
export const SandboxWorker = sandboxWorker("sandbox");
