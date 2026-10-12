/**
 * Signing in with Cloudflare: Ficus is an OAuth client of Cloudflare, created
 * on Ficus's account (scripts or dashboard). A self-managed client may not ask
 * for `openid` (Cloudflare drops it from the client and refuses it at sign-in),
 * so Ficus signs in with plain OAuth: the endpoints are given rather than
 * discovered (Better Auth adds `openid` to any provider whose discovery
 * document signs ID tokens, as Cloudflare's does), and who you are comes from
 * Cloudflare's user API (`user-details.read`). Ficus
 * also asks for your account memberships and Workers AI, so the agents you
 * start can run on an account of yours, billed to it.
 */
import type { GenericOAuthConfig, GenericOAuthUserInfo } from "better-auth/plugins";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

/** A Cloudflare OAuth client: its id is plain, its secret comes from the Secrets Store (src/api/worker.ts). */
export interface CloudflareApp {
  readonly clientId: string;
  readonly clientSecret: string;
}

export const CLOUDFLARE_PROVIDER = "cloudflare";

/** From https://dash.cloudflare.com/.well-known/openid-configuration. */
const AUTHORIZATION = "https://dash.cloudflare.com/oauth2/auth";

const TOKEN = "https://dash.cloudflare.com/oauth2/token";

const API_USER = "https://api.cloudflare.com/client/v4/user";

/** Who you are, the accounts you belong to, Workers AI on them, and a refresh token to keep it working. */
export const CLOUDFLARE_SCOPES = ["offline_access", "user-details.read", "memberships.read", "ai.read", "ai.write"];

/** Cloudflare's `GET /client/v4/user`, as far as Ficus reads it. */
const ApiUser = Schema.Struct({
  result: Schema.Struct({
    id: Schema.String,
    email: Schema.String,
    first_name: Schema.optional(Schema.NullOr(Schema.String)),
    last_name: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

const decodeUser = Schema.decodeUnknownOption(Schema.fromJsonString(ApiUser));

/** The part of `fetch` reading a Cloudflare endpoint needs. */
export type Fetcher = (url: string, init: { readonly headers: Record<string, string> }) => Promise<Response>;

/** A name from Cloudflare's profile, or the email's local part when it has none. */
const nameOf = (email: string, first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter((part) => part !== null && part !== undefined && part !== "").join(" ") || (email.split("@")[0] ?? email);

/** The signed-in person, from Cloudflare's user API; null when it does not answer, which Better Auth turns into a failed sign-in. */
export const cloudflareUser = async (accessToken: string | undefined, fetcher: Fetcher = fetch): Promise<GenericOAuthUserInfo | null> => {
  if (accessToken === undefined) {
    return null;
  }

  const response = await fetcher(API_USER, { headers: { authorization: `Bearer ${accessToken}` } });
  const user = response.ok ? decodeUser(await response.text()) : Option.none();

  if (Option.isNone(user)) {
    return null;
  }

  const { id, email, first_name: first, last_name: last } = user.value.result;

  return { id, email, name: nameOf(email, first, last), emailVerified: true };
};

/** Better Auth's generic OAuth provider for Cloudflare. */
export const cloudflareProvider = (app: CloudflareApp): GenericOAuthConfig => ({
  providerId: CLOUDFLARE_PROVIDER,
  name: "Cloudflare",
  authorizationUrl: AUTHORIZATION,
  tokenUrl: TOKEN,
  clientId: app.clientId,
  clientSecret: app.clientSecret,
  scopes: CLOUDFLARE_SCOPES,
  pkce: true,
  authentication: "post",
  getUserInfo: (tokens) => cloudflareUser(tokens.accessToken),
});
