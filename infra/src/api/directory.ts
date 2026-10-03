/**
 * Each organization's trees, in D1 (`ficus_tree`, migrations 0002 and 0003).
 *
 * A tree lives in its own Durable Object, which knows nothing of its
 * siblings; the Api is the one place that sees every init go by, so it
 * keeps the directory. A tree is listed once an init answered 2xx (initialized,
 * or created empty and awaiting its root push).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ListedTree = Schema.Struct({ name: Schema.String, createdAt: Schema.Number });

export type ListedTree = typeof ListedTree.Type;

export class DirectoryFailure extends Schema.TaggedError<DirectoryFailure>()("Directory.Failure", {
  message: Schema.String,
}) {}

const failure = (step: string) => (cause: unknown) => new DirectoryFailure({ message: `${step}: ${String(cause)}` });

export const record = Effect.fn("Directory.record")(function* (
  db: D1Database,
  organizationId: string,
  tree: string,
  now: number,
) {
  yield* Effect.tryPromise({
    try: () =>
      db
        .prepare(`insert or ignore into "ficus_tree" ("organizationId", "name", "createdAt") values (?, ?, ?)`)
        .bind(organizationId, tree, now)
        .run(),
    catch: failure("could not record the tree"),
  });
});

export const list = Effect.fn("Directory.list")(function* (db: D1Database, organizationId: string) {
  const result = yield* Effect.tryPromise({
    try: () =>
      db
        .prepare(`select "name", "createdAt" from "ficus_tree" where "organizationId" = ? order by "name"`)
        .bind(organizationId)
        .all(),
    catch: failure("could not list trees"),
  });

  return yield* Schema.decodeUnknownEffect(Schema.Array(ListedTree))(result.results).pipe(
    Effect.mapError(failure("unexpected rows in ficus_tree")),
  );
});
