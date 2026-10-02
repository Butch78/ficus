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
 * - `artifacts`: forward only requests for one repo, adding its token. The
 *                container never holds the token, so it cannot reach any
 *                other repo or keep access after the sandbox revokes it.
 */
import { WorkerEntrypoint } from "cloudflare:workers";
import * as Schema from "effect/Schema";
import { isRepoRequest } from "./repo.ts";

export const EgressProps = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("pass") }),
  Schema.Struct({ mode: Schema.Literal("deny") }),
  Schema.Struct({ mode: Schema.Literal("artifacts"), repoPath: Schema.String, token: Schema.String }),
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

        if (!isRepoRequest(pathname, props.repoPath)) {
          return Promise.resolve(refuse(`${pathname} is not this sandbox's repo`));
        }

        const authorized = new Request(request);

        authorized.headers.set("authorization", `Bearer ${props.token}`);

        return fetch(authorized);
      }
    }
  }
}
