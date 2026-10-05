/**
 * Trees saved before the plain names (buds, leaves, harvests, compost) still
 * load: their keys and variants are renamed before `Tree` decodes them.
 * Saving writes the new names only.
 */
import * as Predicate from "effect/Predicate";
import type * as Schema from "effect/Schema";

/** Old key or variant name → new, wherever it appears in a stored tree. */
const RENAMED: ReadonlyMap<string, string> = new Map([
  ["buds", "tasks"],
  ["leaves", "attempts"],
  ["compost", "history"],
  ["fruit_of", "accepted_from"],
  ["regrowths", "retries"],
  ["transplant", "rebase"],
  ["transplant_of", "rebase_of"],
  ["leaf", "attempt"],
  ["bud", "task"],
  ["Fruited", "Done"],
  ["Ripening", "Checking"],
  ["Ripe", "Scored"],
  ["Fruit", "Accepted"],
  ["Pruned", "Closed"],
  ["Outgrown", "Lost"],
  ["Regrown", "Retried"],
  ["Transplanted", "Rebased"],
  ["Withered", "Abandoned"],
]);

/** A JSON value that is an object: not null, an array, or a scalar. */
const isJsonObject = (value: Schema.Json): value is Schema.JsonObject => value !== null && !Array.isArray(value) && Predicate.isObject(value);

/** `Outgrown { by }` became `Lost { to }`. */
const renameLost = (fields: Schema.JsonObject): Schema.JsonObject =>
  Object.fromEntries(Object.entries(fields).map(([key, value]) => [key === "by" ? "to" : key, value]));

/** `stored` with every old name replaced by its new one. */
export const renameLegacy = (stored: Schema.Json): Schema.Json => {
  if (Array.isArray(stored)) {
    return stored.map(renameLegacy);
  }

  if (!isJsonObject(stored)) {
    return stored;
  }

  return Object.fromEntries(
    Object.entries(stored).map(([key, value]) => {
      // The one old unit variant, stored as a bare string: an attempt's state.
      const renamed = key === "state" && value === "Growing" ? "Working" : renameLegacy(value);

      return [RENAMED.get(key) ?? key, key === "Outgrown" && isJsonObject(renamed) ? renameLost(renamed) : renamed];
    }),
  );
};
