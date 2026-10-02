/**
 * Clef, Cloudflare's decision model (`@cf/cloudflare/clef` on Workers AI), as
 * an Effect `DecisionModel` provider. Callers describe what they want decided
 * with `effect/ai/Decision` and ask with `DecisionModel.decide`; this module
 * only translates to and from Clef's System One API:
 *
 *   Decision.probability  <->  noul    (probability of yes)
 *   Decision.classify     <->  choice  (one option of a set)
 *   Decision.rate         <->  score   (a position on ordered levels)
 *
 * `DecisionModel` encodes the input through its Schema and validates every
 * answer (its kind, labels, a distribution that sums to 1) before a caller
 * sees it. Another System One provider, such as `@effect/ai-typesafe` for
 * TypeSafe's Jev, is a different layer behind the same definitions.
 */
import * as AiError from "effect/ai/AiError";
import type * as Decision from "effect/ai/Decision";
import * as DecisionModel from "effect/ai/DecisionModel";
import * as Config from "effect/Config";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Match from "effect/Match";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

/**
 * `clef` by default; `clef-flash` is the smaller, faster sibling, for
 * decisions on a hot path where a little accuracy buys latency.
 */
export type Model = "clef" | "clef-flash";

const MODEL_IDS = { clef: "@cf/cloudflare/clef", "clef-flash": "@cf/cloudflare/clef-flash" } as const;

type Question =
  | {
      readonly type: "noul";
      readonly instructions: string;
      readonly criteria?: { readonly true: string; readonly false: string };
    }
  | { readonly type: "choice"; readonly instructions: string; readonly criteria: Readonly<Record<string, string>> }
  | { readonly type: "score"; readonly instructions: string; readonly criteria: ReadonlyArray<string> };

/** A Clef request: the model selector, the encoded input, the questions. */
export type Request = { model: Model; state: Schema.Json; questions: Readonly<Record<string, Question>> };

const Probabilities = Schema.Record(Schema.String, Schema.Number);

const Answer = Schema.Union([
  Schema.Struct({ type: Schema.Literal("noul"), noul: Schema.Number }),
  Schema.Struct({
    type: Schema.Literal("choice"),
    choice: Schema.String,
    probabilities: Probabilities,
    confidence: Schema.Number,
  }),
  // `probabilities` is keyed by level index: "0", "1", ...
  Schema.Struct({
    type: Schema.Literal("score"),
    score: Schema.Number,
    probabilities: Probabilities,
    confidence: Schema.Number,
  }),
]);

/** Clef's output, as the binding returns it. */
const Output = Schema.Struct({
  answers: Schema.Record(Schema.String, Answer),
  usage: Schema.optional(Schema.Struct({ input_tokens: Schema.Number, output_tokens: Schema.Number })),
});

export type Output = Schema.Schema.Type<typeof Output>;

// The REST API wraps every model's output in a `result` envelope.
const RunResponse = Schema.Struct({ result: Output });

const failure = (method: string, reason: AiError.AiErrorReason) => AiError.make({ module: "Clef", method, reason });

const unknownFailure = (method: string, cause: unknown) =>
  failure(method, new AiError.UnknownError({ description: String(cause) }));

const questionOf = (decision: Decision.Any): Question =>
  Match.valueTags(decision, {
    Probability: ({ instructions, criteria }): Question =>
      criteria === undefined ? { type: "noul", instructions } : { type: "noul", instructions, criteria },
    Classify: ({ instructions, criteria }): Question => ({ type: "choice", instructions, criteria }),
    Rate: ({ instructions, criteria }): Question => ({ type: "score", instructions, criteria }),
  });

const ProviderAnswer = Data.taggedEnum<DecisionModel.ProviderAnswer>();

/** Clef's answer to `decision`, as DecisionModel expects it; `undefined` leaves DecisionModel to fail on it. */
const answerOf = (decision: Decision.Any, answer: Output["answers"][string] | undefined): DecisionModel.ProviderAnswer | undefined => {
  if (answer?.type === "noul") {
    return ProviderAnswer.Probability({ probability: answer.noul });
  }

  if (answer?.type === "choice") {
    return ProviderAnswer.Classify({
      label: answer.choice,
      probabilities: answer.probabilities,
      confidence: answer.confidence,
    });
  }

  if (answer?.type === "score" && Predicate.isTagged(decision, "Rate")) {
    const probabilities: Record<string, number> = {};

    for (const [index, level] of decision.criteria.entries()) {
      const probability = answer.probabilities[String(index)];

      if (probability !== undefined) {
        probabilities[level] = probability;
      }
    }

    return ProviderAnswer.Rate({ rating: answer.score, probabilities, confidence: answer.confidence });
  }

  return undefined;
};

