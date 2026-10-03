import { describe, expect, test } from "bun:test";
import { afterSuccess, stepLine, succeeded } from "./progress.ts";

const stream = (...chunks: ReadonlyArray<string>) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk));
      }

      controller.close();
    },
  });

const recorded = () => Promise.resolve(stepLine("record", "complete"));

describe("succeeded", () => {
  test("is a 2xx outcome line, and nothing else", () => {
    expect(succeeded('{"kind":"outcome","status":200,"body":{}}')).toBe(true);
    expect(succeeded('{"kind":"outcome","status":202,"body":{}}')).toBe(true);
    expect(succeeded('{"kind":"outcome","status":409,"body":"tree already initialized"}')).toBe(false);
    expect(succeeded('{"kind":"step","step":"save","state":"complete"}')).toBe(false);
    expect(succeeded("not json")).toBe(false);
  });
});

describe("afterSuccess", () => {
  test("passes the stream through and appends the Api's step after a success", async () => {
    const out = await new Response(
      afterSuccess(stream('{"kind":"step","step":"save","state":"complete"}\n{"kind":"out', 'come","status":200,"body":{}}\n'), recorded),
    ).text();

    expect(out.trim().split("\n").map((line) => JSON.parse(line).kind)).toEqual(["step", "outcome", "step"]);
    expect(out.endsWith(stepLine("record", "complete"))).toBe(true);
  });

  test("appends nothing after a refusal", async () => {
    const refused = '{"kind":"outcome","status":409,"body":"tree already initialized"}\n';

    expect(await new Response(afterSuccess(stream(refused), recorded)).text()).toBe(refused);
  });
});
