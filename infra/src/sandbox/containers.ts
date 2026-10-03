/**
 * The two container applications, one per Durable Object class that drives
 * one: `ScorerContainer` scores and rebases attempts, `WorktreeContainer` is
 * an agent's working copy. Same image (src/sandbox/context: nix, devenv,
 * ficus-scorer); a Cloudflare container application backs exactly one
 * Durable Object class.
 *
 * Both are Durable Object-managed (`schedulingPolicy: "durable_object"`):
 * the application carries no image, size, count or env, and the Durable
 * Object picks the image (`images.scorer`, or a snapshot) and the size at
 * each start (machine.ts). It is the only policy with snapshots, and it
 * starts containers faster. The policy is immutable, so these are new
 * applications on new classes (the old Sandbox and Workspace ran on the
 * `default` policy). alchemy supports it from alchemy-run/alchemy#1905,
 * pinned as a preview in package.json until it is released.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { ScorerBinary } from "./scorer-binary.ts";

/** The image's name in `ctx.container.images`. */
export const IMAGE = "scorer";

const props = Effect.gen(function* () {
  const scorer = yield* ScorerBinary;

  return {
    schedulingPolicy: "durable_object" as const,
    images: {
      // The context is read through the scorer's hash: that is the edge that
      // builds the binary before the image copies it in.
      [IMAGE]: { context: Output.map(scorer.hash.output, () => `${import.meta.dirname}/context`) },
    },
    observability: { logs: { enabled: true } },
  };
});

export class ScorerContainer extends Cloudflare.Container<ScorerContainer>()("ScorerContainer", props) {}

export class WorktreeContainer extends Cloudflare.Container<WorktreeContainer>()("WorktreeContainer", props) {}
