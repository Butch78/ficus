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
import { genericOAuth, organization } from "better-auth/plugins";
import { CLOUDFLARE_PROVIDER, cloudflareProvider, type CloudflareApp } from "./cloudflare-login.ts";
import { type Mailer, verificationMail } from "./mail.ts";
import { kvSessions, type SessionKv } from "./sessions.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export const AUTH_BASE_PATH = "/api/auth";

/** The header an API key travels in. */
export const API_KEY_HEADER = "x-api-key";

/** A GitHub OAuth app, for signing in with GitHub; a stage has one once its credentials are set (src/api/worker.ts). */
export interface GitHubApp {
  readonly clientId: string;
  readonly clientSecret: string;
}

/** The OAuth apps a stage signs people in with, besides email: each absent until the stage has its credentials. */
export interface SignInApps {
  readonly github: GitHubApp | undefined;
  readonly cloudflare: CloudflareApp | undefined;
}

const NO_APPS: SignInApps = { github: undefined, cloudflare: undefined };

/**
 * Where the stage can send mail (mail.ts), an email address must be confirmed
 * before it signs in: sign-up sends the link, and so does signing in while
 * unconfirmed; following it signs you in. Better Auth joins a Cloudflare or
 * GitHub sign-in to an existing account only once that account's address is
 * confirmed, so without this they would be refused. A stage that cannot send
 * leaves addresses unconfirmed.
 */
const verification = (mail: Mailer | undefined) =>
  mail === undefined
    ? {}
    : {
        emailVerification: {
          sendOnSignUp: true,
          sendOnSignIn: true,
          autoSignInAfterVerification: true,
          sendVerificationEmail: ({ user, url }: { readonly user: { readonly email: string }; readonly url: string }) => mail(verificationMail(user.email, url)),
        },
      };

/** What a stage may have besides its database: a way to send mail (mail.ts), and KV for sessions (sessions.ts). */
export interface StageServices {
  readonly mail?: Mailer | undefined;
  readonly sessions?: SessionKv | undefined;
}

/** How long a session is trusted from its signed cookie before it is looked up again (seconds). */
const SESSION_COOKIE_CACHE_SECONDS = 5 * 60;

/**
 * Where the stage has KV, sessions are read from it (sessions.ts) and kept in
 * D1 too; verification values stay in D1 and rate limits in memory, which a
 * secondary storage would otherwise take.
 */
const sessionStorage = (sessions: SessionKv | undefined) =>
  sessions === undefined
    ? {}
    : {
        secondaryStorage: kvSessions(sessions),
        verification: { storeInDatabase: true },
        rateLimit: { storage: "memory" as const },
      };

export const authOptions = (database: BetterAuthOptions["database"], secret: string, baseURL: string, apps: SignInApps = NO_APPS, services: StageServices = {}) => {
  const { mail, sessions } = services;
  const { github, cloudflare } = apps;
  // Cloudflare, through Better Auth's generic OAuth plugin (cloudflare-login.ts), where the stage has its client.
  const cloudflareLogin = cloudflare === undefined ? [] : [genericOAuth({ config: [cloudflareProvider(cloudflare)] })];

  return {
    database,
    secret,
    baseURL,
    basePath: AUTH_BASE_PATH,
    emailAndPassword: { enabled: true, requireEmailVerification: mail !== undefined },
    ...verification(mail),
    ...sessionStorage(sessions),
    session: {
      // Written to D1 as well as KV, so D1 still lists them; read from KV.
      storeSessionInDatabase: true,
      // A signed copy of the session in a cookie: checking it needs no lookup until it is this old.
      cookieCache: { enabled: true, maxAge: SESSION_COOKIE_CACHE_SECONDS },
    },
    advanced: {
      // Better Auth reads the database's layout on each new instance (three D1 round trips) to check its tables;
      // migrations.test.ts checks the same before anything deploys.
      database: { validateSchema: false },
    },
    // GitHub sign-in where the stage has an OAuth app; its callback is <origin>/api/auth/callback/github.
    socialProviders: github === undefined ? {} : { github: { clientId: github.clientId, clientSecret: github.clientSecret } },
    account: {
      // Cloudflare's tokens run agents on the person's account: kept encrypted, never in the clear.
      encryptOAuthTokens: true,
      // Signing in with GitHub or Cloudflare as an email you already use joins that account.
      accountLinking: {
        enabled: true,
        trustedProviders: ["github", CLOUDFLARE_PROVIDER],
        // Connecting an account while signed in (Connect GitHub: link-social) may join one with another email: you
        // proved both, your session and the provider's own sign-in. Joining by email at sign-in still needs the same,
        // confirmed address, and the provider's email is not copied onto yours.
        allowDifferentEmails: true,
      },
    },
    plugins: [
      organization(),
      // A key's session is its owner's: one path (getSession) for browsers
      // and keys alike.
      apiKey({
        enableSessionForAPIKeys: true,
        apiKeyHeaders: [API_KEY_HEADER],
        // The plugin's default is 10 requests a day, which an agent spends in
        // seconds. 600 a minute is 10 a second per key.
        rateLimit: { enabled: true, timeWindow: 60_000, maxRequests: 600 },
      }),
      ...cloudflareLogin,
    ],
  } satisfies BetterAuthOptions;
};

const build = (database: BetterAuthOptions["database"], secret: string, baseURL: string, apps: SignInApps, services: StageServices) =>
  betterAuth(authOptions(database, secret, baseURL, apps, services));

export type AuthInstance = ReturnType<typeof build>;

/** The Better Auth instance, as a service handlers yield. */
export class Auth extends Context.Service<Auth, AuthInstance>()("@ficus/Auth") {}

/**
 * One instance per origin, per isolate. The database and secret are fixed for
 * the isolate's life; the origin is not. Better Auth trusts (CSRF) and names
 * its cookies for the origin it was built for, and the Api is reached on two:
 * its own URL, and the web UI's (src/web), which forwards the browser's
 * requests over a service binding with the browser's origin. A public request
 * can only carry one of this Worker's own hostnames, and only bound Workers
 * can choose another, so the map stays as small as the set of front doors.
 */
const instances = new Map<string, AuthInstance>();

/** `apps` are the stage's sign-in OAuth apps and `services` its mail and KV: fixed for the isolate's life, like the database and secret. */
export const layer = (
  database: BetterAuthOptions["database"],
  secret: string,
  baseURL: string,
  apps: Effect.Effect<SignInApps> = Effect.succeed(NO_APPS),
  services: StageServices = {},
) =>
  Layer.effect(
    Auth,
    Effect.map(apps, (app) => {
      // By origin and by the apps it signs in with: an instance built while a secret could not be read is not kept past it.
      const key = [baseURL, app.github?.clientId ?? "", app.cloudflare?.clientId ?? ""].join(" ");
      const existing = instances.get(key);

      if (existing !== undefined) {
        return existing;
      }

      const built = build(database, secret, baseURL, app, services);

      instances.set(key, built);

      return built;
    }),
  );
