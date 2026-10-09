import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { AgentStatus, TaskRace, type AttemptState } from "./answers.ts";
import { agentAttempts, growing } from "./growing.ts";

const a = "a".repeat(40);

const attempt = (id: number, agent: string, state: AttemptState) => ({ id, task: 7, agent, base: 0, repo: `t-a${id}`, state });

// GET .../tasks/7 mid-race: an agent working, one being checked, one scored, one lost.
const race = Schema.decodeUnknownSync(TaskRace)({
  task: { id: 7, intent: "Add a health route", state: "Open" },
  head: 0,
  attempts: [
    { attempt: attempt(9, "kimi-1", "Working"), standing: "Working", report: null, agent: "@cf/moonshotai/kimi-k2.7-code" },
    { attempt: attempt(8, "me", { Checking: { commit: a } }), standing: "Checking", report: null, scoring: { entries: [{ step: "check", item: "test", state: "active", started_at: 1 }] } },
    { attempt: attempt(10, "kimi-2", { Scored: { commit: a, score: { checks_passed: 2, checks_total: 2, cost: 5 } } }), standing: "Best", report: null },
    { attempt: attempt(6, "kimi-3", { Closed: { reason: { Lost: { to: 10 } } } }), standing: { Closed: { reason: { Lost: { to: 10 } } } }, report: null },
    { attempt: attempt(11, "kimi-4", "Working"), standing: "Working", report: null },
  ],
  history: [],
});

const status = Schema.decodeUnknownSync(AgentStatus)({
  state: "working",
  phase: "change",
  model: "@cf/moonshotai/kimi-k2.7-code",
  calls: [{ id: "c1", tool: "edit", summary: "src/api/worker.ts", state: "running" }],
});

describe("growing", () => {
  test("says each attempt still in the race as it is now, oldest first; closed ones drop out", () => {
    const [story] = growing([race], new Map([[9, status]]));

    expect(story?.attempts.map(({ attempt, words, live }) => [attempt, words, live])).toEqual([
      [8, "Running check test, no network", true],
      [9, "edit: src/api/worker.ts", true],
      [10, "ready to accept", false],
      [11, "being worked on by hand", true],
    ]);
    expect(story?.live).toBe(true);
  });

  test("an agent that has not called a tool yet is reading its task", () => {
    expect(growing([race], new Map())[0]?.attempts[1]?.words).toBe("@cf/moonshotai/kimi-k2.7-code: reading the task");
  });

  test("a task with nothing left in its race, or no longer open, does not grow", () => {
    const quiet = { ...race, attempts: race.attempts.filter(({ attempt: { id } }) => id === 6) };

    expect(growing([quiet], new Map())).toEqual([]);
    expect(growing([{ ...race, task: { ...race.task, state: { Closed: { note: "dropped" } } } }], new Map())).toEqual([]);
  });

  test("the page asks after the attempts an agent is working", () => {
    expect(agentAttempts([race])).toEqual([9]);
  });
});
