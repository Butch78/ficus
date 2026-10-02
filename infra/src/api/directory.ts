/**
 * Each organization's trees, in D1 (`ficus_tree`, migration 0002).
 *
 * A tree lives in its own Durable Object, which knows nothing of its
 * siblings; the Api is the one place that sees every plant go by, so it
 * keeps the directory. A tree is listed once a plant answered 2xx (planted,
 * or created empty and awaiting its root push).
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const PlantedTree = Schema.Struct({ name: Schema.String, plantedAt: Schema.Number });

export type PlantedTree = typeof PlantedTree.Type;

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
        .prepare(`insert or ignore into "ficus_tree" ("organizationId", "name", "plantedAt") values (?, ?, ?)`)
        .bind(organizationId, tree, now)
        .run(),
    catch: failure("could not record the tree"),
  });
});

export const list = Effect.fn("Directory.list")(function* (db: D1Database, organizationId: string) {
  const result = yield* Effect.tryPromise({
    try: () =>
      db
        .prepare(`select "name", "plantedAt" from "ficus_tree" where "organizationId" = ? order by "name"`)
        .bind(organizationId)
        .all(),
    catch: failure("could not list trees"),
  });

  return yield* Schema.decodeUnknownEffect(Schema.Array(PlantedTree))(result.results).pipe(
    Effect.mapError(failure("unexpected rows in ficus_tree")),
  );
});
