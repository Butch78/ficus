/**
 * The Artifacts binding, as Effects: each call Ficus makes, its failure kept
 * as the binding's documented `code` (`ArtifactsErrorCode`), so a caller can
 * tell "not found" from "still importing" from "down".
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export class ArtifactsError extends Schema.TaggedError<ArtifactsError>()("Artifacts.Error", {
  code: Schema.String,
  message: Schema.String,
}) {}

const Thrown = Schema.Struct({ code: Schema.String, message: Schema.String });

/** A rejection from the binding, as an `ArtifactsError` with its code. */
const thrown = (cause: unknown) =>
  Option.match(Schema.decodeUnknownOption(Thrown)(cause), {
    onSome: ({ code, message }) => new ArtifactsError({ code, message }),
    onNone: () => new ArtifactsError({ code: "UNCLASSIFIED", message: String(cause) }),
  });

const call = <A>(work: () => Promise<A>) => Effect.tryPromise({ try: work, catch: thrown });

/** Whether `error` carries `code`. */
export const isCode = (error: ArtifactsError, code: string) => error.code === code;

export const repo = (artifacts: Artifacts, name: string) => call(() => artifacts.get(name));

/** Create an empty repo `name` with `main` as its default branch. */
export const create = (artifacts: Artifacts, name: string, description: string) => call(() => artifacts.create(name, { description, setDefaultBranch: "main" }));

/** Import `url` (an HTTPS git remote, `branch` or its default) as the repo `name`. */
export const importRepo = (artifacts: Artifacts, url: string, branch: string | undefined, name: string) =>
  call(() => artifacts.import({ source: branch === undefined ? { url } : { url, branch }, target: { name } }));

/** Fork `from`'s default branch into a new repo `name`. */
export const fork = (from: ArtifactsRepo, name: string, description: string) => call(() => from.fork(name, { description, defaultBranchOnly: true }));

export const createToken = (on: ArtifactsRepo, scope: "read" | "write", ttlSeconds: number) => call(() => on.createToken(scope, ttlSeconds));

export const info = (on: ArtifactsRepo) => call(() => on.info());

/** Revoke one token by id; `false` if it was not found. */
export const revokeToken = (on: ArtifactsRepo, id: string) => call(() => on.revokeToken(id));

/** Revoke every token on the repo that is still active; answers how many. */
export const revokeActiveTokens = Effect.fn("Artifacts.revokeActiveTokens")(function* (on: ArtifactsRepo) {
  const listed = yield* call(() => on.listTokens());
  let revoked = 0;

  for (const token of listed.tokens.filter((each) => each.state === "active")) {
    if (yield* revokeToken(on, token.id)) {
      revoked += 1;
    }
  }

  return revoked;
});

/** First-parent history from `ref` (the repo's HEAD if absent), newest first; empty if the ref does not resolve. */
export const log = (on: ArtifactsRepo, ref: string | undefined, limit: number, offset = 0) =>
  call(() => on.log(ref === undefined ? { limit, offset } : { ref, limit, offset }));

/** A tree's immediate children; `null` if there is no such object. */
export const readTree = (on: ArtifactsRepo, hash: string) => call(() => on.readTree(hash));

/** A commit by id; `null` if there is no such object. */
export const readCommit = (on: ArtifactsRepo, hash: string) => call(() => on.readCommit(hash));

/** A blob's bytes, or `"too_large"` past `maxBytes` rather than copying it; `undefined` if there is no such blob. */
export const readBlob = Effect.fn("Artifacts.readBlob")(function* (on: ArtifactsRepo, hash: string, maxBytes: number) {
  const blob = yield* call(() => on.readBlob(hash));

  if (blob === null) {
    return undefined;
  }

  if (blob.size > maxBytes) {
    return "too_large" as const;
  }

  return new Uint8Array(yield* call(() => blob.arrayBuffer()));
});

/** The file at `path` as of `ref`, with the type Artifacts gives it; `undefined` if either does not resolve. Larger than `maxBytes` is refused. */
export const readFile = Effect.fn("Artifacts.readFile")(function* (on: ArtifactsRepo, ref: string, path: string, maxBytes: number) {
  const blob = yield* call(() => on.readFile({ ref, path }));

  if (blob === null) {
    return undefined;
  }

  if (blob.size > maxBytes) {
    return yield* new ArtifactsError({ code: "MEMORY_LIMIT", message: `${path} is larger than ${maxBytes} bytes` });
  }

  return { contentType: blob.type, bytes: new Uint8Array(yield* call(() => blob.arrayBuffer())) };
});

/** The HTTP status an Artifacts failure answers with. */
export const statusOf = (error: ArtifactsError) => {
  switch (error.code) {
    case "NOT_FOUND":
      return 404;
    case "ALREADY_EXISTS":
    case "CREATE_IN_PROGRESS":
    case "IMPORT_IN_PROGRESS":
    case "FORK_IN_PROGRESS":
      return 409;
    case "INVALID_INPUT":
    case "INVALID_REPO_NAME":
    case "INVALID_URL":
    case "INVALID_TTL":
      return 400;
    case "REMOTE_AUTH_REQUIRED":
      return 403;
    case "MEMORY_LIMIT":
      return 413;
    default:
      return 502;
  }
};
