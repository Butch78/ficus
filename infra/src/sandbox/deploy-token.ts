/**
 * The deploy token's stand-in. A deploy's container gets this as its
 * `CLOUDFLARE_API_TOKEN`; Egress (`cloudflare` mode) swaps it for the real
 * token on the way out, so the token never reaches the container.
 */
export const TOKEN_PLACEHOLDER = "ficus-egress-adds-the-deploy-token";

/**
 * The `authorization` a request to the Cloudflare API leaves with: the deploy
 * token in place of the placeholder. Any other credential passes unchanged:
 * the API hands out its own short-lived ones mid-deploy (the JWT a Worker's
 * asset upload session answers with), and those reach no further than the
 * token that got them.
 */
export const withDeployToken = (authorization: string | null, token: string): string | null =>
  authorization === `Bearer ${TOKEN_PLACEHOLDER}` ? `Bearer ${token}` : authorization;
