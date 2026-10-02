import { describe, expect, test } from "bun:test";
import { treeRoute } from "./worker.ts";

describe("treeRoute", () => {
  test("splits organization, tree and the rest of the path", () => {
    expect(treeRoute("/v1/orgs/acme/trees/site")).toEqual({ org: "acme", tree: "site", rest: "" });
    expect(treeRoute("/v1/orgs/acme/trees/site/buds/1/leaves")).toEqual({
      org: "acme",
      tree: "site",
      rest: "/buds/1/leaves",
    });
  });

  test("refuses anything that is not a tree path", () => {
    for (const path of ["/v1/orgs/acme/trees", "/v1/orgs/acme", "/trees/site", "/v1/orgs//trees/site"]) {
      expect(treeRoute(path)).toBeUndefined();
    }
  });
});
