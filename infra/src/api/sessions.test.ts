import { describe, expect, test } from "bun:test";
import { KV_MIN_TTL, kvSessions, type SessionKv } from "./sessions.ts";

/** A KV namespace in a Map, recording each put's options. */
const fakeKv = () => {
  const values = new Map<string, string>();
  const puts: Array<{ readonly key: string; readonly options: { readonly expirationTtl?: number } | undefined }> = [];

  const kv: SessionKv = {
    get: async (key: string) => values.get(key) ?? null,
    put: async (key: string, value: string, options?: { readonly expirationTtl?: number }) => {
      values.set(key, value);
      puts.push({ key, options });
    },
    delete: async (key: string) => {
      values.delete(key);
    },
  };

  return { kv, puts };
};

describe("kvSessions", () => {
  test("stores, reads and deletes; a short ttl is raised to KV's minimum", async () => {
    const { kv, puts } = fakeKv();
    const store = kvSessions(kv);

    await store.set("s", "v", 5);
    await store.set("t", "w", 7 * 24 * 60 * 60);
    await store.set("u", "x");

    expect(await store.get("s")).toBe("v");
    expect(puts.map((put) => put.options)).toEqual([{ expirationTtl: KV_MIN_TTL }, { expirationTtl: 7 * 24 * 60 * 60 }, undefined]);

    await store.delete("s");

    expect(await store.get("s")).toBeNull();
  });

  test("refuses what KV cannot do atomically", async () => {
    const store = kvSessions(fakeKv().kv);

    expect(Promise.resolve(store.getAndDelete("k"))).rejects.toThrow();
    expect(Promise.resolve(store.increment("k", 60))).rejects.toThrow();
  });
});
