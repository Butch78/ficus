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
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

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

export interface Interface {
  readonly ask: (
    file: SourceFile,
    questions: Readonly<Record<string, NoulQuestion>>,
  ) => Effect.Effect<Answers, ClefError>;
}

export class Service extends Context.Service<Service, Interface>()("@ficus/Clef") {}

const MODEL = "@cf/cloudflare/clef";

/**
 * Clef over the Workers AI REST API. Needs `CLOUDFLARE_ACCOUNT_ID` and a
 * `CLOUDFLARE_API_TOKEN` with Workers AI read access; neither has a default,
 * so a missing one fails at layer construction rather than mid-review.
 */
export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
    const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");

    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
      HttpClient.filterStatusOk,
      // 429, 5xx, timeouts and transport errors; a 4xx is the request's fault.
      HttpClient.retryTransient({ times: 3 }),
    );

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL}`;

    const ask = Effect.fn("Clef.ask")(
      function* (file: SourceFile, questions: Readonly<Record<string, NoulQuestion>>) {
        const request = yield* HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyJson({ model: "clef", state: file, questions }),
        );

        const response = yield* client.execute(request);
        const decoded = yield* Schema.decodeUnknownEffect(RunResponse)(yield* response.json);
        const answers: Record<string, number> = {};

        for (const [id, answer] of Object.entries(decoded.result.answers)) {
          answers[id] = answer.noul;
        }

        return answers;
      },
      (effect) => effect.pipe(Effect.mapError((cause) => new ClefError({ operation: "Clef.ask", cause }))),
    );

    return Service.of({ ask });
  }),
);

export * as Clef from "./clef.ts";
