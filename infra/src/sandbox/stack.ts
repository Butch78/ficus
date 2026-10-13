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
import * as Config from "effect/Config";
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
  // Docker. Every other stage appends Ficus's files to the pinned base image
  // (base-image, scripts/build-sandbox-base) in Cloudflare's registry
  // (scripts/sandbox-image), which a deploy sandbox can do with no Docker:
  // Ficus deploys itself that way. Memoized on what the image is made of;
  // the scorer's hash in its env rebuilds it for a new scorer, and orders it
  // after the scorer's build.
  // A prebuilt image pinned by digest (FICUS_SANDBOX_IMAGE) takes the place of building one.
  const pinned = yield* Config.String("FICUS_SANDBOX_IMAGE").pipe(Config.withDefault(""));

  const image =
    pinned !== ""
      ? { image: pinned }
      : stage === "local"
      ? // From the scorer's hash, so the image builds after the scorer it copies.
        { context: Output.map(scorerHash, () => `${import.meta.dirname}/context`) }
      : {
          image: Output.map(
            (yield* Command.Build("SandboxImage", {
              cwd: "..",
              command: `scripts/sandbox-image ${stage} ${SANDBOX_IMAGE_DIR}`,
              outdir: SANDBOX_IMAGE_DIR,
              env: { FICUS_SCORER_HASH: scorerHash },
              memo: {
                include: ["infra/src/sandbox/base-image", "infra/src/sandbox/context/**", "scripts/sandbox-image"],
                lockfile: false,
              },
            })).hash.output,
            // The script wrote the pushed image's reference; read once it has run.
            () => readFileSync(`${REPO_ROOT}/${SANDBOX_IMAGE_DIR}/reference`, "utf8").trim(),
          ),
        };

  // Managed by the Durable Object (`schedulingPolicy: "durable_object"`):
  // each `Sandbox` starts the image itself, choosing its size then
  // (sandbox.ts `SANDBOX_INSTANCE`), and may start from a snapshot, which
  // only this policy offers. The image is found in `ctx.container.images`
  // under this Container's id (sandbox.ts `SANDBOX_IMAGE`).
  const container = Cloudflare.Container("SandboxContainer", {
    schedulingPolicy: "durable_object",
    ...image,
    observability: { logs: { enabled: true } },
  });

  return yield* Cloudflare.Worker("Sandbox", {
    name: `ficus-${role}-${stage}`,
    main: `${import.meta.dirname}/worker.ts`,
    compatibility: COMPATIBILITY,
    observability: OBSERVABILITY,
    workersDev: false,
    env: {
      // The Durable Object class in sandbox.ts, with its container.
      SANDBOX: Cloudflare.DurableObject("SANDBOX", { className: "Sandbox", containers: [container] }),
      // Workers AI, for Clef: the root's judges are asked from here.
      AI: Cloudflare.Workers.AI(),
    },
  });
});

/** The scoring sandbox, `ficus-sandbox-<stage>`. */
export const SandboxWorker = sandboxWorker("sandbox");
