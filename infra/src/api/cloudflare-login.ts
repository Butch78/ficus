/**
 * Signing in with Cloudflare: Cloudflare is an OpenID Connect provider
 * (https://dash.cloudflare.com/.well-known/openid-configuration), and Ficus is
 * an OAuth client of it, created on Ficus's account (scripts or dashboard).
 * Besides who you are, Ficus asks for your account memberships and Workers AI,
 * so the agents you start can run on an account of yours, billed to it.
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

const DISCOVERY = "https://dash.cloudflare.com/.well-known/openid-configuration";

const USERINFO = "https://dash.cloudflare.com/oauth2/userinfo";

const API_USER = "https://api.cloudflare.com/client/v4/user";

/** Who you are, the accounts you belong to, Workers AI on them, and a refresh token to keep it working. */
export const CLOUDFLARE_SCOPES = ["openid", "offline_access", "user-details.read", "memberships.read", "ai.read", "ai.write"];

/** OpenID's userinfo, as far as Ficus reads it. */
const OpenIdUser = Schema.Struct({
  sub: Schema.String,
  email: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});

/** Cloudflare's `GET /client/v4/user`, as far as Ficus reads it: where userinfo says no email. */
const ApiUser = Schema.Struct({
  result: Schema.Struct({
    id: Schema.String,
    email: Schema.String,
    first_name: Schema.optional(Schema.NullOr(Schema.String)),
    last_name: Schema.optional(Schema.NullOr(Schema.String)),
  }),
});

/** The part of `fetch` reading a Cloudflare endpoint needs. */
export type Fetcher = (url: string, init: { readonly headers: Record<string, string> }) => Promise<Response>;

const readJson = async (fetcher: Fetcher, url: string, accessToken: string) => {
  const response = await fetcher(url, { headers: { authorization: `Bearer ${accessToken}` } });

  return response.ok ? response.text() : undefined;
};

/** A name from Cloudflare's profile, or the email's local part when it has none. */
const nameOf = (email: string, first: string | null | undefined, last: string | null | undefined) =>
  [first, last].filter((part) => part !== null && part !== undefined && part !== "").join(" ") || (email.split("@")[0] ?? email);

/**
 * The signed-in person, from OpenID's userinfo when it carries an email, else
 * from Cloudflare's user API (the `user-details.read` scope); null when
 * neither answers, which Better Auth turns into a failed sign-in.
 */
export const cloudflareUser = async (accessToken: string | undefined, fetcher: Fetcher = fetch): Promise<GenericOAuthUserInfo | null> => {
  if (accessToken === undefined) {
    return null;
  }

  const openId = Option.flatMap(Option.fromUndefinedOr(await readJson(fetcher, USERINFO, accessToken)), Schema.decodeUnknownOption(Schema.fromJsonString(OpenIdUser)));

  if (Option.isSome(openId) && openId.value.email !== undefined) {
    const { sub, email, name } = openId.value;

    return { id: sub, email, name: name ?? nameOf(email, undefined, undefined), emailVerified: true };
  }

  const api = Option.flatMap(Option.fromUndefinedOr(await readJson(fetcher, API_USER, accessToken)), Schema.decodeUnknownOption(Schema.fromJsonString(ApiUser)));

  if (Option.isNone(api)) {
    return null;
  }

  const { id, email, first_name: first, last_name: last } = api.value.result;

  return { id: Option.isSome(openId) ? openId.value.sub : id, email, name: nameOf(email, first, last), emailVerified: true };
};

/** Better Auth's generic OAuth provider for Cloudflare. */
export const cloudflareProvider = (app: CloudflareApp): GenericOAuthConfig => ({
  providerId: CLOUDFLARE_PROVIDER,
  name: "Cloudflare",
  discoveryUrl: DISCOVERY,
  clientId: app.clientId,
  clientSecret: app.clientSecret,
  scopes: CLOUDFLARE_SCOPES,
  pkce: true,
  authentication: "post",
  getUserInfo: (tokens) => cloudflareUser(tokens.accessToken),
});
