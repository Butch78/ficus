import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { Tree } from "./answers.ts";
import { buds, crumbs, join, status, trunk } from "./view.ts";

const a = "a".repeat(40);

const b = "b".repeat(40);

// The shape `GET /trees/<t>` answers after one harvest, as serde writes it.
const harvested = Schema.decodeUnknownSync(Tree)({
  name: "abcdefghij-site",
  head: 1,
  next_id: 5,
  nodes: {
    "0": { id: 0, parent: null, commit: a, repo: "abcdefghij-site", fruit_of: null },
    "1": { id: 1, parent: 0, commit: b, repo: "abcdefghij-site-l2", fruit_of: 2 },
  },
  buds: {
    "1": { id: 1, intent: "fix slugify", state: { Fruited: { leaf: 2, node: 1 } } },
    "4": { id: 4, intent: "add a test", state: "Open" },
  },
  leaves: {
    "2": { id: 2, bud: 1, agent: "beta", base: 0, repo: "abcdefghij-site-l2", state: { Fruit: { node: 1 } } },
    "3": {
      id: 3,
      bud: 1,
      agent: "cheater",
      base: 0,
      repo: "abcdefghij-site-l3",
      state: { Pruned: { reason: { Outgrown: { by: 2 } } } },
    },
    "5": { id: 5, bud: 4, agent: "gamma", base: 0, repo: "abcdefghij-site-l5", state: "Growing" },
  },
  compost: [
    {
      leaf: 3,
      bud: 1,
      agent: "cheater",
      reason: { Outgrown: { by: 2 } },
      score: { checks_passed: 0, checks_total: 1, cost: 4 },
    },
  ],
});

describe("the tree as a page reads it", () => {
  test("decodes serde's externally tagged enums", () => {
    expect(harvested.leaves["5"]?.state).toBe("Growing");
    expect(harvested.buds["1"]?.state).toEqual({ Fruited: { leaf: 2, node: 1 } });
  });

  test("the trunk runs from the root to the head", () => {
    expect(trunk(harvested).map((node) => node.id)).toEqual([0, 1]);
  });

  test("buds come newest first, each with its own leaves and fruit", () => {
    expect(buds(harvested).map((view) => [view.bud.id, view.leaves.map((leaf) => leaf.id), view.fruit])).toEqual([
      [4, [5], undefined],
      [1, [2, 3], 1],
    ]);
  });
});

describe("status", () => {
  test("says what each leaf state means", () => {
    expect(status("Growing")).toEqual({ tone: "growing", label: "growing", commit: undefined });
    expect(status({ Ripening: { commit: a } }).commit).toBe(a);
    expect(status({ Ripe: { commit: b, score: { checks_passed: 2, checks_total: 2, cost: 7 } } }).label).toBe(
      "ripe: passes 2/2 checks, cost 7",
    );
    expect(status({ Ripe: { commit: b, score: { checks_passed: 1, checks_total: 2, cost: 7 } } }).label).toBe(
      "ripe: fails 1/2 checks, cost 7",
    );
    expect(status({ Fruit: { node: 3 } }).tone).toBe("fruit");
    expect(status({ Pruned: { reason: { Regrown: { into: 9 } } } }).label).toBe("pruned: regrown as leaf 9");
    expect(status({ Pruned: { reason: { Withered: { note: "gave up" } } } }).label).toBe("pruned: withered: gave up");
  });
});

describe("paths", () => {
  test("a breadcrumb names each directory and where it leads", () => {
    expect(crumbs("")).toEqual([]);
    expect(crumbs("src/web/lib")).toEqual([
      ["src", "src"],
      ["web", "src/web"],
      ["lib", "src/web/lib"],
    ]);
  });

  test("join does not lead with a slash at the root", () => {
    expect(join("", "README.md")).toBe("README.md");
    expect(join("src", "lib.rs")).toBe("src/lib.rs");
  });
});
