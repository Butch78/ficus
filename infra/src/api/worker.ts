/**
 * The Ficus API: the one public entry point.
 *
 *   /api/auth/*                         Better Auth: sign-up, sign-in,
 *                                       organizations, API keys
 *   GET /v1/orgs/<org>/trees            the organization's trees
 *   /v1/orgs/<org>/trees/<tree>[/...]   the tree API, for members of <org>;
 *                                       a public tree's reads for anyone
 *
 * A request to /v1 is authenticated (session cookie or `x-api-key`; a key's
 * session is its owner's), authorized against the organization by Better
 * Auth itself (`getFullOrganization` answers only to members), and forwarded
 * over a service binding to the internal tree Worker with the organization's
 * tenant key. Nothing reaches the tree Worker any other way. A read anyone
 * may make (core/visibility.ts), asked with no session and no API key, goes
 * on marked anonymous, and the tree Worker answers it only from a public tree.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { redactCredentials } from "../core/remote.ts";
import { ANONYMOUS_HEADER, anonymousMay, NO_SUCH_TREE } from "../core/visibility.ts";
import * as CloudflareTracer from "../observability/tracer.ts";
import { API_KEY_HEADER, AUTH_BASE_PATH, Auth, layer as authLayer } from "./auth.ts";
import * as Directory from "./directory.ts";
import * as GitHub from "./github.ts";
import * as GitHubLinks from "./github-links.ts";
import type { Mailer } from "./mail.ts";
import * as Progress from "./progress.ts";
import { backUpTrees } from "./backups.ts";
import { TENANT_HEADER, tenantKey } from "./tenant.ts";
import * as Usage from "./usage.ts";

interface Bindings {
  readonly AUTH_DB: D1Database;
  readonly TREE: Fetcher;
  readonly BETTER_AUTH_SECRET: string;
  /** Nightly tree exports (backups.ts). */
  readonly BACKUPS: R2Bucket;
  /** The organizations (slugs, comma-separated) built-in agents run for on Ficus's account (usage.ts). */
  readonly FICUS_AGENT_ORGS?: string;
  /** The stage's GitHub OAuth app's client id; with its secret, GitHub sign-in is on. */
  readonly GITHUB_CLIENT_ID?: string;
  /** Its client secret, from the account's Secrets Store (secrets.run.ts). */
  readonly GITHUB_CLIENT_SECRET?: SecretsStoreSecret;
  /** The stage's Cloudflare OAuth client's id; with its secret, signing in with Cloudflare is on. */
  readonly CLOUDFLARE_CLIENT_ID?: string;
  /** Its client secret, from the account's Secrets Store (secrets.run.ts). */
  readonly CLOUDFLARE_CLIENT_SECRET?: SecretsStoreSecret;
  /** Cloudflare Email Sending, on a stage with domains: confirmation links (mail.ts). */
  readonly EMAIL?: SendEmail;
  /** The address that mail comes from, on the stage's sending domain. */
  readonly MAIL_FROM?: string;
  /** Sessions, read at the edge (sessions.ts); without it they are read from D1. */
  readonly SESSIONS?: KVNamespace;
  /** The Ficus GitHub App (github.ts): its id and slug, from the deploy; with its key and webhook secret, adding repos from GitHub is on. */
  readonly GITHUB_APP_ID?: string;
  readonly GITHUB_APP_SLUG?: string;
  /** Its private key (PKCS#8, base64) and webhook secret, from the account's Secrets Store (secrets.run.ts). */
  readonly GITHUB_APP_PRIVATE_KEY?: SecretsStoreSecret;
  readonly GITHUB_WEBHOOK_SECRET?: SecretsStoreSecret;
}

/**
 * Secrets read from the Secrets Store, by what they are, once per isolate.
 * The value is kept, never the read's promise: a promise made while serving
 * one request cannot be awaited by another, so sharing it failed every request
 * but the first.
 */
