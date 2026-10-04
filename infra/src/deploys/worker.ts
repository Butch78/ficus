/**
 * The `ficus-deploys` Worker, Effect-native: hosts the `Deploy` Workflow
 * (workflow.ts). No routes of its own: the tree starts and reads instances
 * through its `DEPLOYS` Workflow binding. The Workflow deploys a release in
 * the deployer's `Sandbox` objects (`DEPLOYER`, deployer.run.ts), then the
 * deployer itself from the scoring sandbox's (`SANDBOX`).
 *
 * Deployed only to a stage given a deploy token (alchemy.run.ts): a stage
 * without one has no way to deploy, and its tree releases without deploying.
 */
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { COMPATIBILITY, OBSERVABILITY } from "../platform.ts";
import { SandboxWorker } from "../sandbox/stack.ts";
import Deploy from "./workflow.ts";

export default class DeploysWorker extends Cloudflare.Worker<DeploysWorker>()(
  "Deploys",
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    // The same resource alchemy.run.ts yields.
    const sandbox = yield* SandboxWorker;
    // The deployer, from its own stack (deployer.run.ts), deployed first.
    const deployer = yield* Cloudflare.Worker.ref("Sandbox", { stack: "FicusDeployer", stage });

    return {
      name: `ficus-deploys-${stage}`,
      main: import.meta.url,
      compatibility: COMPATIBILITY,
      observability: OBSERVABILITY,
      workersDev: false,
      env: {
        // By literal name: `alchemy dev` cannot coerce a deploy-time Output into
        // a class's scriptName. The env value below is the edge that deploys
        // the sandbox Worker (and its class) before this one.
        SANDBOX: Cloudflare.DurableObject("SANDBOX", { className: "Sandbox", scriptName: `ficus-sandbox-${stage}` }),
        FICUS_SANDBOX_SCRIPT: sandbox.workerName,
        DEPLOYER: Cloudflare.DurableObject("DEPLOYER", { className: "Sandbox", scriptName: `ficus-deployer-${stage}` }),
        FICUS_DEPLOYER_SCRIPT: deployer.workerName,
      },
    };
  }),
  Effect.gen(function* () {
    yield* Deploy;

    return {
      fetch: Effect.succeed(HttpServerResponse.text("ficus deploys: started by the tree, not reached directly", { status: 404 })),
    };
  }),
) {}
