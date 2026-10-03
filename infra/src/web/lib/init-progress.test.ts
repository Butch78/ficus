import { describe, expect, test } from "bun:test";
import { apply, connected, description, label, INIT_STEPS, type InitProgress, refused, split, started } from "./init-progress.ts";

// The lines an init from GitHub streamed on pr-1, in order.
const INIT = [
  '{"kind":"step","step":"import","state":"active","detail":"https://github.com/Butch78/ficus"}',
  '{"kind":"step","step":"import","state":"complete"}',
  '{"kind":"step","step":"settle","state":"active"}',
  '{"kind":"step","step":"settle","state":"active","detail":"still importing, check 1 of 30"}',
  '{"kind":"step","step":"settle","state":"complete","detail":"a8e62831c0ffee"}',
  '{"kind":"step","step":"lock","state":"active"}',
  '{"kind":"step","step":"lock","state":"complete"}',
  '{"kind":"step","step":"save","state":"active"}',
  '{"kind":"step","step":"save","state":"complete"}',
  '{"kind":"outcome","status":200,"body":{"name":"t-site"}}',
  '{"kind":"step","step":"record","state":"complete"}',
];

const statuses = (progress: InitProgress) => INIT_STEPS.map((step) => progress.steps.get(step)?.status);

describe("an init's progress", () => {
  test("starts with the membership check, the rest to come", () => {
    expect(statuses(started(0))).toEqual(["active", "pending", "pending", "pending", "pending", "pending"]);
  });

  test("ticks steps off as their lines arrive", () => {
    let progress: InitProgress = connected(started(0), 10);

    progress = apply(progress, INIT[0] ?? "", 20);
    expect(statuses(progress)).toEqual(["complete", "active", "pending", "pending", "pending", "pending"]);

    progress = INIT.slice(1, 4).reduce((current, line) => apply(current, line, 30), progress);
    expect(progress.steps.get("settle")).toEqual({
      status: "active",
      detail: "still importing, check 1 of 30",
      startedAt: 30,
      endedAt: undefined,
    });

    progress = INIT.slice(4).reduce((current, line) => apply(current, line, 40), progress);
    expect(statuses(progress)).toEqual(["complete", "complete", "complete", "complete", "complete", "complete"]);
    expect(progress.outcome).toEqual({ succeeded: true, message: "" });
  });

  test("a refusal in the outcome carries its reason", () => {
    const progress = apply(connected(started(0), 1), '{"kind":"outcome","status":409,"body":"tree already initialized"}', 2);

    expect(progress.outcome).toEqual({ succeeded: false, message: "tree already initialized" });
  });

  test("a failed step and a refusal before streaming", () => {
    const failed = apply(
      started(0),
      '{"kind":"step","step":"import","state":"error","detail":"Artifacts NOT_FOUND: no such repository"}',
      5,
    );

    expect(failed.steps.get("import")?.status).toBe("error");
    expect(failed.steps.get("import")?.detail).toBe("Artifacts NOT_FOUND: no such repository");
    expect(refused(started(0), "no organization x that you belong to", 3).outcome).toEqual({
      succeeded: false,
      message: "no organization x that you belong to",
    });
  });

  test("unknown and broken lines change nothing", () => {
    const progress = started(0);

    expect(apply(progress, '{"kind":"step","step":"create","state":"active"}', 1)).toBe(progress);
    expect(apply(progress, "not json", 1)).toBe(progress);
  });
});

describe("split", () => {
  test("keeps an unfinished line for the next chunk", () => {
    expect(split('{"a":1}\n{"b":')).toEqual({ lines: ['{"a":1}'], rest: '{"b":' });
    expect(split("\n\n")).toEqual({ lines: [], rest: "" });
  });
});

describe("label", () => {
  test("says what a step is doing, then what it did", () => {
    const context = { org: "acme", source: "https://github.com/o/r" };

    expect(label("import", "active", context)).toBe("Asking Artifacts to import https://github.com/o/r");
    expect(label("record", "complete", context)).toBe("Listed the tree in acme");
  });
});

describe("description", () => {
  const step = (status: "active" | "complete" | "error", detail: string) => ({ status, detail, startedAt: 0, endedAt: 1 });

  test("adds what the label does not say", () => {
    expect(description("import", step("active", "https://github.com/o/r"))).toBeUndefined();
    expect(description("import", step("error", "Artifacts NOT_FOUND"))).toBe("Artifacts NOT_FOUND");
    expect(description("settle", step("active", "still importing, check 2 of 30"))).toBe("still importing, check 2 of 30");
    expect(description("settle", step("complete", "a8e62831882243b4586ed535d722feb77636c7dd"))).toBe("at a8e62831");
  });
});
