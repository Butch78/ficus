import { describe, expect, test } from "bun:test";
import { allowance, allowlist, DAILY_CAPS, dayOf, metered, startsAgents } from "./usage.ts";

describe("metered", () => {
  test("starting built-in agents takes as many agent runs as it asks for, at least one", () => {
    expect(startsAgents("POST", "/tasks/7/agents")).toBe(true);
    expect(metered("POST", "/tasks/7/agents", JSON.stringify({ agents: 3, model: "m" }))).toEqual({ kind: "agents", count: 3 });
    expect(metered("POST", "/tasks/7/agents", "not json")).toEqual({ kind: "agents", count: 1 });
  });

  test("submitting or retrying an attempt takes a scoring; reads and everything else take nothing", () => {
    expect(metered("POST", "/attempts/9/submit", undefined)).toEqual({ kind: "scoring", count: 1 });
    expect(metered("POST", "/attempts/9/retry", undefined)).toEqual({ kind: "scoring", count: 1 });
    expect(metered("GET", "/tasks/7/agents", undefined)).toBeUndefined();
    expect(metered("POST", "/tasks", undefined)).toBeUndefined();
    expect(startsAgents("GET", "/tasks/7/agents")).toBe(false);
  });
});

describe("allowance", () => {
  test("fits up to the day's cap, and past it says how much was used and when it starts again", () => {
    expect(allowance("agents", DAILY_CAPS.agents - 2, 2)).toBeUndefined();

    const refused = allowance("agents", DAILY_CAPS.agents - 1, 2);

    expect(refused?.status).toBe(429);
    expect(refused?.message).toContain(`${DAILY_CAPS.agents - 1} of its ${DAILY_CAPS.agents} agent runs`);
    expect(refused?.message).toContain("00:00 UTC");
  });
});

describe("allowlist and days", () => {
  test("the allowlist is the configured slugs, and the day is UTC", () => {
    expect([...allowlist(" ficus , acme,,")]).toEqual(["ficus", "acme"]);
    expect(allowlist(undefined).size).toBe(0);
    expect(dayOf(Date.UTC(2026, 9, 12, 23, 59))).toBe("2026-10-12");
  });
});
