/**
 * `Deploy`: the Workflow that deploys a node once its tree releases it. The
 * tree starts one instance per release (src/tree, `POST /trees/<t>/release`)
 * with the node's repo and commit, and reads the instance's status when it
 * is asked how its deploys went. Nothing calls the tree back.
 *
 * One durable step: mint a short-lived read token for the node's repo, ask
 * a sandbox (src/sandbox, `POST /deploy`) to run the released commit's own
 * `[deploy]` with the Cloudflare API open, revoke the token. The deploy
 * token stays here and in Egress: the container sees a placeholder. A
 * sandbox that fails is retried; a deploy command that fails is an answer,
 * not retried: running it again would not change it.
 */
import type * as cf from "@cloudflare/workers-types";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { DeployParams, DeployReport } from "../core/deploy.ts";
import { artifactsNamespace } from "../platform.ts";

/** How long the sandbox may read the node's repo: the deploy clones it first thing. */
const READ_TOKEN_TTL_SECS = 3600;

/** The part of a repo's info a deploy needs: where to clone it. */
const RepoInfo = Schema.Struct({ remote: Schema.String });

/** A step's failure, retried by the Workflow until its retries run out. */
export class DeployFailed extends Schema.TaggedError<DeployFailed>()("Deploy.Failed", { message: Schema.String }) {}

const failed = (message: string) => new DeployFailed({ message });

export default class Deploy extends Cloudflare.Workflow<Deploy>()(
  "Deploy",
  Effect.gen(function* () {
    const artifacts = yield* Cloudflare.Artifacts.ReadNamespace(yield* artifactsNamespace);
    // Bound as secrets at deploy time: the account the root's `[deploy]` deploys into, and the token for it.
    const deployToken = yield* Config.Redacted("FICUS_DEPLOY_TOKEN");
    const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");

    /** The sandbox Durable Object namespace the deploys Worker binds by name (worker.ts). */
    const sandboxes = Effect.gen(function* () {
      const env = yield* Cloudflare.Workers.WorkerEnvironment;
      const namespace: cf.DurableObjectNamespace | undefined = env["SANDBOX"];

      return namespace === undefined ? yield* Effect.die(new Error("the deploys Worker has no SANDBOX binding")) : namespace;
    });

    const deployOnce = Effect.fn("Deploy.once")(function* (params: DeployParams) {
      const repo = yield* artifacts.get(params.repo).pipe(Effect.mapError((error) => failed(`reading repo ${params.repo}: ${error.message}`)));

      const info = yield* Effect.tryPromise({ try: () => repo.raw.info(), catch: (cause) => failed(`reading repo ${params.repo}: ${String(cause)}`) }).pipe(
        Effect.flatMap((raw) => Schema.decodeUnknownEffect(RepoInfo)(raw).pipe(Effect.mapError((issue) => failed(`repo ${params.repo}'s info: ${issue.message}`)))),
      );

      const token = yield* repo.createToken("read", READ_TOKEN_TTL_SECS).pipe(Effect.mapError((error) => failed(`minting a read token: ${error.message}`)));
      const namespace = yield* sandboxes;
      const sandbox = namespace.get(namespace.idFromName(`deploy:${params.tree}`));

      const answer = yield* Effect.tryPromise({
        try: async () => {
          const response = await sandbox.fetch("http://sandbox/deploy", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              remote: info.remote,
              token: token.plaintext,
              commit: params.commit,
              account_id: accountId,
              cloudflare_token: Redacted.value(deployToken),
            }),
          });

          return { status: response.status, text: await response.text() };
        },
        catch: (cause) => failed(`the sandbox did not answer: ${String(cause)}`),
      }).pipe(Effect.ensuring(repo.revokeToken(token.id).pipe(Effect.ignore)));

      if (answer.status !== 200) {
        return yield* failed(`the sandbox answered ${answer.status}: ${answer.text}`);
      }

      return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(DeployReport))(answer.text).pipe(
        Effect.mapError((issue) => failed(`the sandbox's report is unreadable: ${issue.message}`)),
      );
    });

    return Effect.fn("Deploy.run")(function* (input: DeployParams) {
      return yield* Cloudflare.Workflows.task("deploy", deployOnce(input), {
        retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
        // Past a cold devenv build and the root's own deploy timeout (scoring.ts DEFAULT_DEPLOY_TIMEOUT_SECS).
        timeout: "1 hour",
      });
    });
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- alchemy's binding layer, provided where the Workflow is declared
  }).pipe(Effect.provide(Cloudflare.Artifacts.ReadNamespaceBinding)),
) {}
