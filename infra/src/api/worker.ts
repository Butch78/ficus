/**
 * The Ficus API: the one public entry point.
 *
 *   /api/auth/*                         Better Auth: sign-up, sign-in,
 *                                       organizations, API keys
 *   /v1/orgs/<org>/trees/<tree>[/...]   the tree API, for members of <org>
 *
 * A request to /v1 is authenticated (session cookie or `x-api-key`; a key's
 * session is its owner's), authorized against the organization by Better
 * Auth itself (`getFullOrganization` answers only to members), and forwarded
 * over a service binding to the internal tree Worker with the organization's
 * tenant key. Nothing reaches the tree Worker any other way.
 *
 * Starting or retrying an attempt also starts its agent (agents.ts), unless
 * the request says `start_agent: false`; the answer then carries
 * `agent_started`, or `agent_error` when the agent would not start (the
 * attempt exists either way).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { API_KEY_HEADER, AUTH_BASE_PATH, Auth, layer as authLayer } from "./auth.ts";
import { optionsOf, Started, startAgent, startsAnAttempt } from "./agents.ts";
import { TENANT_HEADER, tenantKey } from "./tenant.ts";

interface Bindings {
  readonly AUTH_DB: D1Database;
  readonly TREE: Fetcher;
  readonly AGENTS: DurableObjectNamespace;
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

const forwardToTree = Effect.fn("Api.forwardToTree")(function* (
  env: Bindings,
  request: Request,
  route: { readonly org: string; readonly tree: string; readonly rest: string },
) {
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
    try: () => auth.api.getFullOrganization({ query: { organizationSlug: route.org }, headers: request.headers }),
    catch: () => fail(404, `no organization ${route.org} that you belong to`),
  });

  if (organization === null) {
    return yield* fail(404, `no organization ${route.org} that you belong to`);
  }

  const tenant = yield* tenantKey(organization.id);
  const headers = new Headers(request.headers);

  for (const name of STRIPPED) {
    headers.delete(name);
  }

  headers.set(TENANT_HEADER, tenant);

  const url = new URL(`/trees/${route.tree}${route.rest}`, "http://tree");

  url.search = new URL(request.url).search;

  // A request that starts an attempt is read whole: its options decide the agent.
  const body = startsAnAttempt(request.method, route.rest)
    ? yield* Effect.tryPromise({
        try: () => request.text(),
        catch: () => fail(400, "could not read the request body"),
      })
    : undefined;

  const init: RequestInit = { method: request.method, headers };

  if (body !== undefined) {
    init.body = body;
  } else if (request.body !== null) {
    init.body = request.body;
  }

  const answer = yield* Effect.tryPromise({
    try: () => env.TREE.fetch(new Request(url, init)),
    catch: (cause) => fail(502, `the tree service is unreachable: ${String(cause)}`),
  });

  if (body === undefined || !answer.ok) {
    return answer;
  }

  return yield* withAgent(env, tenant, route.tree, answer, body);
});

/** Start the agent of the attempt `answer` started, and say how that went in the answer. */
const withAgent = Effect.fn("Api.withAgent")(function* (
  env: Bindings,
  tenant: string,
  tree: string,
  answer: Response,
  body: string,
) {
  const text = yield* Effect.tryPromise({
    try: () => answer.text(),
    catch: () => fail(502, "could not read the tree's answer"),
  });

  const started = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Started))(text).pipe(
    Effect.mapError((error) => fail(502, `the tree's answer is not a started attempt: ${String(error)}`)),
  );

  const options = optionsOf(body);

  if (options.start_agent === false) {
    return Response.json({ ...started, agent_started: false }, { status: answer.status });
  }

  return yield* startAgent(env.AGENTS, tenant, tree, started, options).pipe(
    Effect.as(Response.json({ ...started, agent_started: true }, { status: answer.status })),
    Effect.catchTag("Api.AgentStartFailed", (error) =>
      Effect.succeed(
        Response.json({ ...started, agent_started: false, agent_error: error.message }, { status: answer.status }),
      ),
    ),
  );
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
