/**
 * Ficus's Better Auth options: email sign-in, organizations (the tenants),
 * and API keys that act as sessions (agents, CLIs, scripts).
 *
 * One function for the Worker and for `scripts/auth-schema.ts`, which
 * compiles the D1 migration from these same options: the schema and the
 * plugins that need it cannot drift apart.
 */
import { apiKey } from "@better-auth/api-key";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { organization } from "better-auth/plugins";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";

export const AUTH_BASE_PATH = "/api/auth";

/** The header an API key travels in. */
export const API_KEY_HEADER = "x-api-key";

export const authOptions = (database: BetterAuthOptions["database"], secret: string, baseURL: string) =>
  ({
    database,
    secret,
    baseURL,
    basePath: AUTH_BASE_PATH,
    emailAndPassword: { enabled: true },
    plugins: [
      organization(),
      // A key's session is its owner's: one path (getSession) for browsers
      // and keys alike.
      apiKey({ enableSessionForAPIKeys: true, apiKeyHeaders: [API_KEY_HEADER] }),
    ],
  }) satisfies BetterAuthOptions;

const build = (database: BetterAuthOptions["database"], secret: string, baseURL: string) =>
  betterAuth(authOptions(database, secret, baseURL));

export type AuthInstance = ReturnType<typeof build>;

/** The Better Auth instance, as a service handlers yield. */
export class Auth extends Context.Service<Auth, AuthInstance>()("@ficus/Auth") {}

/** One instance per isolate: its database and secret are fixed for its life. */
let isolateInstance: AuthInstance | undefined;

export const layer = (database: BetterAuthOptions["database"], secret: string, baseURL: string) =>
  Layer.sync(Auth, () => {
    isolateInstance ??= build(database, secret, baseURL);

    return isolateInstance;
  });
