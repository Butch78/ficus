import { describe, expect, test } from "bun:test";
import { anyMatches, globMatches, normalizePattern } from "./paths.ts";

describe("globMatches", () => {
  test("a plain path matches itself and everything under it, nothing beside it", () => {
    expect(globMatches("infra", "infra")).toBe(true);
    expect(globMatches("infra", "infra/src/core/tree.ts")).toBe(true);
    expect(globMatches("infra/", "infra/package.json")).toBe(true);
    expect(globMatches("./infra", "infra/package.json")).toBe(true);
    expect(globMatches("/infra", "infra/package.json")).toBe(true);
    expect(globMatches("infra", "infrastructure/x.ts")).toBe(false);
    expect(globMatches("infra", "docs/infra")).toBe(false);
    expect(globMatches("README.md", "README.md")).toBe(true);
    expect(globMatches("README.md", "docs/README.md")).toBe(false);
  });

  test("* stays within a segment, but a matched directory takes what is under it", () => {
    expect(globMatches("*.md", "README.md")).toBe(true);
    expect(globMatches("*.md", "docs/guide.md")).toBe(false);
    expect(globMatches("docs/*.md", "docs/guide.md")).toBe(true);
    expect(globMatches("docs/*.md", "docs/deep/guide.md")).toBe(false);
    expect(globMatches("infra/*", "infra/src/core/tree.ts")).toBe(true);
    expect(globMatches("infra/*.json", "infra/src/x.json")).toBe(false);
    expect(globMatches("a.md", "aXmd")).toBe(false);
  });

  test("? is one character of a segment", () => {
    expect(globMatches("v?.txt", "v1.txt")).toBe(true);
    expect(globMatches("v?.txt", "v10.txt")).toBe(false);
    expect(globMatches("a?b", "a/b")).toBe(false);
  });

  test("** is any number of whole segments, none included", () => {
    expect(globMatches(".github/**", ".github/workflows/ci.yml")).toBe(true);
    expect(globMatches(".github/**", ".githubx/a")).toBe(false);
    expect(globMatches("**/*.md", "README.md")).toBe(true);
    expect(globMatches("**/*.md", "docs/a/b.md")).toBe(true);
    expect(globMatches("**/*.md", "docs/a/b.mdx")).toBe(false);
    expect(globMatches("infra/**/test.ts", "infra/test.ts")).toBe(true);
    expect(globMatches("infra/**/test.ts", "infra/src/core/test.ts")).toBe(true);
    expect(globMatches("**", "anything/at/all")).toBe(true);
    expect(globMatches("infra/**.ts", "infra/src/a.ts")).toBe(true);
  });

  test("an empty pattern matches nothing", () => {
    expect(normalizePattern(" ./ ")).toBe("");
    expect(globMatches("", "a")).toBe(false);
    expect(globMatches("/", "a")).toBe(false);
  });
});

describe("anyMatches", () => {
  test("true when one path matches one pattern", () => {
    expect(anyMatches([".github/**"], ["docs/a.md", ".github/workflows/ci.yml"])).toBe(true);
    expect(anyMatches(["infra", "package.json"], ["docs/a.md"])).toBe(false);
    expect(anyMatches(["infra"], [])).toBe(false);
  });
});
