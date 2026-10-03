/**
 * An organization's tenant key: the prefix of every name its trees create
 * (src/tree/tenant.ts takes it on the other side).
 *
 * Derived, not stored: the first 50 bits of SHA-256(organization id) in
 * lowercase base32. Ten characters keep repo names short (Artifacts allows
 * 63) and a collision needs ~2^25 organizations before it is even likely.
 */
import * as Effect from "effect/Effect";

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export const TENANT_KEY_LENGTH = 10;

export const TENANT_HEADER = "x-ficus-tenant";

export const tenantKey = Effect.fn("Tenant.key")(function* (organizationId: string) {
  const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", new TextEncoder().encode(organizationId)));
  const bytes = new Uint8Array(digest);
  let bits = 0;
  let buffer = 0;
  let key = "";

  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;

    while (bits >= 5 && key.length < TENANT_KEY_LENGTH) {
      bits -= 5;
      key += ALPHABET[(buffer >> bits) & 31];
    }

    if (key.length === TENANT_KEY_LENGTH) {
      break;
    }
  }

  return key;
});
