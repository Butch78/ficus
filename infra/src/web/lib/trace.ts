/**
 * The UI's side of Cloudflare tracing: mark an operation's span so its trace
 * can be found again, and read that trace back from Workers Observability.
 *
 * A Worker cannot read its own trace id, so the operation is found by an
 * attribute the UI sets on its span (a fresh id, plus the organization),
 * and then the whole trace by the id that span carries.
 */
import { env, tracing } from "cloudflare:workers";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { OPERATION_ATTRIBUTE, ORG_ATTRIBUTE, TraceEvent } from "./activity.ts";

/** Run `work` inside a span marked with the operation and its organization. */
export const traced = <A>(name: string, org: string, operation: string, work: () => Promise<A>) =>
  tracing.startActiveSpan(name, async (span) => {
    span.setAttributes({ [OPERATION_ATTRIBUTE]: operation, [ORG_ATTRIBUTE]: org });

    try {
      return await work();
    } finally {
      span.end();
    }
  });

export class TraceUnavailable extends Schema.TaggedError<TraceUnavailable>()("Web.TraceUnavailable", {
  message: Schema.String,
}) {}

const Answer = Schema.Struct({
  success: Schema.Boolean,
  result: Schema.optional(
    Schema.Struct({ events: Schema.optional(Schema.Struct({ events: Schema.Array(TraceEvent) })) }),
  ),
});

/** How far back an operation's trace is looked for. */
const WINDOW_MS = 30 * 60 * 1000;

const query = Effect.fn("Web.traceQuery")(function* (filters: ReadonlyArray<{ readonly key: string; readonly value: string }>, limit: number) {
  const token = env.FICUS_OBSERVABILITY_TOKEN;
  const account = env.CLOUDFLARE_ACCOUNT_ID;

  if (token === undefined || token === "" || account === undefined) {
    return yield* new TraceUnavailable({ message: "tracing is not configured for this deployment" });
  }

  const now = Date.now();

  const body = JSON.stringify({
    queryId: "ficus-activity",
    timeframe: { from: now - WINDOW_MS, to: now },
    view: "events",
    limit,
    parameters: {
      filters: filters.map(({ key, value }) => ({ key, operation: "eq", type: "string", value })),
    },
  });

  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/workers/observability/telemetry/query`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body,
      }),
    catch: (cause) => new TraceUnavailable({ message: `Workers Observability is unreachable: ${String(cause)}` }),
  });

  const text = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new TraceUnavailable({ message: `Workers Observability's answer was cut off: ${String(cause)}` }),
  });

  const answer = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(Answer))(text).pipe(
    Effect.mapError((error) => new TraceUnavailable({ message: `unexpected answer: ${error.message}` })),
  );

  if (!answer.success) {
    return yield* new TraceUnavailable({ message: `Workers Observability refused the query (${response.status})` });
  }

  return answer.result?.events?.events ?? [];
});

/**
 * The events of the trace that carries `operation` for `org`: empty until
 * Cloudflare has ingested its spans, which takes a few seconds.
 */
export const operationTrace = Effect.fn("Web.operationTrace")(function* (org: string, operation: string) {
  const marked = yield* query(
    [
      { key: OPERATION_ATTRIBUTE, value: operation },
      { key: ORG_ATTRIBUTE, value: org },
    ],
    1,
  );

  const traceId = marked[0]?.$metadata.traceId;

  if (traceId === undefined) {
    return [];
  }

  return yield* query([{ key: "$metadata.traceId", value: traceId }], 500);
});
