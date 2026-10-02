import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { TENANT_KEY_LENGTH, tenantKey } from "./tenant.ts";

describe("tenantKey", () => {
  test("is lowercase base32 of the fixed length, and stable", async () => {
    const key = await Effect.runPromise(tenantKey("org_123"));

    expect(key).toMatch(/^[a-z2-7]+$/);
    expect(key.length).toBe(TENANT_KEY_LENGTH);
    expect(await Effect.runPromise(tenantKey("org_123"))).toBe(key);
  });

  test("matches SHA-256's leading bits", async () => {
    // Independently: base64.b32encode(sha256(b"abc")).lower()[:10] in Python.
    expect(await Effect.runPromise(tenantKey("abc"))).toBe("xj4bnp4pah");
  });

  test("differs between organizations", async () => {
    const [a, b] = await Effect.runPromise(Effect.all([tenantKey("org_a"), tenantKey("org_b")]));

    expect(a).not.toBe(b);
  });
});
