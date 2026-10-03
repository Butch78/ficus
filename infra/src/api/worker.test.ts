import { describe, expect, test } from "bun:test";
import { treeRoute, treesRoute } from "./worker.ts";

describe("treeRoute", () => {
  test("splits organization, tree and the rest of the path", () => {
    expect(treeRoute("/v1/orgs/acme/trees/site")).toEqual({ org: "acme", tree: "site", rest: "" });
    expect(treeRoute("/v1/orgs/acme/trees/site/tasks/1/attempts")).toEqual({
      org: "acme",
      tree: "site",
      rest: "/tasks/1/attempts",
    });
  });

  test("refuses anything that is not a tree path", () => {
    for (const path of ["/v1/orgs/acme/trees", "/v1/orgs/acme", "/trees/site", "/v1/orgs//trees/site"]) {
      expect(treeRoute(path)).toBeUndefined();
    }
  });
});

describe("treesRoute", () => {
  test("names the organization whose trees are listed", () => {
    expect(treesRoute("/v1/orgs/acme/trees")).toBe("acme");
    expect(treesRoute("/v1/orgs/acme/trees/")).toBe("acme");
  });

  test("is not a tree's own path", () => {
    for (const path of ["/v1/orgs/acme/trees/site", "/v1/orgs/acme", "/v1/orgs//trees"]) {
      expect(treesRoute(path)).toBeUndefined();
    }
  });
});
