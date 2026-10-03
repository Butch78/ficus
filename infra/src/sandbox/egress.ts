/**
 * Egress: the only way out of a sandbox or workspace container.
 *
 * The container runs with the internet off. Its Durable Object routes each
 * host it permits through this Worker's own default export, called with
 * props that say what the host may be used for (worker.ts). HTTPS arrives
 * decrypted: Cloudflare's sidecar terminates it with an ephemeral CA the
 * container trusts.
 *
 * - `pass`:      forward unchanged (nix and devenv caches)
 * - `deny`:      refuse (a host revoked for the check phase)
 * - `artifacts`: forward only requests for the listed repos, adding each
 *                repo's own token. The container never holds a token, so it
 *                cannot reach any other repo or keep access after the route
 *                is revoked. Scoring and a workspace list one repo; a rebase
 *                lists two: the behind attempt to read and the fresh one to push.
 */
import * as Schema from "effect/Schema";
import { isRepoRequest } from "./repo.ts";

export const RepoGrant = Schema.Struct({ repoPath: Schema.String, token: Schema.String });

export type RepoGrant = Schema.Schema.Type<typeof RepoGrant>;

export const EgressProps = Schema.Union([
  Schema.Struct({ mode: Schema.Literal("pass") }),
  Schema.Struct({ mode: Schema.Literal("deny") }),
  Schema.Struct({ mode: Schema.Literal("artifacts"), repos: Schema.Array(RepoGrant) }),
]);

export type EgressProps = Schema.Schema.Type<typeof EgressProps>;

export const refuse = (why: string) => new Response(`ficus sandbox egress: ${why}\n`, { status: 403 });

/** Forward, refuse, or authorize `request` as `props` says. */
export const egress = (props: EgressProps, request: Request): Promise<Response> => {
  const url = new URL(request.url);

  // One line per decision, for Workers Observability (never the token).
  console.log(`egress ${props.mode} ${request.method} ${url.host}${url.pathname}`);

  switch (props.mode) {
    case "pass": {
      return fetch(request);
    }

    case "deny": {
      return Promise.resolve(refuse(`${url.host} is closed in this phase`));
    }

    case "artifacts": {
      const grant = props.repos.find((repo) => isRepoRequest(url.pathname, repo.repoPath));

      if (grant === undefined) {
        return Promise.resolve(refuse(`${url.pathname} is not one of this sandbox's repos`));
      }

      const authorized = new Request(request);

      authorized.headers.set("authorization", `Bearer ${grant.token}`);

      return fetch(authorized);
    }
  }
};
