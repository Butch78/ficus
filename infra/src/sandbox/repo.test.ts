import { describe, expect, test } from "bun:test";
import { isRepoRequest, repoOf } from "./repo.ts";

const remote = "https://fbf58b6d.artifacts.cloudflare.net/git/ficus-dev/abc-site-l4.git";

describe("repoOf", () => {
  test("splits a remote into the host Egress routes and the path it allows", () => {
    expect(repoOf(remote)).toEqual({
      host: "fbf58b6d.artifacts.cloudflare.net",
      repoPath: "/git/ficus-dev/abc-site-l4.git",
    });
    expect(repoOf(`${remote}/`).repoPath).toBe("/git/ficus-dev/abc-site-l4.git");
  });
});

describe("isRepoRequest", () => {
  const { repoPath } = repoOf(remote);

  test("allows git's requests for this repo", () => {
    expect(isRepoRequest(`${repoPath}/info/refs`, repoPath)).toBe(true);
    expect(isRepoRequest(`${repoPath}/git-upload-pack`, repoPath)).toBe(true);
  });

  test("refuses other repos, including ones whose name starts the same", () => {
    expect(isRepoRequest("/git/ficus-dev/abc-site-l5.git/info/refs", repoPath)).toBe(false);
    expect(isRepoRequest("/git/ficus-dev/abc-site-l4.gitx/info/refs", repoPath)).toBe(false);
    expect(isRepoRequest("/git/ficus-dev/abc-site.git/info/refs", repoPath)).toBe(false);
  });
});
