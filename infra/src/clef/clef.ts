/**
 * Clef, Cloudflare's decision model (`@cf/cloudflare/clef` on Workers AI),
 * asked yes/no questions about a piece of source.
 *
 * Clef answers with a probability per question rather than with prose,
 * which is what lets `review.ts` turn its answers into a pass/fail gate.
 * Only `noul` (yes/no) questions are modelled: the review has no use for
 * Clef's `choice` and `score` question types yet.
 */
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

export const NoulQuestion = Schema.Struct({
  type: Schema.Literal("noul"),
  instructions: Schema.String,
  criteria: Schema.Struct({ true: Schema.String, false: Schema.String }),
});

export interface NoulQuestion extends Schema.Schema.Type<typeof NoulQuestion> {}

export const SourceFile = Schema.Struct({ path: Schema.String, source: Schema.String });

export interface SourceFile extends Schema.Schema.Type<typeof SourceFile> {}

/** Probability of "yes", per question id. */
export type Answers = Readonly<Record<string, number>>;

const NoulAnswer = Schema.Struct({ noul: Schema.Number });

// Workers AI wraps every model's output in its own `result` envelope.
const RunResponse = Schema.Struct({
  result: Schema.Struct({ answers: Schema.Record(Schema.String, NoulAnswer) }),
});

export class ClefError extends Schema.TaggedError<ClefError>()("Clef.ClefError", {
  operation: Schema.String,
  cause: Schema.Defect(),
}) {}

/** A 429 or 5xx: the request was fine and is worth sending again. */
export class ClefUnavailable extends Schema.TaggedError<ClefUnavailable>()("Clef.ClefUnavailable", {
  status: Schema.Number,
}) {}

/** Any other non-2xx: retrying the same request will not help. */
export class ClefRejected extends Schema.TaggedError<ClefRejected>()("Clef.ClefRejected", {
  status: Schema.Number,
  body: Schema.String,
}) {}

export interface Interface {
  readonly ask: (
    file: SourceFile,
    questions: Readonly<Record<string, NoulQuestion>>,
  ) => Effect.Effect<Answers, ClefError | ClefUnavailable | ClefRejected>;
}

export class Service extends Context.Service<Service, Interface>()("@ficus/Clef") {}

const MODEL = "@cf/cloudflare/clef";

/**
 * Clef over the Workers AI REST API. Needs `CLOUDFLARE_ACCOUNT_ID` and a
 * `CLOUDFLARE_API_TOKEN` with Workers AI read access; neither has a default,
 * so a missing one fails at layer construction rather than mid-review.
 *
 * Raw `fetch` rather than Effect's HttpClient, which is still an unstable
 * API that the lint gate rejects; the boundary discipline is the same:
 * classify the status, then decode the body with a schema.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`;

    const send = Effect.fn("Clef.send")(function* (body: string) {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(url, {
            method: "POST",
            signal,
            headers: { authorization: `Bearer ${Redacted.value(token)}`, "content-type": "application/json" },
            body,
          }),
        catch: (cause) => new ClefError({ operation: "Clef.send", cause }),
      });

      if (response.status === 429 || response.status >= 500) {
        return yield* new ClefUnavailable({ status: response.status });
      }

      if (!response.ok) {
        const text = yield* Effect.tryPromise({
          try: () => response.text(),
          catch: (cause) => new ClefError({ operation: "Clef.readRejection", cause }),
        });

        return yield* new ClefRejected({ status: response.status, body: text });
      }

      return yield* Effect.tryPromise({
        try: () => response.json(),
        catch: (cause) => new ClefError({ operation: "Clef.readJson", cause }),
      });
    });

    const ask = Effect.fn("Clef.ask")(function* (
      file: SourceFile,
      questions: Readonly<Record<string, NoulQuestion>>,
    ) {
      const body = JSON.stringify({ model: "clef", state: file, questions });

      const json = yield* send(body).pipe(
        Effect.retry({
          while: Predicate.isTagged("Clef.ClefUnavailable"),
          schedule: Schedule.exponential("500 millis"),
          times: 3,
        }),
      );

      const decoded = yield* Schema.decodeUnknownEffect(RunResponse)(json).pipe(
        Effect.mapError((cause) => new ClefError({ operation: "Clef.decode", cause })),
      );

      const answers: Record<string, number> = {};

      for (const [id, answer] of Object.entries(decoded.result.answers)) {
        answers[id] = answer.noul;
      }

      return answers;
    });

    return Service.of({ ask });
  }),
);

export * as Clef from "./clef.ts";
