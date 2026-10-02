import { describe, expect, test } from "bun:test";
import * as Schema from "effect/Schema";
import { label, narrate, steps, TraceEvent, where } from "./activity.ts";
import fixture from "./plant-trace.fixture.json";

// A real plant on pr-1, as Workers Observability returned it (names changed):
// the UI's server action, the Api, the tree Worker and its Durable Object,
// with the redirect's page render after it in the same trace.
const plant = Schema.decodeUnknownSync(Schema.Array(TraceEvent))(fixture);

const outline = (events: ReadonlyArray<TraceEvent>) =>
  steps(events).map((step) => `${"  ".repeat(step.depth)}${step.where}: ${step.label}${step.count > 1 ? ` ×${step.count}` : ""}`);

describe("steps of a real plant", () => {
  test("are the operation's own spans, nested, framed spans dropped and repeats folded", () => {
    expect(outline(plant)).toEqual([
      "UI: Your plant",
      "  UI: fetch /v1/orgs/acme/trees/site/plant",
      "    Api: POST https://ficus-web-pr-1.example.workers.dev/v1/orgs/acme/trees/site/plant",
      "      Api: D1: session and membership lookup ×9",
      "      Api: fetch /trees/site/plant",
      "        Tree: POST http://tree/trees/site/plant",
      "          Tree: Hand to the tree's Durable Object",
      "            Tree: fetch /trees/site/plant",
      "              Tree: POST http://tree/trees/site/plant",
      "                Tree: Artifacts: import",
      "                Tree: Durable Object storage: get",
      "                Tree: Artifacts: get",
      "                  Tree: Artifacts: log",
      "                Tree: Artifacts: get",
      "                  Tree: Artifacts: listTokens",
      "                  Tree: Artifacts: revokeToken",
      "                Tree: Durable Object storage: put",
      "                Tree: Durable Object storage: get",
      "      Api: D1: record the tree in the directory",
    ]);
  });

  test("time from the operation's start; a fold sums its repeats", () => {
    const all = steps(plant);
    const lookups = all.find((step) => step.label === "D1: session and membership lookup");
    const importing = all.find((step) => step.label === "Artifacts: import");

    expect(all[0]?.offset).toBe(0);
    expect(lookups?.duration).toBe(71);
    expect(importing?.duration).toBe(4036);
  });

  test("an empty trace has no steps", () => {
    expect(steps([])).toEqual([]);
  });
});

describe("a span whose parent never arrived", () => {
  test("goes under the innermost span around it, its own Worker's first", () => {
    const span = (spanId: string, service: string, transactionName: string, startTime: number, endTime: number) => ({
      $metadata: { traceId: "t", spanId, type: "span", service, transactionName, startTime, endTime },
    });

    const events: ReadonlyArray<TraceEvent> = [
      span("op", "ficus-web-x", "ficus.plant", 0, 100),
      { $metadata: { ...span("do", "ficus-x", "durable_object_subrequest", 10, 90).$metadata, parentSpanId: "op" } },
      span("orphan", "ficus-x", "RPC call: import", 20, 80),
    ];

    expect(outline(events)).toEqual(["UI: Your plant", "  Tree: Hand to the tree's Durable Object", "    Tree: Artifacts: import"]);
  });

  test("is not adopted by its own child, nor by a binding call", () => {
    // Seen live: the Durable Object's request span never arrived, so its RPC
    // session is an orphan with exactly its one call's extent, and a storage
    // read falls inside that call's time.
    const span = (spanId: string, parentSpanId: string | undefined, transactionName: string, startTime: number, endTime: number) => {
      const metadata: TraceEvent["$metadata"] = { traceId: "t", spanId, type: "span", service: "ficus-x", transactionName, startTime, endTime };

      return { $metadata: parentSpanId === undefined ? metadata : { ...metadata, parentSpanId } };
    };

    const events: ReadonlyArray<TraceEvent> = [
      { $metadata: { traceId: "t", spanId: "op", type: "span", service: "ficus-web-x", transactionName: "ficus.plant", startTime: 0, endTime: 100 } },
      span("fetch", "op", "fetch /trees/site/plant", 5, 95),
      span("session", "lost", "RPC session", 10, 80),
      span("import", "session", "RPC call: import", 10, 80),
      span("read", "lost", "durable_object_storage_get", 10, 10),
    ];

    expect(outline(events)).toEqual([
      "UI: Your plant",
      "  Tree: fetch /trees/site/plant",
      "    Tree: Artifacts: import",
      "    Tree: Durable Object storage: get",
    ]);
  });
});

describe("names", () => {
  test("say which part of Ficus ran", () => {
    expect(["ficus-web-pr-1", "ficus-api-prod", "ficus-sandbox-pr-1", "ficus-pr-1"].map(where)).toEqual([
      "UI",
      "Api",
      "Sandbox",
      "Tree",
    ]);
  });

  test("an RPC call outside the tree Worker keeps the platform's name", () => {
    expect(label("ficus-api-pr-1", "RPC call: get")).toBe("RPC call: get");
    expect(label("ficus-pr-1", "durable_object_storage_put")).toBe("Durable Object storage: put");
  });
});

describe("narrate", () => {
  test("tells a plant as the few things that happened to the person's tree", () => {
    expect(narrate(steps(plant)).map((told) => told.text)).toEqual([
      "Handed the request to the tree's Durable Object",
      "Imported the repository into Artifacts",
      "Read the repository's head commit",
      "Locked the root: revoked its write tokens",
      "Saved the tree",
      "Listed the tree in your organization",
    ]);
  });

  test("merged sentences cover their steps' extent, not the sum of them", () => {
    const told = narrate(steps(plant)).find((sentence) => sentence.text === "Read the repository's head commit");

    // get (63 ms), then log (41) inside it, then get (33): 4531..4668.
    expect(told?.duration).toBe(137);
  });
});
