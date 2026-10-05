/**
 * `Egress`: the only way out of a sandbox container.
 *
 * The container runs with the internet off. The sandbox Durable Object
 * routes each host it permits through this entrypoint, with props that say
 * what that host may be used for. HTTPS arrives decrypted: Cloudflare's
 * sidecar terminates it with an ephemeral CA the container trusts.
 *
 * - `pass`:      forward unchanged (nix and devenv caches while preparing)
 * - `deny`:      refuse (a host revoked for the check phase)
 * - `artifacts`: forward only requests for the listed repos, adding each
 *                repo's own token. The container never holds a token, so it
 *                cannot reach any other repo or keep access after the
 *                sandbox revokes it. Scoring lists one repo; a rebase
 *                lists two: the behind attempt to read and the fresh one to push.
 * - `cloudflare`: the Cloudflare API, for a deploy: forward, with the deploy
 *                token in place of the container's placeholder; credentials
 *                the API issued mid-deploy (asset upload JWTs) pass as sent.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import { withDeployToken } from "./deploy-token.ts";
import { isRepoRequest } from "./repo.ts";

export const RepoGrant = Schema.Struct({ repoPath: Schema.String, token: Schema.String });

export type RepoGrant = Schema.Schema.Type<typeof RepoGrant>;

export const EgressProps = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("pass") }),
  Schema.Struct({ mode: Schema.Literal("deny") }),
  Schema.Struct({ mode: Schema.Literal("artifacts"), repos: Schema.Array(RepoGrant) }),
  Schema.Struct({ mode: Schema.Literal("cloudflare"), token: Schema.String }),
]);

export type EgressProps = Schema.Schema.Type<typeof EgressProps>;

const refuse = (why: string) => new Response(`ficus sandbox egress: ${why}\n`, { status: 403 });

export class Egress extends WorkerEntrypoint<object, EgressProps> {
  override fetch(request: Request): Promise<Response> {
    const props = this.ctx.props;

    // One line per decision, for Workers Observability (never the token).
    console.log(`egress ${props.mode} ${request.method} ${new URL(request.url).host}${new URL(request.url).pathname}`);

    switch (props.mode) {
      case "pass": {
        return fetch(request);
      }

      case "deny": {
        return Promise.resolve(refuse(`${new URL(request.url).host} is closed in this phase`));
      }

      case "artifacts": {
        const { pathname } = new URL(request.url);
        const grant = props.repos.find((repo) => isRepoRequest(pathname, repo.repoPath));

        if (grant === undefined) {
          return Promise.resolve(refuse(`${pathname} is not one of this sandbox's repos`));
        }

        const authorized = new Request(request);

        authorized.headers.set("authorization", `Bearer ${grant.token}`);

        return fetch(authorized);
      }

      case "cloudflare": {
        // The container holds a placeholder, swapped here: the token never reaches it.
        const authorized = new Request(request);
        const sent = request.headers.get("authorization");
        const authorization = withDeployToken(sent, props.token);

        if (authorization !== null) {
          authorized.headers.set("authorization", authorization);
        }

        console.log(`egress cloudflare: ${authorization === sent ? "credentials as sent" : "deploy token added"}`);

        return fetch(authorized);
      }
    }
  }
}
