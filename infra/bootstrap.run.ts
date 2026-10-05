// The bootstrap stack: the pipeline's credentials, as code (alchemy's CI
// guide; the same shape as Expanse's).
//
// It mints the Cloudflare API token the deploy workflow uses, scoped to what
// the Ficus stack touches and nothing else, and writes it and the account id
// into the repository's Actions secrets. It also writes the variable that arms
// the deploys, so this stack IS the switch.
//
// It is the one deploy that runs from a shell, once, under a credential that
// can create API tokens (Account > API Tokens > Write): CI's own token must
// not be able to mint tokens. It also needs GITHUB_TOKEN (or `gh auth login`)
// with admin on the repository, to write its secrets.
//
//   bun run plan:bootstrap        read-only; proves it evaluates
//   bun run deploy:bootstrap      --stage bootstrap
//
// Re-run to rotate: a changed policy replaces the CI token and the secret
// follows. Remote state, on purpose: the minted token's id lives in it, and a
// fresh local state on the next rotation would orphan the old token rather
// than delete it.
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import { REPOSITORY, secret, variable } from "./src/github.ts";
import { deployPolicy } from "./src/permissions.ts";

export default Alchemy.Stack(
  "FicusBootstrap",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;

    if (stage !== "bootstrap") {
      return yield* Effect.die(new Error(`the bootstrap stack deploys to the 'bootstrap' stage only, not '${stage}'`));
    }

    const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");

    // What deploying the stacks needs, and nothing else (src/permissions.ts).
    const ci = yield* Cloudflare.ApiToken.AccountApiToken("CiToken", {
      name: "ficus-ci",
      accountId,
      policies: [deployPolicy(accountId)],
    });

    // What the deployed web UI holds at runtime to show an operation's trace:
    // read access to Workers Observability and nothing else, so the token
    // inside a running Worker is not the one that deploys Workers.
    const traces = yield* Cloudflare.ApiToken.AccountApiToken("ObservabilityReadToken", {
      name: "ficus-observability-read",
      accountId,
      policies: [
        {
          effect: "allow",
          permissionGroups: ["Workers Observability Read"],
          resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
        },
      ],
    });

    yield* secret("CloudflareApiToken", "CLOUDFLARE_API_TOKEN", ci.value);
    yield* secret("ObservabilityReadToken", "FICUS_OBSERVABILITY_TOKEN", traces.value);
    yield* secret("CloudflareAccountId", "CLOUDFLARE_ACCOUNT_ID", Redacted.make(accountId));

    // The switch: deploy.yml's jobs skip unless this reads `true`.
    yield* variable("DeploysEnabled", "FICUS_DEPLOYS_ENABLED", "true");

    return { repository: REPOSITORY, ciTokenId: ci.tokenId.as<string>() };
  }),
);
