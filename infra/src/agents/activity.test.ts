import { describe, expect, test } from "bun:test";
import { activity, type Said, summarise } from "./activity.ts";

type Part = Extract<Said, { role: "assistant" }>["content"][number];

const assistant = (content: ReadonlyArray<Part>): Said => ({ role: "assistant", content });

const result = (toolCallId: string, isError: boolean): Said => ({ role: "toolResult", toolCallId, isError });

describe("activity", () => {
  test("lists the calls with their outcome and keeps the last words", () => {
    const messages: ReadonlyArray<Said> = [
      assistant([
        { type: "text", text: "Let me look at the code." },
        { type: "toolCall", id: "1", name: "read", arguments: { path: "/work/attempt/slug.py" } },
      ]),
      result("1", false),
      assistant([{ type: "toolCall", id: "2", name: "bash", arguments: { command: "devenv shell -- pytest\n -q" } }]),
      result("2", true),
      assistant([
        { type: "toolCall", id: "3", name: "edit", arguments: { path: "/work/attempt/slug.py" } },
        { type: "text", text: "Fixed the regex; running the tests again." },
      ]),
    ];

    expect(activity(messages)).toEqual({
      calls: [
        { id: "1", tool: "read", summary: "/work/attempt/slug.py", state: "ok" },
        { id: "2", tool: "bash", summary: "devenv shell -- pytest -q", state: "error" },
        { id: "3", tool: "edit", summary: "/work/attempt/slug.py", state: "running" },
      ],
      lastWords: "Fixed the regex; running the tests again.",
    });
  });

  test("an empty transcript has done nothing yet", () => {
    expect(activity([])).toEqual({ calls: [], lastWords: undefined });
  });
});

describe("summarise", () => {
  test("says the command, the path, or the submission", () => {
    expect(summarise("submit_attempt", {})).toBe("submit the attempt for scoring");
    expect(summarise("write", { path: "a.py", content: "x" })).toBe("a.py");
    expect(summarise("bash", { command: "x".repeat(300) })).toHaveLength(160);
  });
});
