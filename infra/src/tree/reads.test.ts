import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import { changedFiles, diffTrees, MAX_FILES, type Reader } from "./reads.ts";

/** An in-memory repo: trees by hash, blobs by hash. */
const memory = (trees: Readonly<Record<string, ReadonlyArray<ArtifactsTreeEntry>>>, blobs: Readonly<Record<string, string>>): Reader => ({
  readTree: async (hash) => (trees[hash] === undefined ? null : [...trees[hash]]),
  readBlob: async (hash) => (blobs[hash] === undefined ? null : new Blob([blobs[hash]])),
});

const blob = (name: string, hash: string): ArtifactsTreeEntry => ({ name, mode: "100644", hash, type: "blob" });

const dir = (name: string, hash: string): ArtifactsTreeEntry => ({ name, mode: "040000", hash, type: "tree" });

describe("a diff between two trees", () => {
  const repo = memory(
    {
      old: [blob("README.md", "r1"), dir("src", "src1"), blob("gone.txt", "g1")],
      new: [blob("README.md", "r1"), dir("src", "src2"), blob("new.txt", "n1")],
      src1: [blob("lib.ts", "l1"), blob("same.ts", "s1")],
      src2: [blob("lib.ts", "l2"), blob("same.ts", "s1")],
    },
    { r1: "readme\n", g1: "bye\n", n1: "hi\n", l1: "a\nb\n", l2: "a\nB\n", s1: "same\n" },
  );

  test("descends only where the trees differ, in path order", async () => {
    const { found, truncated } = await Effect.runPromise(changedFiles(repo, "old", "new"));

    expect(found.map((file) => file.path)).toEqual(["gone.txt", "new.txt", "src/lib.ts"]);
    expect(truncated).toBe(false);
  });

  test("names each change and diffs the text", async () => {
    const diff = await Effect.runPromise(diffTrees(repo, "old", "new"));

    expect(diff.files.map((file) => [file.path, file.change])).toEqual([
      ["gone.txt", "removed"],
      ["new.txt", "added"],
      ["src/lib.ts", "modified"],
    ]);
    expect(diff.files[2]?.content).toMatchObject({ kind: "text", additions: 1, deletions: 1 });
  });

  test("stops counting past the most files a reader is shown", async () => {
    const many = Array.from({ length: MAX_FILES + 5 }, (_, n) => blob(`f${String(n).padStart(4, "0")}`, `b${n}`));
    const { found, truncated } = await Effect.runPromise(changedFiles(memory({ new: many }, {}), undefined, "new"));

    expect([found.length, truncated]).toEqual([MAX_FILES, true]);
  });
});
