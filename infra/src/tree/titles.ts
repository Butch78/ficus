/**
 * Task titles: a few words naming a task for people, written by a Workers AI
 * model from the task's intent and kept on the task (src/core/tree.ts
 * `titleTask`). Best effort: a task without a title shows its intent's first
 * sentence, so a model that fails or rambles leaves the page as it was.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as T from "../core/tree.ts";

/** What this module asks a chat model: a system and a user message, and an answer of a few words. */
interface Chat {
  readonly messages: ReadonlyArray<{ readonly role: "system" | "user"; readonly content: string }>;
  readonly max_tokens: number;
}

/** The part of a Workers AI binding (`env.AI`) this module calls; the answer is decoded as `Answer`. */
export interface TitleModel {
  readonly run: (model: string, inputs: Chat) => Promise<object>;
}

/**
 * Llama 3.3 70B, the fast build: about 0.4 s a title. A reasoning model
 * (the agents' scout, GLM 5.3 flash) wrote slightly better ones in 16 s.
 */
const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const INSTRUCTIONS =
  "You name changes to a code repository, like the subject line of a good commit. Reply with 3 to 7 words that say what the change does for a reader: start with an imperative verb (Add, Show, Fix, Keep, Draw, Let), sentence case, plain words, no quotes, no full stop. Reply with the title only.";

/** Enough of an intent to name it; intents can run to pages. */
const INTENT_CHARS = 4000;

/** Workers AI answers text models either way, by model. */
const Answer = Schema.Union([
  Schema.Struct({ response: Schema.String }),
  Schema.Struct({ choices: Schema.NonEmptyArray(Schema.Struct({ message: Schema.Struct({ content: Schema.String }) })) }),
]);

const decodeAnswer = Schema.decodeUnknownOption(Answer);

const textOf = (answer: typeof Answer.Type) => ("response" in answer ? answer.response : answer.choices[0].message.content);

/** A title for `intent`, or none when the model failed or said nothing usable. */
export const titleFor = Effect.fn("Titles.titleFor")(function* (ai: TitleModel, intent: string) {
  const answer = yield* Effect.tryPromise(() =>
    ai.run(MODEL, {
      messages: [
        { role: "system", content: INSTRUCTIONS },
        { role: "user", content: intent.slice(0, INTENT_CHARS) },
      ],
      max_tokens: 40,
    }),
  ).pipe(Effect.option);

  return Option.flatMap(Option.flatMap(answer, decodeAnswer), (decoded) => Option.fromUndefinedOr(T.cleanTitle(textOf(decoded))));
});
