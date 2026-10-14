import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { ConflictBrief, conflictBrief, conflictInstructions, conflictPaths, DIFF_MAX, FILE_MAX, FILES_MAX, unifiedDiff } from "./conflict.ts";
import { content, type FileDiff } from "./diff.ts";
import { AttemptId, NodeId } from "./values.ts";

const bytes = (text: string) => new TextEncoder().encode(text);

const slug: FileDiff = { path: "slug.py", change: "modified", content: content(bytes("a\nb\n"), bytes("a\nB\n")) };

describe("a conflict handed to an agent", () => {
  test("names the paths the sandbox reported, else the ones both sides touched", () => {
    expect(conflictPaths("the attempt's commits do not apply on the head: conflicts in slug.py, lib/a.ts", ["x"])).toEqual(["slug.py", "lib/a.ts"]);
    expect(conflictPaths("the attempt's commits do not apply on the head: conflicts in CONFLICT (content): could not apply", ["slug.py"])).toEqual(["slug.py"]);
    expect(conflictPaths("head does not descend from base", ["slug.py"])).toEqual(["slug.py"]);
  });

  test("shows the attempt's change as a unified diff", () => {
    expect(unifiedDiff([slug, { path: "logo.png", change: "added", content: { kind: "binary" } }])).toBe(
      ["--- a/slug.py", "+++ b/slug.py", "@@ -1,2 +1,2 @@", " a", "-b", "+B", "--- /dev/null", "+++ b/logo.png", "(binary)"].join("\n"),
    );
  });

  test("is bounded for a model's context, and travels as JSON", () => {
    const huge: FileDiff = { path: "big.txt", change: "added", content: content(undefined, bytes("x\n".repeat(DIFF_MAX))) };
    const files = Array.from({ length: FILES_MAX + 2 }, (_, at) => ({ path: `f${at}`, content: bytes("y".repeat(FILE_MAX + 1)) }));
    const brief = conflictBrief(AttemptId.make(7), NodeId.make(4), ["f0"], [huge], [{ path: "gone", content: undefined }, { path: "png", content: new Uint8Array([0xff, 0xfe]) }, ...files]);

    expect(brief.intended.length).toBeLessThan(DIFF_MAX + 100);
    expect(brief.intended).toEndWith(`(diff cut at ${DIFF_MAX} characters)`);
    expect(brief.head_files).toHaveLength(FILES_MAX);
    expect(brief.head_files.slice(0, 3)).toEqual([
      { path: "gone", content: "", truncated: false },
      { path: "png", content: "", truncated: false },
      { path: "f0", content: "y".repeat(FILE_MAX), truncated: true },
    ]);
    expect(Schema.decodeUnknownSync(ConflictBrief)(JSON.parse(JSON.stringify(brief)))).toEqual(brief);
  });

  test("tells the agent what conflicted and to re-apply the change on the head", () => {
    const words = conflictInstructions(conflictBrief(AttemptId.make(7), NodeId.make(4), ["slug.py"], [slug], [{ path: "slug.py", content: bytes("A\nb\n") }]));

    expect(words).toContain("Replaying its commits onto node 4 conflicted in slug.py.");
    expect(words).toContain("Re-apply that attempt's intent");
    expect(words).toContain("-b\n+B");
    expect(words).toContain("slug.py on the head:\n```\nA\nb\n\n```");
  });
});
