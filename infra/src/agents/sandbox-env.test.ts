import { describe, expect, test } from "bun:test";
import { timeoutMs } from "./sandbox-env.ts";

describe("timeoutMs", () => {
  test("turns pi's seconds into the sandbox's milliseconds", () => {
    // An agent that asks for 10 minutes gets 10 minutes, not 600 ms.
    expect(timeoutMs(600)).toBe(600_000);
    expect(timeoutMs(undefined)).toBeUndefined();
  });
});
