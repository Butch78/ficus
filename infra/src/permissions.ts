/**
 * What deploying the Ficus stacks needs of the Cloudflare API, and nothing
 * else: the CI token (bootstrap.run.ts) and a stage's deploy token
 * (secrets.run.ts) are minted with it. Artifacts is absent on purpose: a
 * namespace is a binding, created by the runtime, so deploying it makes no
 * Artifacts API call.
 */
import type * as Cloudflare from "alchemy/Cloudflare";

export const DEPLOY_PERMISSIONS: Array<Cloudflare.ApiToken.PermissionGroupName> = [
  "Workers Scripts Write", // the Workers, their Durable Objects and Workflows
  "Workers KV Storage Write", // the alchemy state store's index
  "Workers R2 Storage Write", // the alchemy state store's bucket, and the backups bucket
  "Secrets Store Write", // Cloudflare.state() binds the store's bearer each run; the deploy token's secret
  "Workers Containers Write", // the sandbox's container application and image
  "Workers Observability Write", // logs and traces on every Worker
  "D1 Write", // the accounts database and its migrations
  "Workers Tail Read", // deploy-time log streaming
  "Account Settings Write", // the workers.dev subdomain lookup
];

/** The one policy a deploy token carries: those permissions, on the one account. */
export const deployPolicy = (accountId: string): Cloudflare.ApiToken.Policy => ({
  effect: "allow",
  permissionGroups: [...DEPLOY_PERMISSIONS],
  resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
});
