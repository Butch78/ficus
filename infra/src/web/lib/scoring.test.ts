import { describe, expect, test } from "bun:test";
import { current, elapsed, scoringLabel } from "./scoring.ts";

const entry = (step: string, state: "active" | "complete" | "error", item?: string) => {
  const started = { step, state, started_at: 1000 };

  return item === undefined ? started : { ...started, item };
};

describe("scoring, in words", () => {
  test("says each step while it runs and once it is done", () => {
    expect(scoringLabel(entry("devenv", "active"))).toBe("Building the root's devenv shell (slow the first time)");
    expect(scoringLabel(entry("restore", "complete"))).toBe("Put the root's checks back: the attempt cannot change them");
    expect(scoringLabel(entry("check", "active", "tests"))).toBe("Running check tests, no network");
    expect(scoringLabel(entry("check", "error", "tests"))).toBe("Check tests failed");
  });

  test("the current step is the running one, else the last", () => {
    const ledger = { entries: [entry("sandbox", "complete"), entry("clone", "active"), entry("restore", "complete")] };

    expect(current(ledger)?.step).toBe("clone");
    expect(current({ entries: [entry("sandbox", "complete"), entry("cost", "complete")] })?.step).toBe("cost");
  });

  test("elapsed reads in seconds, then minutes", () => {
    expect(elapsed({ ...entry("devenv", "active") }, 13_500)).toBe("12.5 s");
    expect(elapsed({ ...entry("devenv", "complete"), ended_at: 96_000 }, 0)).toBe("1m 35s");
  });
});
