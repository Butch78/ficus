/**
 * The two container applications, one per Durable Object class that drives
 * one: `SandboxContainer` scores leaves, `WorkspaceContainer` is an agent's
 * workspace. Same image (src/sandbox/context: nix, devenv, ficus-scorer);
 * a Cloudflare container application backs exactly one Durable Object class.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { ScorerBinary } from "./scorer-binary.ts";

const props = Effect.gen(function* () {
  const scorer = yield* ScorerBinary;

  return {
    context: `${import.meta.dirname}/context`,
    // A root's devenv shell plus its checks: nix needs the disk and memory
    // the basic tier does not have.
    instanceType: "standard-1" as const,
    maxInstances: 20,
    observability: { logs: { enabled: true } },
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
