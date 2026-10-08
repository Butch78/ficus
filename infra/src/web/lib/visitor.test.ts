import { describe, expect, test } from "bun:test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { anonymousMay } from "../../core/visibility.ts";
import * as Api from "./api.ts";
import { Tree } from "./answers.ts";
import { landing } from "./visitor.ts";

// Every call a page makes, as the path after `/v1/orgs/<org>/trees/<tree>` the Api would see.
const requests = async (...calls: ReadonlyArray<Effect.Effect<unknown, Api.ApiError, Api.Upstream>>) => {
  const seen: Array<readonly [string, string]> = [];

  const api: Fetcher = {
    connect: () => {
      throw new Error("no sockets");
    },
    fetch: (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      seen.push([request.method, url.pathname.replace("/v1/orgs/acme/trees/site", "") + url.search]);

      return Promise.resolve(new Response("{}", { status: 500 }));
    },
  };

  for (const call of calls) {
    await Effect.runPromise(
      call.pipe(Effect.result, Effect.provideService(Api.Upstream, { api, origin: "https://ui.example.com", cookie: undefined })),
    );
  }

  return seen;
};

const restOf = ([, path]: readonly [string, string]) => path.split("?")[0] ?? "";

describe("what a signed-out visitor may ask of a public tree", () => {
  test("the tree, and a node's log, listing, file and change: all reads the Api lets anyone make", async () => {
    const node = { kind: "nodes", id: 3 } as const;

    const seen = await requests(
      Api.showTree("acme", "site"),
      Api.log("acme", "site", node, 10),
      Api.listDirectory("acme", "site", node, "src"),
      Api.readFile("acme", "site", node, "a".repeat(40), "src/a.ts"),
      Api.diff("acme", "site", node),
    );

    expect(seen.map(restOf)).toEqual(["", "/nodes/3/log", "/nodes/3/tree", "/nodes/3/file", "/nodes/3/diff"]);
    expect(seen.map(([method, path]) => anonymousMay(method, restOf([method, path])))).toEqual([true, true, true, true, true]);
  });

  test("the task, the attempt, the agent and every change stay with members", async () => {
    const seen = await requests(
      Api.showTask("acme", "site", 1),
      Api.showAttempt("acme", "site", 2),
      Api.agentStatus("acme", "site", 2),
      Api.createTask("acme", "site", "x", "op"),
      Api.setVisibility("acme", "site", true, "op"),
    );

    expect(seen.map(([method, path]) => anonymousMay(method, restOf([method, path])))).toEqual([false, false, false, false, false]);
    expect(seen.at(-1)).toEqual(["POST", "/visibility"]);
  });
});

describe("a tree's visibility", () => {
  const stored = {
    name: "abcdefghij-site",
    head: 0,
    nodes: { "0": { id: 0, parent: null, commit: "a".repeat(40), repo: "abcdefghij-site", accepted_from: null } },
    tasks: {},
    attempts: {},
    history: [],
  };

  test("is read from the tree; a tree stored before the flag has none", () => {
    expect(Schema.decodeUnknownSync(Tree)({ ...stored, public: true }).public).toBe(true);
    expect(Schema.decodeUnknownSync(Tree)(stored).public).toBeUndefined();
  });
});

describe("where a refusal sends a visitor", () => {
  test("a signed-out visitor signs in, whether the Api says 401 or hides a private tree with 404", () => {
    expect(landing(401, false)).toBe("sign-in");
    expect(landing(404, false)).toBe("sign-in");
  });

  test("a signed-in visitor is not found; other failures are errors", () => {
    expect(landing(401, true)).toBe("sign-in");
    expect(landing(404, true)).toBe("not-found");
    expect(landing(500, false)).toBe("error");
    expect(landing(403, true)).toBe("error");
  });
});
