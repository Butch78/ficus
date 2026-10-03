import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { getMigrations } from "better-auth/db/migration";
import { authOptions } from "./auth.ts";

const MIGRATIONS = new URL("./migrations/", import.meta.url);

/** Every migration's SQL, in the order the database applies them. */
const chain = async () => {
  const names = (await readdir(MIGRATIONS.pathname)).filter((entry) => /^\d{14}_/.test(entry)).sort();

  return Promise.all(names.map((name) => Bun.file(new URL(`${name}/migration.sql`, MIGRATIONS)).text()));
};

describe("the Api's migrations", () => {
  test("apply to an empty database, and again over themselves (stages migrated before Drizzle)", async () => {
    const db = new Database(":memory:");
    const migrations = await chain();

    for (const sql of [...migrations, ...migrations]) {
      db.exec(sql);
    }

    const tables = db.query("select name from sqlite_master where type = 'table' order by name").all();

    expect(tables).toContainEqual({ name: "ficus_tree" });
    expect(tables).toContainEqual({ name: "organization" });
  });

  test("leave Better Auth nothing to add (`bun run auth:schema` would write nothing)", async () => {
    const db = new Database(":memory:");

    for (const sql of await chain()) {
      db.exec(sql);
    }

    const pending = await getMigrations(authOptions(db, "schema-only-secret-not-used-for-anything", "http://localhost"));

    expect([...pending.toBeCreated, ...pending.toBeAdded].map((change) => change.table)).toEqual([]);
  });
});
