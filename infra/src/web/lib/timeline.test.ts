import { describe, expect, test } from "bun:test";
import { timeline } from "./timeline.ts";

const a = "a".repeat(40);

describe("timeline", () => {
  test("a working attempt has its scoring ahead of it", () => {
    expect(timeline("Working", 0).map((moment) => moment.status)).toEqual(["complete", "active", "pending", "pending"]);
  });

  test("a failing attempt says so, and that it cannot be accepted", () => {
    const moments = timeline({ Scored: { commit: a, score: { checks_passed: 1, checks_total: 2, cost: 4 } } }, 3);

    expect(moments[0]?.label).toBe("Sprouted from node 3");
    expect(moments.at(-2)).toEqual({ label: "Scored: 1 of 2 checks pass, a 4-line change", status: "error" });
    expect(moments.at(-1)?.label).toBe("Cannot be accepted");
  });

  test("a closed attempt ends with why", () => {
    expect(timeline({ Closed: { reason: { Retried: { into: 9 } } } }, 0).at(-1)).toEqual({
      label: "Closed: retried as attempt 9",
      status: "error",
    });
  });
});
