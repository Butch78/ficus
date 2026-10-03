/**
 * Ficus's own tables in the Api's D1 database, as Drizzle declares them.
 *
 * `alchemy.run.ts`'s `Drizzle.Schema` diffs this module against the latest
 * snapshot in `migrations/` on every deploy and writes a migration for any
 * change; the database applies it. Queries go through `drizzle-orm/effect-d1`
 * (directory.ts).
 *
 * Better Auth's tables (user, session, organization, ...) are Better Auth's:
 * its own adapter reads and writes them, and `bun run auth:schema` compiles
 * their SQL. They are created by the baseline migration and are not declared
 * here, so Drizzle never diffs them. For the same reason `ficus_tree`'s
 * foreign key to `organization` lives in the baseline SQL only.
 */
import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** Each organization's trees: a tree is listed once an init answered 2xx. */
export const ficusTree = sqliteTable(
  "ficus_tree",
  {
    organizationId: text("organizationId").notNull(),
    name: text("name").notNull(),
    /** Milliseconds since the epoch. */
    createdAt: integer("createdAt").notNull(),
  },
  (table) => [primaryKey({ columns: [table.organizationId, table.name] })],
);
