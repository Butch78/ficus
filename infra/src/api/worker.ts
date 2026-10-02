/**
 * The Ficus API: the one public entry point.
 *
 *   /api/auth/*                         Better Auth: sign-up, sign-in,
 *                                       organizations, API keys
 *   GET /v1/orgs/<org>/trees            the organization's trees
 *   /v1/orgs/<org>/trees/<tree>[/...]   the tree API, for members of <org>
 *
 * A request to /v1 is authenticated (session cookie or `x-api-key`; a key's
 * session is its owner's), authorized against the organization by Better
 * Auth itself (`getFullOrganization` answers only to members), and forwarded
 * over a service binding to the internal tree Worker with the organization's
 * tenant key. Nothing reaches the tree Worker any other way.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { API_KEY_HEADER, AUTH_BASE_PATH, Auth, layer as authLayer } from "./auth.ts";
import * as Directory from "./directory.ts";
import { TENANT_HEADER, tenantKey } from "./tenant.ts";

interface Bindings {
  readonly AUTH_DB: D1Database;
  readonly TREE: Fetcher;
  readonly BETTER_AUTH_SECRET: string;
}

/** Headers that carry the caller's credentials or claims, never forwarded. */
const STRIPPED = ["cookie", "authorization", API_KEY_HEADER, TENANT_HEADER];

export class ApiFailure extends Schema.TaggedError<ApiFailure>()("Api.Failure", {
  status: Schema.Number,
  message: Schema.String,
}) {}

const fail = (status: number, message: string) => new ApiFailure({ status, message });

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

/** The organization `slug` names, if the caller is signed in and a member. */
const membership = Effect.fn("Api.membership")(function* (request: Request, slug: string) {
  const auth = yield* Auth;

  const session = yield* Effect.tryPromise({
    try: () => auth.api.getSession({ headers: request.headers }),
    catch: authFailure("could not check the session"),
  });

  if (session === null) {
    return yield* fail(401, "sign in, or send an API key in x-api-key");
  }

  // Answers only to members: a non-member and a missing organization are the
  // same 404, so membership of an organization does not leak its existence.
  const organization = yield* Effect.tryPromise({
    try: () => auth.api.getFullOrganization({ query: { organizationSlug: slug }, headers: request.headers }),
    catch: () => fail(404, `no organization ${slug} that you belong to`),
  });

  if (organization === null) {
    return yield* fail(404, `no organization ${slug} that you belong to`);
  }

  return organization;
});

const listTrees = Effect.fn("Api.listTrees")(function* (env: Bindings, request: Request, slug: string) {
  const organization = yield* membership(request, slug);

  const trees = yield* Directory.list(env.AUTH_DB, organization.id).pipe(
    Effect.mapError((error) => fail(503, error.message)),
  );

  return Response.json({ trees });
});

const forwardToTree = Effect.fn("Api.forwardToTree")(function* (
  env: Bindings,
  request: Request,
  route: { readonly org: string; readonly tree: string; readonly rest: string },
) {
  const organization = yield* membership(request, route.org);
  const tenant = yield* tenantKey(organization.id);
  const headers = new Headers(request.headers);

  for (const name of STRIPPED) {
    headers.delete(name);
  }

  headers.set(TENANT_HEADER, tenant);

  const url = new URL(`/trees/${route.tree}${route.rest}`, "http://tree");

  url.search = new URL(request.url).search;

  const init: RequestInit = { method: request.method, headers };

  if (request.body !== null) {
    init.body = request.body;
  }

  const response = yield* Effect.tryPromise({
    try: () => env.TREE.fetch(new Request(url, init)),
    catch: (cause) => fail(502, `the tree service is unreachable: ${String(cause)}`),
  });

  // A plant the tree service accepted puts the tree in the directory. The
  // plant itself has happened either way, so a failure to record it is
  // logged rather than turned into a failed plant.
  if (request.method === "POST" && route.rest === "/plant" && response.ok) {
    yield* Directory.record(env.AUTH_DB, organization.id, route.tree, Date.now()).pipe(
      Effect.catchTag("Directory.Failure", (error) => Effect.logError(error.message)),
    );
  }

  return response;
});

const handle = Effect.fn("Api.handle")(function* (env: Bindings, request: Request) {
  const { pathname } = new URL(request.url);

  if (pathname === "/") {
    return new Response("ficus 🌿 — https://github.com/Butch78/ficus\n");
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
  fetch: (request: Request, env: Bindings) =>
    Effect.runPromise(
      handle(env, request).pipe(
        Effect.catchTag("Api.Failure", (error) =>
          Effect.succeed(Response.json({ error: error.message }, { status: error.status })),
        ),
        // Better Auth builds its URLs from the origin it is served on.
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- the Worker's entry point
        Effect.provide(authLayer(env.AUTH_DB, env.BETTER_AUTH_SECRET, new URL(request.url).origin)),
      ),
    ),
} satisfies ExportedHandler<Bindings>;