const secretValues = new Map<string, string>();

/** A Secrets Store secret's value; undefined, and logged, when it cannot be read. */
const secretValue = (what: string, secret: SecretsStoreSecret) => {
  const known = secretValues.get(what);

  if (known !== undefined) {
    return Effect.succeed<string | undefined>(known);
  }

  return Effect.tryPromise(() => secret.get()).pipe(
    Effect.tap((value) => Effect.sync(() => secretValues.set(what, value))),
    Effect.tapError((error) => Effect.logError(`reading ${what}: ${String(error.cause)}`)),
    Effect.option,
    Effect.map(Option.getOrUndefined),
  );
};

/** An OAuth app the stage has, if it has both its client id and secret; a secret that cannot be read leaves that sign-in off, and is logged. */
const oauthApp = (clientId: string | undefined, secret: SecretsStoreSecret | undefined) =>
  clientId === undefined || secret === undefined
    ? Effect.succeed(undefined)
    : secretValue(`the OAuth client secret of ${clientId}`, secret).pipe(Effect.map((clientSecret) => (clientSecret === undefined ? undefined : { clientId, clientSecret })));

/** The Ficus GitHub App, if the stage has it whole: its id, slug, key and webhook secret. */
const githubApp = (env: Bindings) => {
  const { GITHUB_APP_ID: appId, GITHUB_APP_SLUG: slug, GITHUB_APP_PRIVATE_KEY: key, GITHUB_WEBHOOK_SECRET: hook } = env;

  if (appId === undefined || slug === undefined || key === undefined || hook === undefined) {
    return Effect.succeed(Option.none<GitHub.GitHubAppKeys>());
  }

  return Effect.all({ privateKey: secretValue(`the GitHub App ${appId}'s private key`, key), webhookSecret: secretValue(`the GitHub App ${appId}'s webhook secret`, hook) }).pipe(
    Effect.map(({ privateKey, webhookSecret }) =>
      privateKey === undefined || webhookSecret === undefined ? Option.none<GitHub.GitHubAppKeys>() : Option.some({ appId, slug, privateKey, webhookSecret }),
    ),
  );
};

