/**
 * `Deploy`: the Workflow that deploys a node once its tree releases it. The
 * tree starts one instance per release (src/tree, `POST /trees/<t>/release`)
 * with the node's repo and commit, and reads the instance's status when it
 * is asked how its deploys went. Nothing calls the tree back.
 *
 * Each durable step mints a short-lived read token for the node's repo, asks
 * a sandbox (src/sandbox, `POST /deploy`) to run part of the released
 * commit's own `[deploy]` with the Cloudflare API open, and revokes the
 * token. Step `deploy` runs `run` in the deployer (deployer.run.ts); once it
 * passed, step `deployer` runs `deployer`, when there is one, in a scoring
 * sandbox. So a root that deploys Ficus never replaces the Worker its
 * container runs under: `run` replaces the scoring sandbox's, `deployer` the
 * deployer's. The deploy token stays here and in Egress: the container sees
 * a placeholder. A sandbox that fails is retried; a deploy command that
 * fails is an answer, not retried: running it again would not change it.
 */
import type * as cf from "@cloudflare/workers-types";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { DeployOutcome, type DeployPart, DeployParams, DeployReport } from "../core/deploy.ts";
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
    // The token the root's `[deploy]` deploys with, from the Secrets Store by
    // reference (secrets.run.ts): deploying this stack never needs its value.
    const deployToken = yield* Cloudflare.SecretsStore.ReadSecret(yield* Cloudflare.SecretsStore.Secret.ref("DeployToken", { stack: "FicusSecrets" }));
    // The account it deploys into.
    const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");

    /** Where each part runs: a Durable Object namespace the deploys Worker binds by name (worker.ts). */
    const BINDINGS = { run: "DEPLOYER", deployer: "SANDBOX" } as const satisfies Record<DeployPart, string>;

    const sandboxes = Effect.fn("Deploy.sandboxes")(function* (part: DeployPart) {
      const env = yield* Cloudflare.Workers.WorkerEnvironment;
      const namespace: cf.DurableObjectNamespace | undefined = env[BINDINGS[part]];

      return namespace === undefined ? yield* Effect.die(new Error(`the deploys Worker has no ${BINDINGS[part]} binding`)) : namespace;
    });

    const deployOnce = Effect.fn("Deploy.once")(function* (params: DeployParams, part: DeployPart) {
      const repo = yield* artifacts.get(params.repo).pipe(Effect.mapError((error) => failed(`reading repo ${params.repo}: ${error.message}`)));

      const info = yield* Effect.tryPromise({ try: () => repo.raw.info(), catch: (cause) => failed(`reading repo ${params.repo}: ${String(cause)}`) }).pipe(
        Effect.flatMap((raw) => Schema.decodeUnknownEffect(RepoInfo)(raw).pipe(Effect.mapError((issue) => failed(`repo ${params.repo}'s info: ${issue.message}`)))),
      );

      const token = yield* repo.createToken("read", READ_TOKEN_TTL_SECS).pipe(Effect.mapError((error) => failed(`minting a read token: ${error.message}`)));
      const cloudflareToken = yield* deployToken.pipe(Effect.mapError((error) => failed(`reading the deploy token: ${error.message}`)));
      const namespace = yield* sandboxes(part);
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
              part,
              account_id: accountId,
              cloudflare_token: Redacted.value(cloudflareToken),
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

    const step = (name: string, input: DeployParams, part: DeployPart) =>
      Cloudflare.Workflows.task(name, deployOnce(input, part), {
        retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
        // Past a cold devenv build and the root's own deploy timeout (scoring.ts DEFAULT_DEPLOY_TIMEOUT_SECS).
        timeout: "1 hour",
      });

    return Effect.fn("Deploy.run")(function* (input: DeployParams) {
      const ran = yield* step("deploy", input, "run");

      if (!ran.deployed || !ran.passed) {
        return DeployOutcome.make(ran);
      }

      const deployer = yield* step("deployer", input, "deployer");

      // A root with no `deployer` (any but Ficus's own) has nothing more to say.
      return DeployOutcome.make(deployer.deployed ? { ...ran, deployer } : ran);
    });
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- alchemy's binding layers, provided where the Workflow is declared
  }).pipe(Effect.provide(Layer.mergeAll(Cloudflare.Artifacts.ReadNamespaceBinding, Cloudflare.SecretsStore.ReadSecretBinding))),
) {}
