/**
 * The nightly backup: every tree's export (`GET /trees/<t>/export`) written
 * to the BACKUPS R2 bucket as `trees/<organization>/<tree>/<date>.json`. The
 * trees come from the directory (D1), the way the Api lists them; the bucket
 * expires old backups by itself (alchemy.run.ts).
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Directory from "./directory.ts";
import { TENANT_HEADER, tenantKey } from "./tenant.ts";

/** What a backup needs of the Api's bindings. */
export interface BackupBindings {
  readonly TREE: Fetcher;
  readonly BACKUPS: R2Bucket;
}

/** Back one tree up; a tree that will not export is logged and skipped. */
const backUpTree = Effect.fn("Backups.tree")(function* (env: BackupBindings, organizationId: string, tree: string, day: string) {
  const tenant = yield* tenantKey(organizationId);

  const exported = yield* Effect.tryPromise(() =>
    env.TREE.fetch(new Request(`http://tree/trees/${tree}/export`, { headers: { [TENANT_HEADER]: tenant } })),
  ).pipe(Effect.option);

  if (Option.isNone(exported) || !exported.value.ok) {
    yield* Effect.logWarning(`tree ${organizationId}/${tree} did not export`);

    return false;
  }

  const body = exported.value.body;

  const stored = yield* Effect.tryPromise(() =>
    env.BACKUPS.put(`trees/${organizationId}/${tree}/${day}.json`, body, { httpMetadata: { contentType: "application/json" } }),
  ).pipe(
    Effect.tapError((error) => Effect.logWarning(`tree ${organizationId}/${tree} was not stored: ${String(error)}`)),
    Effect.option,
  );

  return Option.isSome(stored);
});

/** Back every tree up; answers how many were stored. */
export const backUpTrees = Effect.fn("Backups.all")(function* (env: BackupBindings, now: Date) {
  const day = now.toISOString().slice(0, 10);
  const trees = yield* Directory.all();
  const stored = yield* Effect.forEach(trees, ({ organizationId, name }) => backUpTree(env, organizationId, name, day), { concurrency: 4 });

  yield* Effect.annotateCurrentSpan({ "ficus.backups.trees": trees.length, "ficus.backups.stored": stored.filter(Boolean).length });

  return stored.filter(Boolean).length;
});
