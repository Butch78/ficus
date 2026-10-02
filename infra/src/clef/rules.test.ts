import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Clef } from "./clef.ts";
import { review } from "./review.ts";
import { ADVISE_AT, BLOCK_AT, findingsOf } from "./rules.ts";

describe("findingsOf", () => {
  test("keeps answers at or above ADVISE_AT, blocks at BLOCK_AT, most probable first", () => {
    const findings = findingsOf("a.ts", {
      comment_restates_code: ADVISE_AT,
      swallowed_failure: 0.95,
      unparsed_boundary: ADVISE_AT - 0.01,
      vacuous_test: BLOCK_AT,
    });

    expect(findings).toEqual([
      { path: "a.ts", rule: "swallowed_failure", probability: 0.95, blocking: true },
      { path: "a.ts", rule: "vacuous_test", probability: BLOCK_AT, blocking: true },
      { path: "a.ts", rule: "comment_restates_code", probability: ADVISE_AT, blocking: false },
    ]);
  });

  test("ignores answers to questions it did not ask", () => {
    expect(findingsOf("a.ts", { some_other_question: 1 })).toEqual([]);
  });
});

describe("review", () => {
  test("asks every rule about every file and collects the findings", async () => {
    const asked: Array<string> = [];

    const fake = Layer.succeed(
      Clef.Service,
      Clef.Service.of({
        ask: (file, questions) =>
          Effect.sync(() => {
            asked.push(`${file.path}:${Object.keys(questions).length}`);

            return file.path === "slop.ts" ? { comment_restates_code: 0.9 } : { comment_restates_code: 0.1 };
          }),
      }),
    );

    const findings = await Effect.runPromise(
      review([
        { path: "clean.ts", source: "" },
        { path: "slop.ts", source: "" },
        // oxlint-disable-next-line effecttsgo/strict-effect-provide -- each test is its own entry point
      ]).pipe(Effect.provide(fake)),
    );

    expect(asked.toSorted()).toEqual(["clean.ts:4", "slop.ts:4"]);
    expect(findings).toEqual([{ path: "slop.ts", rule: "comment_restates_code", probability: 0.9, blocking: true }]);
  });
});
