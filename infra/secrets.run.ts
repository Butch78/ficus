// A stage's secrets, kept in the account's Cloudflare Secrets Store so the
// stacks that use them bind them by reference and never need their values:
// a deploy run from a sandbox (Ficus deploying itself) has nothing secret to
// hand over.
//
//   FICUS_DEPLOY_TOKEN   the Cloudflare API token a stage's Deploy Workflow
//                        deploys with (src/deploys); Egress adds it to the
//                        deploy sandbox's API calls
//
//   STAGE=<stage> FICUS_DEPLOY_TOKEN=... bun run deploy:secrets
//
// Run from an operator's shell, once per stage and again to rotate.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";

export default Alchemy.Stack(
  "FicusSecrets",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;
    // The account has one Secrets Store; this adopts it and never deletes it.
    const store = yield* Cloudflare.SecretsStore.Store("Store");

    const deployToken = yield* Cloudflare.SecretsStore.Secret("DeployToken", {
      store,
      name: `ficus-deploy-token-${stage}`,
      value: yield* Config.Redacted("FICUS_DEPLOY_TOKEN"),
      scopes: ["workers"],
      comment: `Ficus ${stage}: the token its Deploy Workflow deploys with`,
    });

    return { deployToken: deployToken.secretName };
  }),
);
