import { describe, expect, test } from "bun:test";
import { ending } from "./deploy.ts";

const report = { deployed: true, passed: true, millis: 5000, tail: "done" };

describe("ending", () => {
  test("a finished deploy is kept as it ended: complete with its report, or why it errored", () => {
    expect(ending("complete", report, undefined)).toEqual({ status: "complete", report, error: undefined });
    expect(ending("errored", undefined, "no sandbox")).toMatchObject({ status: "errored", error: "no sandbox" });
    expect(ending("terminated", undefined, undefined)?.status).toBe("terminated");
  });

  test("one still going is not kept: it can change", () => {
    for (const status of ["queued", "running", "waiting", "paused", "unknown"]) {
      expect(ending(status, undefined, undefined)).toBeUndefined();
    }
  });
});
