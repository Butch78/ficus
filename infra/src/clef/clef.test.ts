import { describe, expect, test } from "bun:test";
import * as Decision from "effect/ai/Decision";
import * as DecisionModel from "effect/ai/DecisionModel";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { Clef } from "./clef.ts";

const Triage = Decision.make({
  input: Schema.Struct({ text: Schema.String }),
  decisions: {
    urgent: Decision.probability({ instructions: "Is `text` urgent?", criteria: { true: "Now", false: "Later" } }),
    team: Decision.classify({ instructions: "Which team?", criteria: { billing: "Payments", technical: "Bugs" } }),
    severity: Decision.rate({ instructions: "How severe?", criteria: ["low", "high"] }),
  },
});

/** A binding that records what it was sent and answers with `output`. */
const fakeAi = (output: Clef.Output) => {
  const sent: Array<{ model: string; inputs: Clef.Request }> = [];

  return {
    sent,
    ai: {
      run: (model: string, inputs: Clef.Request) => {
        sent.push({ model, inputs });

        return Promise.resolve(output);
      },
    },
  };
};

const decide = (ai: Clef.AiBinding, model?: Clef.Model) =>
  Effect.runPromise(
    DecisionModel.decide(Triage, { input: { text: "the site is down" } }).pipe(
      // oxlint-disable-next-line effecttsgo/strict-effect-provide -- each test is its own entry point
      Effect.provide(Clef.layerBinding(ai, model)),
      Effect.result,
    ),
  );

describe("layerBinding", () => {
  test("asks Clef each decision as its System One question, and reads the answers back typed", async () => {
    const { ai, sent } = fakeAi({
      answers: {
        urgent: { type: "noul", noul: 0.9 },
        team: { type: "choice", choice: "technical", probabilities: { billing: 0.2, technical: 0.8 }, confidence: 0.6 },
        severity: { type: "score", score: 0.7, probabilities: { 0: 0.3, 1: 0.7 }, confidence: 0.4 },
      },
      usage: { input_tokens: 42, output_tokens: 0 },
    });

    const result = await decide(ai, "clef-flash");

    expect(sent).toEqual([
      {
        model: "@cf/cloudflare/clef-flash",
        inputs: {
          model: "clef-flash",
          state: { text: "the site is down" },
          questions: {
            urgent: { type: "noul", instructions: "Is `text` urgent?", criteria: { true: "Now", false: "Later" } },
            team: { type: "choice", instructions: "Which team?", criteria: { billing: "Payments", technical: "Bugs" } },
            severity: { type: "score", instructions: "How severe?", criteria: ["low", "high"] },
          },
        },
      },
    ]);

    expect(Result.isSuccess(result)).toBe(true);

    if (Result.isSuccess(result)) {
      const { answers, usage } = result.success;

      expect(answers.urgent.probability).toBe(0.9);
      expect(answers.team.label).toBe("technical");
      expect({ ...answers.severity.probabilities }).toEqual({ low: 0.3, high: 0.7 });
      expect([answers.severity.rating, answers.severity.label]).toEqual([0.7, "high"]);
      expect(usage.inputTokens).toBe(42);
    }
  });

  test("fails when Clef leaves a decision unanswered or answers it as another kind", async () => {
    const missing = fakeAi({ answers: { urgent: { type: "noul", noul: 0.9 } } });

    const mismatched = fakeAi({
      answers: {
        urgent: { type: "noul", noul: 0.9 },
        team: { type: "noul", noul: 0.5 },
        severity: { type: "score", score: 1, probabilities: { 0: 0, 1: 1 }, confidence: 1 },
      },
    });

    expect(Result.isFailure(await decide(missing.ai))).toBe(true);
    expect(Result.isFailure(await decide(mismatched.ai))).toBe(true);
  });

  test("fails, rather than throwing, when the binding does", async () => {
    const result = await decide({ run: () => Promise.reject(new Error("Workers AI is down")) });

    expect(Result.isFailure(result)).toBe(true);
  });
});
