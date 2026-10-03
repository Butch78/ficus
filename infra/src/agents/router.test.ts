import { describe, expect, test } from "bun:test";
import type { Api, Model, Provider } from "@earendil-works/pi-ai";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import { CLOUDFLARE_WORKERS_AI_MODELS } from "@earendil-works/pi-ai/providers/cloudflare-workers-ai.models";
import { DEFAULT_POOL, routingHeaders, settingsOf, withModels } from "./router.ts";

describe("settingsOf", () => {
  test("reads the gateway, and the default pool when the env names none", () => {
    expect(Effect.runSync(settingsOf({ AI_GATEWAY: "ficus-dev" }))).toEqual({ gateway: "ficus-dev", pool: [...DEFAULT_POOL] });
  });

  test("reads a pool from the env, trimmed, empties dropped", () => {
    const settings = Effect.runSync(settingsOf({ AI_GATEWAY: "g", AUTO_ROUTER_POOL: " @cf/a/b , ,@cf/c/d" }));

    expect(settings.pool).toEqual(["@cf/a/b", "@cf/c/d"]);
  });

  test("fails without a gateway", () => {
    expect(Result.isFailure(Effect.runSync(Effect.result(settingsOf({}))))).toBe(true);
  });
});

describe("routingHeaders", () => {
  test("pins the session and lists the pool, comma-separated", () => {
    expect(routingHeaders("abcd-site-a4", ["@cf/a/b", "@cf/c/d"])).toEqual({
      "cf-aig-session-id": "abcd-site-a4",
      "cf-aig-allowed-models": "@cf/a/b,@cf/c/d",
    });
  });
});

describe("withModels", () => {
  const [entry] = Object.values(CLOUDFLARE_WORKERS_AI_MODELS);

  if (entry === undefined) {
    throw new Error("pi-ai's Workers AI catalog is empty");
  }

  const model = (id: string): Model<Api> => ({ ...entry, id });

  const fail = (): never => {
    throw new Error("not streamed in this test");
  };

  test("adds the models to the provider's list and keeps the rest of it", () => {
    const base: Provider = {
      id: "cloudflare",
      name: "Cloudflare",
      auth: {},
      getModels: () => [model("@cf/x/y")],
      getAllModels: () => [model("@cf/x/y")],
      stream: fail,
      streamSimple: fail,
    };

    const wrapped = withModels(base, [model("cloudflare/auto")]);

    expect(wrapped.id).toBe("cloudflare");
    expect(wrapped.getModels().map((each) => each.id)).toEqual(["@cf/x/y", "cloudflare/auto"]);
    expect((wrapped.getAllModels?.() ?? []).map((each) => each.id)).toEqual(["@cf/x/y", "cloudflare/auto"]);
    expect("refreshModels" in wrapped).toBe(false);
  });
});
