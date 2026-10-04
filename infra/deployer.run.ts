// The deployer stack: `ficus-deployer-<stage>`, the sandbox the Deploy
// Workflow (src/deploys) runs a release's `[deploy]` in. The scoring sandbox's
// code and image (src/sandbox/stack.ts) as a Worker of its own, in a stack of
// its own, so that deploying the Ficus stack (which replaces the scoring
// sandbox's Worker and resets its Durable Objects) never cuts off the
// container running that deploy.
//
// Once a release's `[deploy] run` has deployed the Ficus stack, the Workflow
// asks the scoring sandbox to run `[deploy] deployer`, which deploys this
// stack: neither deploy replaces the Worker it runs in.
//
//   bun run plan:deployer | deploy:deployer      STAGE defaults to dev
//
// Deploy it before the Ficus stack on a stage with FICUS_DEPLOYS=true: the
// deploys Worker binds this one by reference.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Command from "alchemy/Command";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { sandboxWorker } from "./src/sandbox/stack.ts";

export default Alchemy.Stack(
  "FicusDeployer",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), Command.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const deployer = yield* sandboxWorker("deployer");

    return { deployer: deployer.workerName };
  }),
);
