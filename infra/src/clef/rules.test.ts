import { describe, expect, test } from "bun:test";
import * as DecisionModel from "effect/ai/DecisionModel";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { review } from "./review.ts";
import { ADVISE_AT, BLOCK_AT, findingsOf, SourceFile } from "./rules.ts";

const answer = (probability: number) => ({ probability });

/** A provider that answers every question about `path` with `probabilities[path]`, through DecisionModel's validation. */
const fakeModel = (probabilities: Readonly<Record<string, number>>, asked: Array<string>) =>
  Layer.effect(
    DecisionModel.DecisionModel,
    DecisionModel.make({
      decide: ({ state, decisions }) =>
        Schema.decodeUnknownEffect(SourceFile)(state).pipe(
          Effect.orDie,
          Effect.map(({ path }) => {
            asked.push(`${path}:${Object.keys(decisions).length}`);

            const answers = Object.fromEntries(
              Object.keys(decisions).map((key) => [
                key,
                { _tag: "Probability" as const, probability: key === "comment_restates_code" ? (probabilities[path] ?? 0) : 0 },
              ]),
            );

            return { answers, usage: { inputTokens: 1, outputTokens: 0 } };
          }),
        ),
    }),
  );

describe("findingsOf", () => {
  test("keeps answers at or above ADVISE_AT, blocks at BLOCK_AT, most probable first", () => {
    const findings = findingsOf("a.ts", {
      comment_restates_code: answer(ADVISE_AT),
      swallowed_failure: answer(0.95),
      unparsed_boundary: answer(ADVISE_AT - 0.01),
      vacuous_test: answer(BLOCK_AT),
    });

    expect(findings).toEqual([
      { path: "a.ts", rule: "swallowed_failure", probability: 0.95, blocking: true },
      { path: "a.ts", rule: "vacuous_test", probability: BLOCK_AT, blocking: true },
      { path: "a.ts", rule: "comment_restates_code", probability: ADVISE_AT, blocking: false },
    ]);
  });
});

describe("review", () => {
  test("asks every rule about every file and collects the findings", async () => {
    const asked: Array<string> = [];

    const findings = await Effect.runPromise(
      review([
        { path: "clean.ts", source: "" },
        { path: "slop.ts", source: "" },
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- each test is its own entry point
      ]).pipe(Effect.provide(fakeModel({ "slop.ts": 0.9, "clean.ts": 0.1 }, asked))),
    );

    expect(asked.toSorted()).toEqual(["clean.ts:4", "slop.ts:4"]);
    expect(findings).toEqual([{ path: "slop.ts", rule: "comment_restates_code", probability: 0.9, blocking: true }]);
  });

  test("fails when the model leaves a rule unanswered", async () => {
    const silent = Layer.effect(
      DecisionModel.DecisionModel,
      DecisionModel.make({ decide: () => Effect.succeed({ answers: {}, usage: { inputTokens: 1, outputTokens: 0 } }) }),
    );

    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- each test is its own entry point
    const result = await Effect.runPromise(Effect.result(review([{ path: "a.ts", source: "" }]).pipe(Effect.provide(silent))));

    expect(result._tag).toBe("Failure");
  });
});
