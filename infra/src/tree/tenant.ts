/**
 * Whose tree a request is for. The Api authenticates the user, authorizes
 * them against an organization, and forwards with that organization's
 * tenant key; a tree's Durable Object and root repo are `<tenant>-<tree>`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { RepoName } from "../core/values.ts";
import { refuse } from "./http.ts";

/** The header the Api sets on every request it forwards. */
export const TENANT_HEADER = "x-ficus-tenant";

/** A tenant key: 10 characters of base32 (a-z, 2-7), 50 bits of the organization id's SHA-256. */
const TENANT_KEY = /^[a-z2-7]{10}$/;

/** `<tenant>-<tree>` for the tenant the Api vouched for, or the refusal. */
export const scopedName = Effect.fn("Tree.scopedName")(function* (request: Request, tree: string) {
  const tenant = request.headers.get(TENANT_HEADER);

  if (tenant === null) {
    return yield* refuse(401, "no tenant: requests come through the Ficus API");
  }

  if (!TENANT_KEY.test(tenant)) {
    return yield* refuse(400, `not a tenant key: ${JSON.stringify(tenant)} (expected 10 characters of a-z and 2-7)`);
  }

  return yield* Schema.decodeUnknownEffect(RepoName)(`${tenant}-${tree}`).pipe(
    Effect.mapError(() => refuse(400, "tree names are letters, digits, '.', '-' and '_', and at most 40 characters")),
  );
});
