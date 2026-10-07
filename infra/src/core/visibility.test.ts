import { describe, expect, test } from "bun:test";
import * as Result from "effect/Result";
import legacyTree from "./fixtures/tree-botany.json";
import * as T from "./tree.ts";
import { anonymousMay, isPublic } from "./visibility.ts";

const stored = Result.getOrThrow(T.decodeTree(legacyTree));

describe("what an anonymous caller may read", () => {
  test("GET the tree, or an attempt's or node's log, tree, file or diff", () => {
    for (const rest of ["", "/attempts/3/log", "/attempts/3/tree", "/nodes/0/file", "/nodes/2/diff"]) {
      expect(anonymousMay("GET", rest)).toBe(true);
    }
  });

  test("nothing else, and no other method", () => {
    const others = ["/", "/tasks/1", "/attempts/3", "/attempts/3/agent", "/attempts//log", "/attempts/3/log/", "/attempts/3/log/x", "/behind", "/release", "/deploys", "/export", "/visibility", "/x/3/log"];

    for (const rest of others) {
      expect(anonymousMay("GET", rest)).toBe(false);
    }

    for (const method of ["POST", "PUT", "DELETE", "HEAD", "get"]) {
      expect(anonymousMay(method, "")).toBe(false);
      expect(anonymousMay(method, "/attempts/3/log")).toBe(false);
    }
  });

  test("only from a public tree: unknown, private and stored before the flag are alike", () => {
    expect(isPublic({ ...stored, public: true })).toBe(true);
    expect(isPublic({ ...stored, public: false })).toBe(false);
    expect(stored.public).toBeUndefined();
    expect(isPublic(stored)).toBe(false);
    expect(isPublic(undefined)).toBe(false);
  });

  test("the flag survives storage", () => {
    const shown = { ...stored, public: true };

    expect(Result.getOrThrow(T.decodeTree(JSON.parse(JSON.stringify(shown))))).toEqual(shown);
  });
});
