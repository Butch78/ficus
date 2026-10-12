/**
 * Sessions in Workers KV: Better Auth's secondary storage (auth.ts), so a
 * request's session is read at the edge rather than from D1. Sessions are
 * also written to D1 (`storeSessionInDatabase`), but read only from here.
 *
 * Only sessions come here. Verification values (OAuth state, sign-in tokens)
 * stay in D1, where Better Auth consumes them in a transaction, and rate limits
 * in memory: KV has no atomic read-and-delete or increment, and takes about
 * one write a second per key. So `getAndDelete` and `increment` refuse.
 */
import type { BetterAuthOptions } from "better-auth";

/** KV's shortest expiry, in seconds: a shorter one is refused. */
export const KV_MIN_TTL = 60;

type SessionStore = NonNullable<BetterAuthOptions["secondaryStorage"]>;

/** The part of a KV namespace sessions use (a Workers `KVNamespace` is one). */
export interface SessionKv {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { readonly expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Never called with verification values in D1 and rate limits in memory; refusing keeps a misconfiguration from going unseen. */
const unsupported = (what: string) => () => Promise.reject(new Error(`sessions in KV cannot ${what}: verification values and rate limits are kept elsewhere`));

/** Better Auth's secondary storage on `kv`; `ttl` in seconds, raised to KV's minimum. */
export const kvSessions = (kv: SessionKv): SessionStore => ({
  get: (key) => kv.get(key),
  set: (key, value, ttl) => kv.put(key, value, ttl === undefined ? undefined : { expirationTtl: Math.max(KV_MIN_TTL, Math.ceil(ttl)) }),
  delete: (key) => kv.delete(key),
  getAndDelete: unsupported("read and delete at once"),
  increment: unsupported("count"),
});
