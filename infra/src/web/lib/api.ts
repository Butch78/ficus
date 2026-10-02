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

/** A leaf or a node: the two things whose repos can be read. */
export type Subject = { readonly kind: "leaves" | "nodes"; readonly id: number };

const reading = (subject: Subject, what: "log" | "tree" | "file", query: URLSearchParams) =>
  `/${subject.kind}/${subject.id}/${what}?${query.toString()}`;

export const session = get(Answers.Session, "/api/auth/get-session");

export const organizations = get(Answers.Organizations, "/api/auth/organization/list");

export const createOrganization = (name: string, slug: string) =>
  send("POST", "/api/auth/organization/create", JSON.stringify({ name, slug }));

export const trees = (org: string) => get(Answers.PlantedTrees, `/v1/orgs/${encodeURIComponent(org)}/trees`);

export const plant = (org: string, name: string, source: string) =>
  send("POST", `${tree(org, name)}/plant`, JSON.stringify({ source }));

export const showTree = (org: string, name: string) => get(Answers.Tree, tree(org, name));

export const showLeaf = (org: string, name: string, leaf: number) =>
  get(Answers.LeafDetail, `${tree(org, name)}/leaves/${leaf}`);

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
