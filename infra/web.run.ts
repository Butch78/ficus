// The web UI stack: src/web, a vinext app (Next.js's App Router on Vite) on
// Workers, in front of the Ficus stack's Api.
//
//   Web   src/web   sign in, organizations, trees (tasks -> attempts -> accepted),
//                   each attempt's state and scoring report, and its repo
//                   (history, directories, files) read through Artifacts
//
// A stack of its own, deployed after alchemy.run.ts to the same stage: it
// binds that stage's Api by reference, so the UI reaches the Api over a
// service binding (the browser only ever talks to the UI's origin; see
// src/web/lib/api.ts) and the two deploy, and fail, separately.
//
//   bun run plan:web | deploy:web | destroy:web        STAGE defaults to dev
import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as GitHub from "alchemy/GitHub";
import * as Output from "alchemy/Output";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { OWNER, REPO } from "./src/github.ts";
import { COMPATIBILITY, OBSERVABILITY } from "./src/platform.ts";

export default Alchemy.Stack(
  "FicusWeb",
  {
    providers: Layer.mergeAll(Cloudflare.providers(), GitHub.providers()),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const { stage } = yield* Alchemy.Stack;

    // alchemy.run.ts's `Api`, as deployed to this same stage.
    const api = yield* Cloudflare.Worker.ref("Api", { stack: "Ficus", stage });

    // Reads Workers Observability, so the UI can show an operation's trace
    // (src/web/lib/trace.ts). Optional: without it the activity panel says
    // tracing is not configured. Read-only by intent: bootstrap.run.ts mints
    // one with Workers Observability Read and nothing else.
    const observabilityToken = yield* Config.option(Config.Redacted("FICUS_OBSERVABILITY_TOKEN"));
    const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");

    const web = yield* Cloudflare.Website.Vinext("Web", {
      name: `ficus-web-${stage}`,
      rootDir: `${import.meta.dirname}/src/web`,
      compatibility: COMPATIBILITY,
      observability: OBSERVABILITY,
      env: {
        API: api,
        CLOUDFLARE_ACCOUNT_ID: accountId,
        // A secret when configured; an empty plain value (read as "not
        // configured") otherwise.
        FICUS_OBSERVABILITY_TOKEN: Option.getOrElse(observabilityToken, () => ""),
      },
    });

    // A pull request's preview stage says where it lives, on the pull request:
    // the UI first, since that is what a reviewer opens. The logical id is
    // stable, so each push edits the same comment.
    const pullRequest = yield* Config.option(Config.Int("PULL_REQUEST"));

    if (Option.isSome(pullRequest)) {
      yield* GitHub.Comment("PreviewComment", {
        owner: OWNER,
        repository: REPO,
        issueNumber: pullRequest.value,
        body: Output.interpolate`## 🌿 Ficus preview: \`${stage}\`

UI: ${web.url}
API: ${api.url}

Deployed from this pull request by \`deploy.yml\`; destroyed when it closes. Sign up on the UI, create an organization, and init a tree from any public HTTPS git remote to browse it.`,
      });
    }

    return { web: web.url.as<string>() };
  }),
);
