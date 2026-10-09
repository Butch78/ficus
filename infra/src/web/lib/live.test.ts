import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { AgentStatus, TaskRace, type AttemptState } from "./answers.ts";
import { agentMoving, agentsOf, liveKey, LiveRace, liveUrl, raceMoving, toLive } from "./live.ts";

const attempt = (id: number, state: AttemptState) => ({ id, task: 7, agent: `a${id}`, base: 0, repo: `t-a${id}`, state });

const race = Schema.decodeUnknownSync(TaskRace)({
  task: { id: 7, intent: "Add a health route", state: "Open" },
  head: 0,
  attempts: [{ attempt: attempt(9, "Working"), standing: "Working", report: null, agent: "@cf/moonshotai/kimi-k2.7-code" }],
  history: [],
});

const working = Schema.decodeUnknownSync(AgentStatus)({ state: "working", model: "m", calls: [] });

describe("live races", () => {
  test("travel as JSON and come back the same: agents keyed by attempt, null where unread", () => {
    const live = toLive(race, new Map([[9, working], [10, undefined]]));
    const back = Schema.decodeUnknownSync(LiveRace)(JSON.parse(JSON.stringify(live)));

    expect(back).toEqual(live);
    expect([...agentsOf(back)]).toEqual([[9, working], [10, undefined]]);
  });

  test("move while an attempt works or is checked, and stop once none does", () => {
    expect(raceMoving(toLive(race, new Map()))).toBe(true);
    expect(raceMoving(toLive({ ...race, attempts: [{ ...race.attempts[0]!, standing: "Best" }] }, new Map()))).toBe(false);
    expect(agentMoving(working)).toBe(true);
    expect(agentMoving({ ...working, state: "submitted" })).toBe(false);
  });

  test("are cached under one key per thing, and asked for at /api/live", () => {
    const ask = { kind: "race", org: "ficus", tree: "ficus", id: 7 } as const;

    expect(liveKey(ask)).toEqual(["race", "ficus", "ficus", 7]);
    expect(liveUrl(ask)).toBe("/api/live?kind=race&org=ficus&tree=ficus&id=7");
  });
});
