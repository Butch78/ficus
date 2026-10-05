/**
 * Each organization's trees, in D1 (`ficus_tree`, declared in schema.ts),
 * through Drizzle's Effect driver (`drizzle-orm/effect-d1` on
 * `@effect/sql-d1`): every query is an Effect, and its failure is typed. The
 * `D1Client` comes from the caller: the Api provides one per request
 * (`directoryLayer`).
 *
 * A tree lives in its own Durable Object, which knows nothing of its
 * siblings; the Api is the one place that sees every init go by, so it
 * keeps the directory. A tree is listed once an init answered 2xx (initialized,
 * or created empty and awaiting its root push).
 */
import * as D1Client from "@effect/sql-d1/D1Client";
import { asc, eq } from "drizzle-orm";
import * as D1Drizzle from "drizzle-orm/effect-d1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ficusTree } from "./schema.ts";

/** A tree as the directory lists it: Drizzle types the rows from schema.ts. */
export type ListedTree = Pick<typeof ficusTree.$inferSelect, "name" | "createdAt">;

export class DirectoryFailure extends Schema.TaggedError<DirectoryFailure>()("Directory.Failure", {
  message: Schema.String,
}) {}

const failure = (step: string) => (cause: { readonly message: string }) =>
  new DirectoryFailure({ message: `${step}: ${cause.message}` });

/** Drizzle over the request's `D1Client` (the Api provides it per request). */
const directory = D1Drizzle.makeWithDefaults({});

export const record = Effect.fn("Directory.record")(function* (
  organizationId: string,
  tree: string,
  now: number,
) {
  const db = yield* directory;

  yield* db
    .insert(ficusTree)
    .values({ organizationId, name: tree, createdAt: now })
    .onConflictDoNothing()
    .pipe(Effect.mapError(failure("could not record the tree")));
});

/** Every tree, in every organization: what the nightly backup exports. */
export const all = Effect.fn("Directory.all")(function* () {
  const db = yield* directory;

  return yield* db
    .select({ organizationId: ficusTree.organizationId, name: ficusTree.name })
    .from(ficusTree)
    .orderBy(asc(ficusTree.organizationId), asc(ficusTree.name))
    .pipe(Effect.mapError(failure("could not list every tree")));
});

export const list = Effect.fn("Directory.list")(function* (organizationId: string) {
  const db = yield* directory;

  const trees: ReadonlyArray<ListedTree> = yield* db
    .select({ name: ficusTree.name, createdAt: ficusTree.createdAt })
    .from(ficusTree)
    .where(eq(ficusTree.organizationId, organizationId))
    .orderBy(asc(ficusTree.name))
    .pipe(Effect.mapError(failure("could not list trees")));

  return trees;
});

/** The `D1Client` the directory reads and writes through, over the Api's database. */
export const directoryLayer = (db: D1Database) => D1Client.layer({ db }).pipe(Layer.orDie);