/** The stage's way to send mail, where it has the binding and a sender; failures are logged and passed to Better Auth. */
const mailer = (env: Bindings): Mailer | undefined => {
  const { EMAIL: email, MAIL_FROM: from } = env;

  if (email === undefined || from === undefined) {
    return undefined;
  }

  return async (mail) => {
    try {
      await email.send({ from: { name: "Ficus", email: from }, to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
    } catch (error) {
      console.error(`sending "${mail.subject}": ${String(error)}`);

      throw error;
    }
  };
};

/** The stage's sign-in apps (auth.ts). */
const signInApps = (env: Bindings) =>
  Effect.all({ github: oauthApp(env.GITHUB_CLIENT_ID, env.GITHUB_CLIENT_SECRET), cloudflare: oauthApp(env.CLOUDFLARE_CLIENT_ID, env.CLOUDFLARE_CLIENT_SECRET) });

/** Which sign-ins the sign-in page should offer besides email. */
const providers = (env: Bindings) => ({
  github: env.GITHUB_CLIENT_ID !== undefined && env.GITHUB_CLIENT_SECRET !== undefined,
  cloudflare: env.CLOUDFLARE_CLIENT_ID !== undefined && env.CLOUDFLARE_CLIENT_SECRET !== undefined,
});

/** Headers that carry the caller's credentials or claims, never forwarded. */
const STRIPPED = ["cookie", "authorization", API_KEY_HEADER, TENANT_HEADER, ANONYMOUS_HEADER];

export class ApiFailure extends Schema.TaggedError<ApiFailure>()("Api.Failure", {
  status: Schema.Number,
  message: Schema.String,
}) {}

const fail = (status: number, message: string) => new ApiFailure({ status, message });

/** An anonymous caller's unknown organization: answered as the tree Worker answers a tree they may not read. */
class Hidden extends Schema.TaggedError<Hidden>()("Api.Hidden", {}) {}

/** Better Auth's `APIError`, the fields this Worker passes on. */
const AuthRejection = Schema.Struct({ statusCode: Schema.Number, message: Schema.String });

const isAuthRejection = Schema.is(AuthRejection);

/** Better Auth's own status (401, 429, ...) when it rejected; 503 otherwise. */
const authFailure = (step: string) => (cause: unknown) =>
  isAuthRejection(cause) ? fail(cause.statusCode, cause.message) : fail(503, `${step}: ${String(cause)}`);

/** `/v1/orgs/<org>/trees/<tree><rest>`, split; undefined for anything else. */
export const treeRoute = (pathname: string) => {
  const match = /^\/v1\/orgs\/([^/]+)\/trees\/([^/]+)(\/.*)?$/.exec(pathname);

  if (match === null) {
    return undefined;
  }

  const [, org, tree, rest] = match;

  return org === undefined || tree === undefined ? undefined : { org, tree, rest: rest ?? "" };
};

/** `/v1/orgs/<org>/trees`: the organization's slug; undefined otherwise. */
export const treesRoute = (pathname: string) => /^\/v1\/orgs\/([^/]+)\/trees\/?$/.exec(pathname)?.[1];

/** The id of the organization `slug` names, from Better Auth's own table; `Hidden` if there is none. */
const organizationId = Effect.fn("Api.organizationId")(function* (slug: string) {
  const auth = yield* Auth;

  const found = yield* Effect.tryPromise({
    try: async () =>
      (await auth.$context).adapter.findOne<{ readonly id: string }>({ model: "organization", where: [{ field: "slug", value: slug }], select: ["id"] }),
    catch: authFailure("could not look up the organization"),
  });

  return found === null ? yield* new Hidden() : found.id;
});

/**
 * The id of the organization `slug` names, if `user` is one of its members; `Hidden` otherwise.
 * Two lookups in Better Auth's tables: `getFullOrganization` read the whole
 * organization (its members, their users, its invitations) and verified an API
 * key a second time, counting the request twice against the key's limit.
 */
const memberOf = Effect.fn("Api.memberOf")(function* (slug: string, user: string) {
  const auth = yield* Auth;
  const id = yield* organizationId(slug);

  const member = yield* Effect.tryPromise({
    try: async () =>
      (await auth.$context).adapter.findOne<{ readonly id: string }>({
        model: "member",
        where: [
          { field: "organizationId", value: id },
          { field: "userId", value: user },
        ],
        select: ["id"],
      }),
    catch: authFailure("could not check the membership"),
  });

  return member === null ? yield* new Hidden() : id;
});

/**
 * The organization `slug` names, if the caller is signed in and a member; or,
 * where `anonymous` allows it, for a caller with no session and no API key.
 */
const membership = Effect.fn("Api.membership")(function* (request: Request, slug: string, anonymous = false) {
  yield* Effect.annotateCurrentSpan("ficus.org", slug);

  const auth = yield* Auth;

  const session = yield* Effect.tryPromise({
    try: () => auth.api.getSession({ headers: request.headers }),
    catch: authFailure("could not check the session"),
  });

  if (session === null) {
    if (anonymous && !request.headers.has(API_KEY_HEADER)) {
      return { id: yield* organizationId(slug), anonymous: true };
    }

    return yield* fail(401, "sign in, or send an API key in x-api-key");
  }

  // Answers only to members: a non-member and a missing organization are the
  // same 404, so membership of an organization does not leak its existence.
  const id = yield* memberOf(slug, session.user.id).pipe(Effect.catchTag("Api.Hidden", () => fail(404, `no organization ${slug} that you belong to`)));

  return { id, anonymous: false };
});

const listTrees = Effect.fn("Api.listTrees")(function* (env: Bindings, request: Request, slug: string) {
  const organization = yield* membership(request, slug);

  const trees = yield* Directory.list(organization.id).pipe(
    Effect.mapError((error) => fail(503, error.message)),
  );

  return Response.json({ trees });
});

/**
 * What a request to a tree would use of Ficus's own account (usage.ts):
 * built-in agents only for an allowlisted organization, and each kind within
 * the organization's daily cap. Taken before the tree is asked.
 */
const meter = Effect.fn("Api.meter")(function* (env: Bindings, request: Request, route: { readonly org: string; readonly rest: string }, organization: string) {
  const body = Usage.startsAgents(request.method, route.rest) ? yield* Effect.promise(() => request.clone().text()) : undefined;
  const asked = Usage.metered(request.method, route.rest, body);

  if (asked === undefined) {
    return;
  }

  if (asked.kind === "agents" && !Usage.allowlist(env.FICUS_AGENT_ORGS).has(route.org)) {
    return yield* Usage.notAllowed();
  }

  yield* Usage.take(organization, asked.kind, asked.count, Date.now());
});

const forwardToTree = Effect.fn("Api.forwardToTree")(function* (
  env: Bindings,
  request: Request,
  route: { readonly org: string; readonly tree: string; readonly rest: string },
) {
  const organization = yield* membership(request, route.org, anonymousMay(request.method, route.rest));

  yield* meter(env, request, route, organization.id);

  const tenant = yield* tenantKey(organization.id);
  const headers = new Headers(request.headers);

  for (const name of STRIPPED) {
    headers.delete(name);
  }

  headers.set(TENANT_HEADER, tenant);

  if (organization.anonymous) {
    headers.set(ANONYMOUS_HEADER, "true");
  }

  const url = new URL(`/trees/${route.tree}${route.rest}`, "http://tree");

  url.search = new URL(request.url).search;

  const init: RequestInit = { method: request.method, headers };
  // An init from a GitHub repo: the Api turns it into an import from the repo's URL (a private one's with a token).
  const github = request.method === "POST" && route.rest === "/init" ? yield* fromGitHub(env, request) : undefined;

  if (github !== undefined) {
    init.body = github.body;
  } else if (request.body !== null) {
    init.body = request.body;
  }

  const response = yield* Effect.tryPromise({
    try: () => env.TREE.fetch(new Request(url, init)),
    catch: (cause) => fail(502, `the tree service is unreachable: ${String(cause)}`),
  });

  if (request.method !== "POST" || route.rest !== "/init" || !response.ok) {
    return response;
  }

  // An init the tree service accepted puts the tree in the directory. The
  // init itself has happened either way, so a failure to record it is
  // logged rather than turned into a failed init.
  // A tree added from GitHub follows its repo and branch from now on (the webhook grafts each push).
  const follow =
    github === undefined
      ? Effect.void
      : GitHubLinks.link({ organizationId: organization.id, tree: route.tree, ...github.follows, createdAt: Date.now() }).pipe(
          Effect.catchTag("GitHubLinks.Failure", (error) => Effect.logError(error.message)),
        );

  const record = Effect.andThen(follow, Directory.record(organization.id, route.tree, Date.now())).pipe(
    Effect.as(Progress.stepLine("record", "complete")),
    Effect.catchTag("Directory.Failure", (error) =>
      Effect.logError(error.message).pipe(Effect.as(Progress.stepLine("record", "error"))),
    ),
  );

  const streamed = response.headers.get("content-type")?.startsWith(Progress.CONTENT_TYPE) ?? false;

  // A streamed init answers 200 before it is done: record it once its
  // outcome says it succeeded, as the stream's last step.
  if (streamed && response.body !== null) {
    // The request's services (the tracer among them), for after it returns.
    const services = yield* Effect.context<never>();

    return new Response(
      Progress.afterSuccess(response.body, () =>
        Effect.runPromiseWith(services)(
          // An entry point of its own: the request's Effect, and the D1 client
          // it was given, are done by the time the stream ends.
          // oxlint-disable-next-line effecttsgo/strict-effect-provide -- runs after the request's Effect: an entry point
          record.pipe(Effect.provide(Directory.directoryLayer(env.AUTH_DB))),
        ),
      ),
      response,
    );
  }

  yield* record;

  return response;
});

/** The part of the execution context the Api uses: work that outlives the answer. */
type Background = Pick<ExecutionContext, "waitUntil">;

/** An init's body naming a GitHub repo (by GitHub's id) rather than a source. */
const GitHubInit = Schema.Struct({ github: Schema.Struct({ repository: Schema.Number, branch: Schema.optional(Schema.String) }) });

const decodeGitHubInit = Schema.decodeUnknownOption(Schema.fromJsonString(GitHubInit));

/** The signed-in person's GitHub token (Better Auth refreshes it); none until they connect GitHub. */
const githubToken = Effect.fn("Api.githubToken")(function* (request: Request) {
  const auth = yield* Auth;

  // Better Auth asks for the account by its own id: the person's GitHub account, if they have one.
  const accounts = yield* Effect.tryPromise(() => auth.api.listUserAccounts({ headers: request.headers })).pipe(Effect.orElseSucceed(() => []));
  const account = accounts.find((candidate) => candidate.providerId === "github");

  if (account === undefined) {
    return Option.none<string>();
  }

  const answer = yield* Effect.tryPromise(() => auth.api.getAccessToken({ body: { accountId: account.id }, headers: request.headers })).pipe(Effect.option);

  return Option.flatMap(answer, (token) => Option.fromUndefinedOr(token.accessToken));
});

/** A GitHub failure, said to the caller: GitHub's own status where it is the caller's to fix. */
const githubRefused = (error: GitHub.GitHubFailure) => fail(error.status === 401 || error.status === 403 || error.status === 404 ? error.status : 502, error.message);

/**
 * For an init naming a GitHub repo: the init body the tree is sent instead
 * (the repo's import URL and branch) and what the tree will follow. The repo
 * must be one the caller's GitHub token reaches through the app.
 */
const fromGitHub = Effect.fn("Api.fromGitHub")(function* (env: Bindings, request: Request) {
  const asked = decodeGitHubInit(yield* Effect.promise(() => request.clone().text()));

  if (Option.isNone(asked)) {
    return undefined;
  }

  const app = yield* githubApp(env);

  if (Option.isNone(app)) {
    return yield* fail(404, "adding repos from GitHub is not set up here");
  }

  const token = yield* githubToken(request);

  if (Option.isNone(token)) {
    return yield* fail(403, "connect your GitHub account first");
  }

  const found = yield* GitHub.userRepository(token.value, asked.value.github.repository).pipe(Effect.mapError(githubRefused));

  if (Option.isNone(found)) {
    return yield* fail(404, "no such repo through the Ficus GitHub App: install it on the repo first");
  }

  const repository = found.value;
  // A private repo is read with a token for it alone; the tree copies it over git (src/tree/git-copy.ts), since Artifacts' import refuses credentials.
  const access = repository.private ? yield* GitHub.repositoryToken(app.value, repository).pipe(Effect.mapError(githubRefused)) : undefined;
  const branch = asked.value.github.branch ?? repository.default_branch;

  yield* Effect.annotateCurrentSpan({ "ficus.github.repository": repository.full_name, "ficus.github.private": repository.private });

  return {
    body: JSON.stringify({ source: GitHub.importSource(repository, access), branch }),
    follows: { repositoryId: repository.id, fullName: repository.full_name, branch },
  };
});

/** `GET /v1/github/repos`: the repos the signed-in person can add, through the app's installations they reach. */
const githubRepos = Effect.fn("Api.githubRepos")(function* (env: Bindings, request: Request) {
  const app = yield* githubApp(env);

  if (Option.isNone(app)) {
    return Response.json({ enabled: false, connected: false, installUrl: null, repositories: [] });
  }

  const auth = yield* Auth;

  const session = yield* Effect.tryPromise({
    try: () => auth.api.getSession({ headers: request.headers }),
    catch: authFailure("could not check the session"),
  });

  if (session === null) {
    return yield* fail(401, "sign in first");
  }

  const token = yield* githubToken(request);
  const offered = { enabled: true, installUrl: GitHub.installUrl(app.value) };

  if (Option.isNone(token)) {
    return Response.json({ ...offered, connected: false, repositories: [] });
  }

  // A token GitHub no longer takes (revoked, or the app uninstalled) is as good as not connected.
  const repositories = yield* GitHub.userRepositories(token.value).pipe(
    Effect.map(Option.some),
    Effect.catchTag("GitHub.Failure", (error) => (error.status === 401 ? Effect.succeed(Option.none()) : Effect.fail(githubRefused(error)))),
  );

  return Response.json({ ...offered, connected: Option.isSome(repositories), repositories: Option.getOrElse(repositories, () => []) });
});

/** Graft the pushed commit into one tree following the repo. Failures are logged: GitHub was answered long ago. */
const graftFromGitHub = Effect.fn("Api.graftFromGitHub")(function* (
  env: Bindings,
  app: GitHub.GitHubAppKeys,
  push: { readonly repository: Pick<GitHub.Repository, "id" | "full_name" | "private">; readonly branch: string },
  follower: GitHubLinks.GitHubLink,
) {
  yield* Effect.annotateCurrentSpan({ "ficus.tree": follower.tree, "ficus.github.repository": push.repository.full_name });

  const token = push.repository.private ? yield* GitHub.repositoryToken(app, push.repository) : undefined;
  const tenant = yield* tenantKey(follower.organizationId);

  const response = yield* Effect.tryPromise({
    try: () =>
      env.TREE.fetch(
        new Request(`http://tree/trees/${encodeURIComponent(follower.tree)}/graft`, {
          method: "POST",
          headers: { [TENANT_HEADER]: tenant, "content-type": "application/json" },
          body: JSON.stringify({ source: GitHub.importSource(push.repository, token), branch: push.branch }),
        }),
      ),
    catch: (cause) => fail(502, `the tree service is unreachable: ${String(cause)}`),
  });

  if (!response.ok) {
    const why = yield* Effect.promise(() => response.text());

    yield* Effect.logWarning(`grafting ${push.repository.full_name}#${push.branch} into ${follower.tree}: ${response.status} ${redactCredentials(why)}`);
  }
});

/** `POST /v1/github/webhook`: GitHub's events, signed with the app's webhook secret. A push grafts every tree following its repo and branch. */
const githubWebhook = Effect.fn("Api.githubWebhook")(function* (env: Bindings, request: Request, ctx: Background) {
  const app = yield* githubApp(env);

  if (Option.isNone(app)) {
    return yield* fail(404, "not found");
  }

  const body = yield* Effect.promise(() => request.text());
  const signed = yield* Effect.promise(() => GitHub.signedByGitHub(app.value.webhookSecret, body, request.headers.get("x-hub-signature-256")));

  if (!signed) {
    return yield* fail(401, "the signature does not match");
  }

  const event = request.headers.get("x-github-event") ?? "";
  const push = event === "push" ? GitHub.pushed(body) : Option.none();

  if (Option.isNone(push)) {
    // A ping, an installation, a tag: nothing to graft.
    return Response.json({ event, following: 0 }, { status: 202 });
  }

  const followers = yield* GitHubLinks.following(push.value.repository.id, push.value.branch).pipe(Effect.mapError((error) => fail(503, error.message)));

  if (followers.length > 0) {
    // GitHub waits ten seconds for an answer; an import can take longer.
    const services = yield* Effect.context<never>();

    const grafts = Effect.forEach(
      followers,
      (follower) => graftFromGitHub(env, app.value, push.value, follower).pipe(Effect.catch((error) => Effect.logError(`grafting into ${follower.tree}: ${error.message}`))),
      { concurrency: 2, discard: true },
    );

    ctx.waitUntil(Effect.runPromiseWith(services)(grafts));
  }

  return Response.json({ event, following: followers.length }, { status: 202 });
});

const handle = Effect.fn("Api.handle")(function* (env: Bindings, request: Request, ctx: Background) {
  const { pathname } = new URL(request.url);

  if (pathname === "/") {
    return new Response("ficus 🌿 — https://github.com/Butch78/ficus\n");
  }

  // No authentication, and nothing beyond this Worker: a liveness probe.
  if (pathname === "/v1/health") {
    return Response.json({ ok: true });
  }


  if (pathname === "/v1/github/webhook" && request.method === "POST") {
    return yield* githubWebhook(env, request, ctx);
  }

  if (pathname === "/v1/github/repos" && request.method === "GET") {
    return yield* githubRepos(env, request);
  }

  if (pathname.startsWith(`${AUTH_BASE_PATH}/`)) {
    const auth = yield* Auth;

    return yield* Effect.tryPromise({
      try: () => auth.handler(request),
      catch: (cause) => fail(500, `auth failed: ${String(cause)}`),
    });
  }

  const trees = treesRoute(pathname);

  if (trees !== undefined && request.method === "GET") {
    return yield* listTrees(env, request, trees);
  }

  const route = treeRoute(pathname);

  if (route === undefined) {
    return yield* fail(404, "not found");
  }

  return yield* forwardToTree(env, request, route);
});

export default {
  fetch: (request: Request, env: Bindings, ctx: Background) => {
    // A liveness probe: no authentication, no layers (building the auth layer
    // would construct Better Auth), and nothing beyond this Worker.
    if (new URL(request.url).pathname === "/v1/health") {
      return Promise.resolve(Response.json({ ok: true }));
    }

    // The ways to sign in, for the sign-in page: no authentication, and Better Auth is not built for it either.
    if (new URL(request.url).pathname === "/v1/auth/providers") {
      return Promise.resolve(Response.json(providers(env)));
    }

    return Effect.runPromise(
      handle(env, request, ctx).pipe(
        Effect.catchTag("Api.Failure", (error) =>
          Effect.succeed(Response.json({ error: error.message }, { status: error.status })),
        ),
        Effect.catchTag("Api.Hidden", () => Effect.succeed(new Response(NO_SUCH_TREE, { status: 404 }))),
        Effect.catchTag("Usage.Refused", (refused) => Effect.succeed(Response.json({ error: refused.message }, { status: refused.status }))),
        // Better Auth builds its URLs from the origin it is served on; the
        // directory has its D1 client; the tracer records this request's Effect spans in its Cloudflare trace.
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- the Worker's entry point
        Effect.provide(
          Layer.mergeAll(
            authLayer(env.AUTH_DB, env.BETTER_AUTH_SECRET, new URL(request.url).origin, signInApps(env), { mail: mailer(env), sessions: env.SESSIONS }),
            Directory.directoryLayer(env.AUTH_DB),
            CloudflareTracer.layer,
          ),
        ),
      ),
    );
  },
  // The nightly backup (backups.ts), on the cron alchemy.run.ts sets.
  scheduled: (controller: ScheduledController, env: Bindings, ctx: ExecutionContext) =>
    ctx.waitUntil(
      Effect.runPromise(
        backUpTrees(env, new Date(controller.scheduledTime)).pipe(
          Effect.asVoid,
          // oxlint-disable-next-line effecttsgo/strict-effect-provide -- the Worker's entry point
          Effect.provide(Layer.mergeAll(Directory.directoryLayer(env.AUTH_DB), CloudflareTracer.layer)),
        ),
      ),
    ),
} satisfies ExportedHandler<Bindings>;
