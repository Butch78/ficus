import { describe, expect, test } from "bun:test";
import { pattern } from "./routes.ts";

describe("the tree's routes", () => {
  test("name ids and reads by their place", () => {
    const cases = [
      [{ kind: "", id: "", action: "" }, ""],
      [{ kind: "behind", id: "", action: "" }, "behind"],
      [{ kind: "tasks", id: "4", action: "" }, "tasks/:id"],
      [{ kind: "tasks", id: "4", action: "agents" }, "tasks/:id/agents"],
      [{ kind: "attempts", id: "7", action: "agent" }, "attempts/:id/agent"],
      [{ kind: "attempts", id: "7", action: "diff" }, "attempts/:id/:read"],
      [{ kind: "nodes", id: "0", action: "file" }, "nodes/:id/:read"],
      [{ kind: "attempts", id: "7", action: "submit" }, "attempts/:id/submit"],
    ] as const;

    for (const [route, expected] of cases) {
      expect(pattern(route)).toBe(expected);
    }
  });
});
