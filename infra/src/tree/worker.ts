/**
 * The Ficus tree Worker. Internal only: no public URL, and the Api
 * (src/api) is its one caller. The Api authenticates the user, authorizes
 * them against an organization, and forwards `/trees/<tree>/...` with that
 * organization's tenant key; this Worker hands the request to the tree's
 * Durable Object, `<tenant>-<tree>`.
 */
import * as Effect from "effect/Effect";
import { answerRefused, refuse } from "./http.ts";
import { scopedName } from "./tenant.ts";
import type { Bindings } from "./tree-object.ts";

export { TreeObject } from "./tree-object.ts";

interface Env extends Bindings {
  readonly TREES: DurableObjectNamespace;
}

const route = Effect.fn("Tree.worker")(function* (request: Request, env: Env) {
  const [first, tree] = new URL(request.url).pathname.replace(/^\/+/, "").split("/");

  if (first !== "trees" || tree === undefined || tree === "") {
    return yield* refuse(404, "not found");
  }

  const scoped = yield* scopedName(request, tree);

  return yield* Effect.promise(() => env.TREES.get(env.TREES.idFromName(scoped)).fetch(request));
});

export default {
  fetch: (request: Request, env: Env) => Effect.runPromise(route(request, env).pipe(Effect.catchTag("Tree.Refused", (refused) => Effect.succeed(answerRefused(refused))))),
} satisfies ExportedHandler<Env>;
