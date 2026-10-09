/**
 * The web UI's way to the Ficus Api: its service binding (`API`), with the
 * browser's session cookie and origin passed through.
 *
 * Every call is addressed to the UI's own origin, not the Api's. The Api
 * builds Better Auth for the origin a request carries, so the session the
 * browser was given here (through app/api/auth) is the one it checks here.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { OPERATION_ATTRIBUTE, ORG_ATTRIBUTE } from "./activity.ts";
import * as Answers from "./answers.ts";

export class ApiError extends Schema.TaggedError<ApiError>()("Web.ApiError", {
  status: Schema.Number,
  message: Schema.String,
}) {}

/** The request being served, as far as the Api needs it. */
export class Upstream extends Context.Service<
  Upstream,
  {
    readonly api: Fetcher;
    readonly origin: string;
    readonly cookie: string | undefined;
  }
>()("@ficus/web/Upstream") {}

const ErrorBody = Schema.Struct({ error: Schema.String });

const decodeErrorBody = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorBody));

/** Better Auth and the Api answer `{error}`, the tree Worker plain text. */
const reason = (status: number, text: string) =>
  Option.match(decodeErrorBody(text), { onNone: () => text || `HTTP ${status}`, onSome: (body) => body.error });

/** `body` is JSON, already serialized. */
const send = Effect.fn("Web.send")(function* (method: "GET" | "POST", path: string, body: string | undefined) {
  const upstream = yield* Upstream;
  const headers = new Headers({ origin: upstream.origin });

  if (upstream.cookie !== undefined) {
    headers.set("cookie", upstream.cookie);
  }

  const init: RequestInit = { method, headers };

  if (body !== undefined) {
    headers.set("content-type", "application/json");
    init.body = body;
  }

  const response = yield* Effect.tryPromise({
    try: () => upstream.api.fetch(new Request(new URL(path, upstream.origin), init)),
    catch: (cause) => new ApiError({ status: 502, message: `the Api is unreachable: ${String(cause)}` }),
  });

  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new ApiError({ status: 502, message: `the Api's answer was cut off: ${String(cause)}` }),
  });

  if (!response.ok) {
    return yield* new ApiError({ status: response.status, message: reason(response.status, text) });
  }

  return { text, contentType: response.headers.get("content-type") ?? "" };
});

const json = <S extends Schema.Constraint>(schema: S) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema));

const decoded = <S extends Schema.Constraint>(schema: S, text: string) =>
  json(schema)(text).pipe(
    Effect.mapError((error) => new ApiError({ status: 502, message: `unexpected answer: ${error.message}` })),
  );

const get = <S extends Schema.Constraint>(schema: S, path: string) =>
  send("GET", path, undefined).pipe(Effect.flatMap((answer) => decoded(schema, answer.text)));

const tree = (org: string, name: string) =>
  `/v1/orgs/${encodeURIComponent(org)}/trees/${encodeURIComponent(name)}`;

/** An attempt or a node: the two things whose repos can be read. */
export type Subject = { readonly kind: "attempts" | "nodes"; readonly id: number };

const reading = (subject: Subject, what: "log" | "tree" | "file", query: URLSearchParams) =>
  `/${subject.kind}/${subject.id}/${what}?${query.toString()}`;

export const session = get(Answers.Session, "/api/auth/get-session");

export const organizations = get(Answers.Organizations, "/api/auth/organization/list");

export const createOrganization = (name: string, slug: string) =>
  send("POST", "/api/auth/organization/create", JSON.stringify({ name, slug }));

export const trees = (org: string) => get(Answers.Trees, `/v1/orgs/${encodeURIComponent(org)}/trees`);

/** Progress lines, one JSON object each (src/core/progress.ts). */
export const PROGRESS = "application/x-ndjson";

/**
 * Init, streaming its progress: the Api's response, unread, once it has
 * accepted the init. As the `ficus.init` span, marked with `operation` and
 * the organization, which is how its Cloudflare trace is found again
 * (lib/trace.ts) to show what happened.
 */
export const init = Effect.fn("ficus.init")(function* (org: string, name: string, source: string, operation: string) {
  yield* Effect.annotateCurrentSpan({ [OPERATION_ATTRIBUTE]: operation, [ORG_ATTRIBUTE]: org, "ficus.tree": name });

  const upstream = yield* Upstream;
  const headers = new Headers({ origin: upstream.origin, accept: PROGRESS, "content-type": "application/json" });

  if (upstream.cookie !== undefined) {
    headers.set("cookie", upstream.cookie);
  }

  const response = yield* Effect.tryPromise({
    try: () =>
      upstream.api.fetch(
        new Request(new URL(`${tree(org, name)}/init`, upstream.origin), {
          method: "POST",
          headers,
          body: JSON.stringify({ source }),
        }),
      ),
    catch: (cause) => new ApiError({ status: 502, message: `the Api is unreachable: ${String(cause)}` }),
  });

  if (!response.ok) {
    const text = yield* Effect.promise(() => response.text());

    return yield* new ApiError({ status: response.status, message: reason(response.status, text) });
  }

  return response;
});

