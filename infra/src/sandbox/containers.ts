/**
 * The two container applications, one per Durable Object class that drives
 * one: `SandboxContainer` scores attempts, `WorkspaceContainer` is an agent's
 * workspace. Same image (src/sandbox/context: nix, devenv, ficus-scorer);
 * a Cloudflare container application backs exactly one Durable Object class.
 *
 * Both are Durable Object-managed (`schedulingPolicy: "durable_object"`):
 * the application carries no image, size or count, and the Durable Object
 * picks them at each start (machine.ts), from `images.default` or from a
 * snapshot. It is the only policy with snapshots, and it starts faster.
 * alchemy supports it from alchemy-run/alchemy#1904 (pinned as a preview in
 * package.json until it is released).
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { ScorerBinary } from "./scorer-binary.ts";

const props = Effect.gen(function* () {
  const scorer = yield* ScorerBinary;

  return {
    // Published as the container's `images.default`.
    context: `${import.meta.dirname}/context`,
    schedulingPolicy: "durable_object" as const,
    observability: { logs: { enabled: true } },
    // The application has no environment in this mode; the scorer's hash is
    // here for the edge that builds the binary before the image copies it.
    env: { FICUS_SCORER_HASH: Output.map(scorer.hash.output, (hash) => hash ?? "unhashed") },
  };
});

export class SandboxContainer extends Cloudflare.Container<SandboxContainer>()("SandboxContainer", props) {}

export class WorkspaceContainer extends Cloudflare.Container<WorkspaceContainer>()("WorkspaceContainer", props) {}

/** The part of a container class this module reads. */
interface Bindable {
  readonly "~alchemy/Container/Binding"?: Effect.Effect<void>;
}

/**
 * Attach a container application to the Durable Object being declared,
 * without starting it. `Cloudflare.Containers.layer` would start it at
 * construction with fixed options; these objects start it per request,
 * from a snapshot when they have one. alchemy has no public API for that,
 * so this reads the binding alchemy keeps on the class (its own
 * `Containers.layer` yields the same Effect). Recheck on alchemy upgrades.
 */
export const bindContainer = (container: typeof SandboxContainer | typeof WorkspaceContainer) =>
  Effect.gen(function* () {
    // SAFETY: alchemy 2.0.0-beta.80 sets this key on every Container class
    // (src/Cloudflare/Containers/Container.ts); the check below fails loudly
    // if a later alchemy drops it. Its Effect yields the binding's runtime
    // handle, which these objects do not use.
    const bindable: Bindable = container as Bindable;
    const binding = bindable["~alchemy/Container/Binding"];

    if (binding === undefined) {
      return yield* Effect.die(new Error("alchemy no longer exposes ~alchemy/Container/Binding: see containers.ts"));
    }

    yield* binding;
  });