/** Clef as a `DecisionModel`, over `send`: one Workers AI call per `decide`. */
const make = (model: Model, send: (request: Request) => Effect.Effect<Output, AiError.AiError>) =>
  DecisionModel.make({
    // Clef's answers come rounded, as System One's do; DecisionModel
    // rescales the small drift that leaves in a distribution's sum.
    probabilityPrecision: 2,
    decide: Effect.fn("Clef.decide")(function* ({ state, decisions }) {
      const questions: Record<string, Question> = {};

      for (const [key, decision] of Object.entries(decisions)) {
        questions[key] = questionOf(decision);
      }

      const output = yield* send({ model, state, questions });
      const answers: Record<string, DecisionModel.ProviderAnswer> = {};

      for (const [key, decision] of Object.entries(decisions)) {
        const answer = answerOf(decision, output.answers[key]);

        if (answer !== undefined) {
          answers[key] = answer;
        }
      }

      return {
        answers,
        usage: { inputTokens: output.usage?.input_tokens, outputTokens: output.usage?.output_tokens },
      };
    }),
  });

/** The part of a Workers AI binding (`env.AI`) this module calls; Clef's output is decoded as `Output`. */
export interface AiBinding {
  readonly run: (model: string, inputs: Request) => Promise<object>;
}

/** Clef through a Worker's Workers AI binding. */
export const layerBinding = (ai: AiBinding, model: Model = "clef"): Layer.Layer<DecisionModel.DecisionModel> =>
  Layer.effect(
    DecisionModel.DecisionModel,
    make(model, (request) =>
      Effect.tryPromise({
        try: () => ai.run(MODEL_IDS[model], request),
        catch: (cause) => unknownFailure("run", cause),
      }).pipe(
        Effect.flatMap((output) =>
          Schema.decodeUnknownEffect(Output)(output).pipe(
            Effect.mapError((error) => failure("run", AiError.InvalidOutputError.fromSchemaError(error))),
          ),
        ),
      ),
    ),
  );

/**
 * Clef over the Workers AI REST API, for code running outside Workers.
 * Needs `CLOUDFLARE_ACCOUNT_ID` and a `CLOUDFLARE_API_TOKEN` with Workers AI
 * read access; neither has a default, so a missing one fails at layer
 * construction rather than mid-run.
 */
export const layerRest = (model: Model = "clef") =>
  Layer.effect(
    DecisionModel.DecisionModel,
    Effect.gen(function* () {
      const accountId = yield* Config.String("CLOUDFLARE_ACCOUNT_ID");
      const token = yield* Config.Redacted("CLOUDFLARE_API_TOKEN");

      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.bearerToken(token)),
        HttpClient.filterStatusOk,
        // 429, 5xx, timeouts and transport errors; a 4xx is the request's fault.
        HttpClient.retryTransient({ times: 3 }),
      );

      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${MODEL_IDS[model]}`;

      const send = (request: Request) =>
        HttpClientRequest.post(url).pipe(
          HttpClientRequest.bodyJson(request),
          Effect.flatMap((built) => client.execute(built)),
          Effect.flatMap((response) => response.json),
          Effect.flatMap(Schema.decodeUnknownEffect(RunResponse)),
          Effect.map((decoded) => decoded.result),
          Effect.catchTags({
            HttpClientError: (error) =>
              Effect.fail(
                Predicate.isTagged(error.reason, "StatusCodeError")
                  ? failure("run", AiError.reasonFromHttpStatus({ status: error.reason.response.status }))
                  : unknownFailure("run", error),
              ),
            SchemaError: (error) => Effect.fail(failure("run", AiError.InvalidOutputError.fromSchemaError(error))),
            HttpBodyError: (error) =>
              Effect.fail(failure("run", new AiError.InvalidRequestError({ description: error.message }))),
          }),
        );

      return yield* make(model, send);
    }),
  );

export * as Clef from "./clef.ts";
