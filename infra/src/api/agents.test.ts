import { describe, expect, test } from "bun:test";
import { agentName, assignmentOf, optionsOf, startsAnAttempt } from "./agents.ts";

describe("startsAnAttempt", () => {
  test("is starting or retrying an attempt, posted", () => {
    expect(startsAnAttempt("POST", "/tasks/3/attempts")).toBe(true);
    expect(startsAnAttempt("POST", "/attempts/7/retry")).toBe(true);
    expect(startsAnAttempt("GET", "/tasks/3/attempts")).toBe(false);
    expect(startsAnAttempt("POST", "/attempts/7/submit")).toBe(false);
    expect(startsAnAttempt("POST", "/tasks")).toBe(false);
  });
});

describe("optionsOf", () => {
  test("reads start_agent and the models, and asks for nothing when the body says nothing", () => {
    expect(optionsOf('{"agent":"a","start_agent":false,"model":"m"}')).toEqual({ start_agent: false, model: "m" });
    expect(optionsOf("")).toEqual({});
    expect(optionsOf("not json")).toEqual({});
    expect(optionsOf('{"start_agent":"no"}')).toEqual({});
  });
});

describe("assignmentOf", () => {
  test("is the tree's answer with the tenant, the tree, and the models asked for", () => {
    const started = {
      attempt: 4,
      task: 1,
      intent: "do it",
      checks: [{ name: "done", run: "true" }],
      agent: "pi",
      remote: "https://x/git/r.git",
      token: "t",
      base_commit: "a".repeat(40),
      history: [],
    };

    expect(assignmentOf("abcd", "site", started, { scout_model: "s" })).toEqual({
      tenant: "abcd",
      tree: "site",
      attempt: 4,
      task: 1,
      intent: "do it",
      checks: [{ name: "done", run: "true" }],
      agent: "pi",
      remote: "https://x/git/r.git",
      token: "t",
      base_commit: "a".repeat(40),
      history: [],
      snapshot: null,
      scout_model: "s",
    });
    expect(agentName("abcd", "site", 4)).toBe("abcd-site-a4");
  });
});