export const showTree = (org: string, name: string) => get(Answers.Tree, tree(org, name));

export const showAttempt = (org: string, name: string, attempt: number) =>
  get(Answers.AttemptDetail, `${tree(org, name)}/attempts/${attempt}`);

export const log = (org: string, name: string, subject: Subject, limit: number) =>
  get(Answers.Log, tree(org, name) + reading(subject, "log", new URLSearchParams({ limit: String(limit) })));

export const listDirectory = (org: string, name: string, subject: Subject, path: string) =>
  get(Answers.Directory, tree(org, name) + reading(subject, "tree", new URLSearchParams({ path })));

/**
 * A file read at a pinned commit, so it matches the listing it came from.
 * `text` is undefined for a file the tree Worker serves as bytes.
 */
export const readFile = (org: string, name: string, subject: Subject, commit: string, path: string) =>
  send("GET", tree(org, name) + reading(subject, "file", new URLSearchParams({ ref: commit, path })), undefined).pipe(
    Effect.map((answer) => (answer.contentType.startsWith("text/") ? answer.text : undefined)),
  );

/** `body` is JSON, already serialized. */
const post = <S extends Schema.Constraint>(schema: S, path: string, body: string) =>
  send("POST", path, body).pipe(Effect.flatMap((answer) => decoded(schema, answer.text)));

/**
 * A change the UI makes on the person's behalf, as the `ficus.<name>` span:
 * marked with `operation` and the organization, so the page it lands on can
 * show its Cloudflare trace (lib/trace.ts).
 */
const marked = <A, E, R>(name: string, org: string, operation: string, change: Effect.Effect<A, E, R>) =>
  Effect.annotateCurrentSpan({ [OPERATION_ATTRIBUTE]: operation, [ORG_ATTRIBUTE]: org }).pipe(
    Effect.andThen(change),
    Effect.withSpan(`ficus.${name}`),
  );

export const showTask = (org: string, name: string, task: number) =>
  get(Answers.TaskRace, `${tree(org, name)}/tasks/${task}`);

export const diff = (org: string, name: string, subject: Subject) =>
  get(Answers.Diff, `${tree(org, name)}/${subject.kind}/${subject.id}/diff`);

export const createTask = (org: string, name: string, intent: string, operation: string) =>
  marked("task", org, operation, post(Answers.TaskCreated, `${tree(org, name)}/tasks`, JSON.stringify({ intent })));

export const setVisibility = (org: string, name: string, isPublic: boolean, operation: string) =>
  marked("visibility", org, operation, post(Answers.Visibility, `${tree(org, name)}/visibility`, JSON.stringify({ public: isPublic })));

export const accept = (org: string, name: string, task: number, operation: string) =>
  marked("accept", org, operation, post(Answers.Acceptance, `${tree(org, name)}/tasks/${task}/accept`, "{}"));

export const start = (org: string, name: string, task: number, agent: string, operation: string) =>
  marked("start", org, operation, post(Answers.Started, `${tree(org, name)}/tasks/${task}/attempts`, JSON.stringify({ agent })));

export const retry = (org: string, name: string, attempt: number, operation: string) =>
  marked("retry", org, operation, post(Answers.Started, `${tree(org, name)}/attempts/${attempt}/retry`, "{}"));

export const abandon = (org: string, name: string, attempt: number, note: string, operation: string) =>
  marked("abandon", org, operation, send("POST", `${tree(org, name)}/attempts/${attempt}/abandon`, JSON.stringify({ note })));

export const submit = (org: string, name: string, attempt: number, operation: string) =>
  marked("submit", org, operation, send("POST", `${tree(org, name)}/attempts/${attempt}/submit`, "{}"));

export const startAgents = (org: string, name: string, task: number, agents: number, model: string, operation: string) =>
  marked("agents", org, operation, post(Answers.AgentsStarted, `${tree(org, name)}/tasks/${task}/agents`, JSON.stringify({ agents, model })));

/** Point the release at `node`; a stage that deploys starts deploying it. */
export const release = (org: string, name: string, node: number, operation: string) =>
  marked("release", org, operation, send("POST", `${tree(org, name)}/release`, JSON.stringify({ node })));

export const deploys = (org: string, name: string) => get(Answers.Deploys, `${tree(org, name)}/deploys`);

export const agentStatus = (org: string, name: string, attempt: number) =>
  get(Answers.AgentStatus, `${tree(org, name)}/attempts/${attempt}/agent`);
