/**
 * The sandbox Worker as a stack resource: ficus-scorer's bundle, the
 * container that runs it, and the Worker hosting `Sandbox` and `Egress`.
 * Its own module so every Worker that binds the sandbox by name can yield it
 * too: alchemy registers a resource once however often it is yielded, and
 * the yield is the edge that deploys the sandbox first.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { COMPATIBILITY, OBSERVABILITY } from "../platform.ts";

export const SandboxWorker = Effect.gen(function* () {
  const { stage } = yield* Alchemy.Stack;

  // The scorer: ficus-scorer (src/scorer, bundled, run by bun) in an image
  // with nix + devenv. The bundle's hash rides into the container's env so
  // a new scorer redeploys the container. That edge does not order the image build
  // after this one (the image builds in an earlier phase), so run
  // scripts/build-scorer before deploying, as deploy.yml does; this build
  // then finds it up to date.
  const scorerBinary = yield* Command.Build("ScorerBinary", {
    cwd: "..",
    command: "scripts/build-scorer",
    outdir: "infra/src/sandbox/context",
    memo: {
      include: ["infra/src/scorer/**", "infra/src/core/**", "infra/package.json", "infra/bun.lock", "scripts/build-scorer"],
      lockfile: false,
    },
  });

  // The image: one already in Cloudflare's registry when FICUS_SANDBOX_IMAGE
  // names it (nix-built by scripts/build-sandbox-image and pushed by
  // scripts/push-sandbox-image, as a deploy without Docker does), else
  // context/Dockerfile built with Docker. The bundle's hash rides along with
  // the Dockerfile build, so a new scorer redeploys the container.
  const prebuilt = yield* Config.option(Config.String("FICUS_SANDBOX_IMAGE"));

  const image = Option.isSome(prebuilt)
    ? { image: prebuilt.value }
    : {
        context: `${import.meta.dirname}/context`,
        env: { FICUS_SCORER_HASH: Output.map(scorerBinary.hash.output, (hash) => hash ?? "unhashed") },
      };

  const container = Cloudflare.Container("SandboxContainer", {
    name: `ficus-sandbox-${stage}`,
    // The Durable Object class in sandbox.ts that drives it.
    className: "Sandbox",
    ...image,
    instances: 0,
    maxInstances: 20,
    // A root's devenv shell plus its checks. Ficus's own, when it was
    // Rust, filled standard-1's disk; standard-4 stays until a TS-only
    // root is seen to fit a smaller one. Billed while a sandbox runs:
    // scoring, deploys, and agents' workspaces until idle.
    instanceType: "standard-4",
    observability: { logs: { enabled: true } },
  });

  return yield* Cloudflare.Worker("Sandbox", {
    name: `ficus-sandbox-${stage}`,
    main: `${import.meta.dirname}/worker.ts`,
    compatibility: COMPATIBILITY,
    observability: OBSERVABILITY,
    workersDev: false,
    // Workers AI, for Clef: the root's judges are asked from here.
    env: { SANDBOX: container, AI: Cloudflare.Workers.AI() },
  });
});
