import { describe, expect, test } from "bun:test";
import { diffKey, isCommitId, KEPT_MAX_BYTES, keepable, KEY_MAX_BYTES, logKey, readKey } from "./kept.ts";

const commit = (digit: string) => digit.repeat(40);

describe("keys of kept answers", () => {
  test("only a full commit id is fixed", () => {
    expect(isCommitId(commit("a"))).toBe(true);
    expect(isCommitId("main")).toBe(false);
    expect(isCommitId(commit("a").slice(0, 12))).toBe(false);
    expect(isCommitId(commit("A"))).toBe(false);
    expect(isCommitId(undefined)).toBe(false);
  });

  test("a log page is kept by repo, commit, limit and offset", () => {
    expect(logKey("t-site", commit("a"), 50, 0)).toBe(`log/t-site/${commit("a")}/50/0`);
    expect(logKey("t-site", "main", 50, 0)).toBeUndefined();
    expect(logKey("t-site", undefined, 50, 0)).toBeUndefined();
  });

  test("a diff is kept by both its commits, never while its head moves", () => {
    expect(diffKey("t-site-a3", commit("a"), commit("b"))).toBe(`diff/t-site-a3/${commit("a")}/${commit("b")}`);
    expect(diffKey("t-site-a3", commit("a"), undefined)).toBeUndefined();
    expect(diffKey("t-site", undefined, commit("b"))).toBeUndefined();
  });

  test("a listing or a file is kept by repo, commit and path", () => {
    expect(readKey("tree", "t-site", commit("c"), [])).toBe(`tree/t-site/${commit("c")}/`);
    expect(readKey("file", "t-site", commit("c"), ["infra", "README.md"])).toBe(`file/t-site/${commit("c")}/infra/README.md`);
    expect(readKey("tree", "t-site", commit("c"), ["src"])).not.toBe(readKey("file", "t-site", commit("c"), ["src"]));
    expect(readKey("file", "t-site", "HEAD", ["README.md"])).toBeUndefined();
  });

  test("a key KV would refuse is no key", () => {
    const deep = Array.from({ length: KEY_MAX_BYTES }, () => "d");

    expect(readKey("file", "t-site", commit("c"), deep)).toBeUndefined();
    // 240 characters fit; their 480 bytes do not.
    expect(readKey("file", "t-site", commit("c"), ["é".repeat(240)])).toBeUndefined();
  });

  test("a huge answer is not kept", () => {
    expect(keepable(KEPT_MAX_BYTES)).toBe(true);
    expect(keepable(KEPT_MAX_BYTES + 1)).toBe(false);
  });
});
