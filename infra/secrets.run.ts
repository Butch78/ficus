// A stage's secrets, kept in the account's Cloudflare Secrets Store so the
// stacks that use them bind them by reference and never need their values:
// a deploy run from a sandbox (Ficus deploying itself) has nothing secret to
// hand over.
//
//   the deploy token     the Cloudflare API token a stage's Deploy Workflow
//                        deploys with (src/deploys); Egress adds it to the
//                        deploy sandbox's API calls
//
//   STAGE=prod bun run deploy:secrets
//       mints `ficus-deploy-<stage>`, scoped to what deploying Ficus needs
//       (src/permissions.ts); needs a credential that can create API tokens
//   STAGE=pr-1 FICUS_DEPLOY_TOKEN=... bun run deploy:secrets
//       keeps the token given instead (a narrower one, for a test stage)
//
//   the GitHub client secret   the stage's GitHub OAuth app's (sign in with
//                        GitHub, src/api/auth.ts); kept when
//                        FICUS_GITHUB_CLIENT_SECRET is given. Give it on every
//                        run once set: a run without it removes the secret.
//                        The Api binds it when its deploy has FICUS_GITHUB_CLIENT_ID.
//
// Run from an operator's shell, once per stage; re-run to rotate.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { deployPolicy } from "./src/permissions.ts";

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

    const given = yield* Config.option(Config.Redacted("FICUS_DEPLOY_TOKEN"));
    let value = given.pipe(Option.getOrUndefined);

    if (value === undefined) {
      const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");

      const minted = yield* Cloudflare.ApiToken.AccountApiToken("DeployApiToken", {
        name: `ficus-deploy-${stage}`,
        accountId,
        policies: [deployPolicy(accountId)],
      });

      value = minted.value;
    }

    const deployToken = yield* Cloudflare.SecretsStore.Secret("DeployToken", {
      store,
      name: `ficus-deploy-token-${stage}`,
      value,
      scopes: ["workers"],
      comment: `Ficus ${stage}: the token its Deploy Workflow deploys with`,
    });

    const githubClientSecret = yield* Config.option(Config.Redacted("FICUS_GITHUB_CLIENT_SECRET"));

    const github = yield* Option.match(githubClientSecret, {
      onNone: () => Effect.succeed(undefined),
      onSome: (value) =>
        Cloudflare.SecretsStore.Secret("GithubClientSecret", {
          store,
          name: `ficus-github-client-secret-${stage}`,
          value,
          scopes: ["workers"],
          comment: `Ficus ${stage}: its GitHub OAuth app's client secret, for signing in with GitHub`,
        }),
    });

    return { deployToken: deployToken.secretName, githubClientSecret: github?.secretName };
  }),
);
