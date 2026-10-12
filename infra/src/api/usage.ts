/**
 * What an organization may use of Ficus's own account each day. Built-in
 * agents run on Ficus's Workers AI and scoring on its containers, and sign-up
 * is open, so the Api meters both: built-in agents start only for
 * organizations on the allowlist, and each organization's agent runs and
 * scorings have a daily cap. Agents an organization brings itself (an API key
 * and `scripts/attempt`, or any client) pay for their own AI; only their
 * scoring counts here.
 */
import { and, eq, sql } from "drizzle-orm";
import * as D1Drizzle from "drizzle-orm/effect-d1";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { ficusUsage } from "./schema.ts";

/** Each kind's daily cap per organization. */
export const DAILY_CAPS = { agents: 20, scoring: 60 } as const;

export type UsageKind = keyof typeof DAILY_CAPS;

/** What the Api meters in a request to a tree: starting built-in agents, or submitting an attempt to be scored. */
export type Metered = { readonly kind: UsageKind; readonly count: number } | undefined;

const AGENTS = /^\/tasks\/\d+\/agents$/u;

const SUBMIT = /^\/attempts\/\d+\/(?:submit|retry)$/u;

const AgentsBody = Schema.Struct({ agents: Schema.Number });

const decodeAgents = Schema.decodeUnknownOption(Schema.fromJsonString(AgentsBody));

/** Whether a request to a tree's `rest` starts built-in agents: its body says how many, so the Api reads a copy. */
export const startsAgents = (method: string, rest: string) => method === "POST" && AGENTS.test(rest);

/** The usage a request to a tree's `rest` would take: agents by the number asked for (`body`, read from a clone), a scoring per submit or retry. */
export const metered = (method: string, rest: string, body: string | undefined): Metered => {
  if (method !== "POST") {
    return undefined;
  }

  if (AGENTS.test(rest)) {
    const asked = Option.getOrUndefined(decodeAgents(body ?? ""));

    return { kind: "agents", count: asked === undefined ? 1 : Math.max(1, Math.floor(asked.agents)) };
  }

  return SUBMIT.test(rest) ? { kind: "scoring", count: 1 } : undefined;
};

/** The organizations built-in agents run for, from the Api's `FICUS_AGENT_ORGS` (comma-separated slugs). */
export const allowlist = (configured: string | undefined) =>
  new Set((configured ?? "").split(",").map((slug) => slug.trim()).filter((slug) => slug !== ""));

/** Why the Api refused a metered request, said for the person who sent it. */
export class UsageRefused extends Schema.TaggedError<UsageRefused>()("Usage.Refused", {
  status: Schema.Number,
  message: Schema.String,
}) {}

/** Built-in agents for an organization not on the allowlist: refused, with the ways it can still work. */
export const notAllowed = () =>
  new UsageRefused({
    status: 403,
    message:
      "built-in agents run on Ficus's own Workers AI only for organizations on its allowlist; bring your own agent with an API key (see scripts/attempt), which pays for its own AI",
  });

/** Whether taking `count` more of `kind` fits the day's cap after `used`; the refusal when it does not. */
export const allowance = (kind: UsageKind, used: number, count: number) => {
  const cap = DAILY_CAPS[kind];

  if (used + count <= cap) {
    return undefined;
  }

  const what = kind === "agents" ? "agent runs" : "scorings";

  return new UsageRefused({
    status: 429,
    message: `this organization has used ${used} of its ${cap} ${what} for today (asked for ${count} more); the count starts again at 00:00 UTC`,
  });
};

/** The UTC day of `now` (milliseconds), as the usage table keys it. */
export const dayOf = (now: number) => new Date(now).toISOString().slice(0, 10);

/** Drizzle over the request's `D1Client` (the Api provides it per request, as for the directory). */
const usage = D1Drizzle.makeWithDefaults({});

const UsageFailure = (cause: { readonly message: string }) => new UsageRefused({ status: 503, message: `could not count usage: ${cause.message}` });

/** Take `count` more of `kind` for the organization today, or refuse past the cap. */
export const take = Effect.fn("Usage.take")(function* (organizationId: string, kind: UsageKind, count: number, now: number) {
  yield* Effect.annotateCurrentSpan({ "ficus.usage.kind": kind, "ficus.usage.count": count });

  const db = yield* usage;
  const day = dayOf(now);
  const key = and(eq(ficusUsage.organizationId, organizationId), eq(ficusUsage.day, day), eq(ficusUsage.kind, kind));

  const rows = yield* db.select({ count: ficusUsage.count }).from(ficusUsage).where(key).pipe(Effect.mapError(UsageFailure));
  const refused = allowance(kind, rows[0]?.count ?? 0, count);

  if (refused !== undefined) {
    return yield* refused;
  }

  yield* db
    .insert(ficusUsage)
    .values({ organizationId, day, kind, count })
    .onConflictDoUpdate({ target: [ficusUsage.organizationId, ficusUsage.day, ficusUsage.kind], set: { count: sql`${ficusUsage.count} + ${count}` } })
    .pipe(Effect.mapError(UsageFailure));
});
