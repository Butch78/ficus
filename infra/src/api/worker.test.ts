import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as Effect from "effect/Effect";
import { ANONYMOUS_HEADER, NO_SUCH_TREE } from "../core/visibility.ts";
import { API_KEY_HEADER } from "./auth.ts";
import { TENANT_HEADER, tenantKey } from "./tenant.ts";
import worker, { treeRoute, treesRoute } from "./worker.ts";

describe("treeRoute", () => {
  test("splits organization, tree and the rest of the path", () => {
    expect(treeRoute("/v1/orgs/acme/trees/site")).toEqual({ org: "acme", tree: "site", rest: "" });
    expect(treeRoute("/v1/orgs/acme/trees/site/tasks/1/attempts")).toEqual({
      org: "acme",
      tree: "site",
      rest: "/tasks/1/attempts",
    });
    expect(treeRoute("/v1/orgs/acme/trees/site/tasks/1/close")?.rest).toBe("/tasks/1/close");
  });

  test("refuses anything that is not a tree path", () => {
    for (const path of ["/v1/orgs/acme/trees", "/v1/orgs/acme", "/trees/site", "/v1/orgs//trees/site"]) {
      expect(treeRoute(path)).toBeUndefined();
    }
  });
});

describe("sign-in providers", () => {
  /** The GitHub part of the Api's bindings. */
  interface GitHubBindings {
    readonly GITHUB_CLIENT_ID?: string;
    readonly GITHUB_CLIENT_SECRET?: { readonly get: () => Promise<string> };
  }

  const ask = async (github: GitHubBindings) => {
    // SAFETY: the providers route reads only the GitHub bindings; the others are never touched.
    const env = { AUTH_DB: {}, TREE: {}, BETTER_AUTH_SECRET: "test", BACKUPS: {}, ...github } as never;

    return (await worker.fetch(new Request("https://api.example/v1/auth/providers"), env)).text();
  };

  test("offer GitHub only once the stage has both its OAuth app's client id and secret", async () => {
    expect(await ask({})).toBe(JSON.stringify({ github: false }));
    expect(await ask({ GITHUB_CLIENT_ID: "id" })).toBe(JSON.stringify({ github: false }));
    expect(await ask({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: { get: async () => "secret" } })).toBe(JSON.stringify({ github: true }));
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

describe("GET /v1/health", () => {
  test("answers 200 {ok:true} without authentication or the tree Worker", async () => {
    const TREE = {
      fetch: () => {
        throw new Error("must not reach the tree Worker");
      },
    };

    const response = await worker.fetch(
      new Request("https://api.example.com/v1/health", { method: "GET" }),
      // SAFETY: the health route touches no binding, so the stubs are never used.
      { AUTH_DB: {}, TREE, BETTER_AUTH_SECRET: "test", BACKUPS: {} } as never,
    );

    expect(response.status).toBe(200);
    // SAFETY: the health route answers exactly this JSON, whatever the Response type says.
    expect((await response.json()) as unknown).toEqual({ ok: true });
  });
});

describe("a request with no session and no API key", () => {
  const origin = "https://anonymous.example.com";
  const AUTH_DB = new Database(":memory:");

  AUTH_DB.exec(readFileSync(new URL("./migrations/20261003053232_baseline/migration.sql", import.meta.url).pathname, "utf8"));

  const forwarded: Array<Request> = [];

  const TREE = {
    fetch: (request: Request) => {
      forwarded.push(request);

      return Promise.resolve(new Response("from the tree"));
    },
  };

  // SAFETY: Better Auth takes bun:sqlite as it takes D1; nothing here reaches the backups bucket.
  const env = { AUTH_DB, TREE, BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret", BACKUPS: {} } as never;

  const call = async (path: string, init: RequestInit = {}) => {
    forwarded.length = 0;

    return worker.fetch(new Request(`${origin}${path}`, init), env);
  };

  const spoofed = { [ANONYMOUS_HEADER]: "false", [TENANT_HEADER]: "aaaaaaaaaa" };

  test("reads a tree, or an attempt's or node's repo, marked anonymous, in the organization the slug names", async () => {
    AUTH_DB.run(`insert into organization (id, name, slug, createdAt) values ('org_acme', 'Acme', 'acme', '2026-10-07')`);

    const tenant = await Effect.runPromise(tenantKey("org_acme"));

    for (const [path, to] of [
      ["/v1/orgs/acme/trees/site", "/trees/site"],
      ["/v1/orgs/acme/trees/site/attempts/3/file?path=README.md", "/trees/site/attempts/3/file?path=README.md"],
      ["/v1/orgs/acme/trees/site/nodes/0/diff", "/trees/site/nodes/0/diff"],
    ] as const) {
      const response = await call(path, { headers: spoofed });

      expect(await response.text()).toBe("from the tree");
      expect(forwarded.map((request) => new URL(request.url).pathname + new URL(request.url).search)).toEqual([to]);
      expect(forwarded[0]?.headers.get(ANONYMOUS_HEADER)).toBe("true");
      expect(forwarded[0]?.headers.get(TENANT_HEADER)).toBe(tenant);
    }
  });

  test("gets the tree Worker's 404 for an unknown organization, which is never asked", async () => {
    const response = await call("/v1/orgs/nobody/trees/site/nodes/0/log");

    expect(response.status).toBe(404);
    expect(await response.text()).toBe(NO_SUCH_TREE);
    expect(forwarded).toEqual([]);
  });

  test("is refused every other route and method; one with an API key is a member's", async () => {
    const refused: ReadonlyArray<readonly [string, RequestInit]> = [
      ["/v1/orgs/acme/trees/site/visibility", { method: "POST", body: JSON.stringify({ public: true }) }],
      ["/v1/orgs/acme/trees/site/tasks", { method: "POST", body: JSON.stringify({ intent: "x" }) }],
      ["/v1/orgs/acme/trees/site/tasks/1", {}],
      ["/v1/orgs/acme/trees/site/attempts/3", {}],
      ["/v1/orgs/acme/trees/site/attempts/3/agent", {}],
      ["/v1/orgs/acme/trees/site/export", {}],
      ["/v1/orgs/acme/trees/site/", {}],
      ["/v1/orgs/acme/trees", {}],
      ["/v1/orgs/acme/trees/site", { method: "DELETE" }],
    ];

    for (const [path, init] of refused) {
      const response = await call(path, init);

      expect(response.status).toBe(401);
      expect(forwarded).toEqual([]);
    }

    // A key is checked as a key (Better Auth refuses this one), never read as no one.
    expect((await call("/v1/orgs/acme/trees/site", { headers: { [API_KEY_HEADER]: "not-a-key" } })).status).toBe(403);
    expect(forwarded).toEqual([]);
  });

  test("is not a member's: a member's goes on unmarked, whatever header it carries", async () => {
    const json = { origin, "content-type": "application/json" };

    const signUp = await call("/api/auth/sign-up/email", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ email: "member@example.com", password: "a-long-enough-password", name: "Member" }),
    });

    const cookie = signUp.headers.getSetCookie().map((set) => set.split(";")[0]).join("; ");

    const created = await call("/api/auth/organization/create", {
      method: "POST",
      headers: { ...json, cookie },
      body: JSON.stringify({ name: "Members", slug: "members" }),
    });

    expect(created.status).toBe(200);

    const response = await call("/v1/orgs/members/trees/site", { headers: { cookie, ...spoofed } });

    expect(await response.text()).toBe("from the tree");
    expect(forwarded[0]?.headers.has(ANONYMOUS_HEADER)).toBe(false);
    expect(forwarded[0]?.headers.has("cookie")).toBe(false);
  });

  test("is a signed-in non-member's: 404, the same as an organization that does not exist, and the tree is never asked", async () => {
    const json = { origin, "content-type": "application/json" };

    const signUp = (email: string) =>
      call("/api/auth/sign-up/email", { method: "POST", headers: json, body: JSON.stringify({ email, password: "a-long-enough-password", name: email }) });

    const cookieOf = (response: Response) => response.headers.getSetCookie().map((set) => set.split(";")[0]).join("; ");
    const owner = cookieOf(await signUp("owner@example.com"));
    const outsider = cookieOf(await signUp("outsider@example.com"));

    const created = await call("/api/auth/organization/create", { method: "POST", headers: { ...json, cookie: owner }, body: JSON.stringify({ name: "Closed", slug: "closed" }) });

    expect(created.status).toBe(200);

    for (const slug of ["closed", "nowhere"]) {
      const response = await call(`/v1/orgs/${slug}/trees/site`, { headers: { cookie: outsider } });

      expect(response.status).toBe(404);
      expect(await response.text()).toBe(JSON.stringify({ error: `no organization ${slug} that you belong to` }));
    }

    expect(forwarded).toEqual([]);
    expect((await call("/v1/orgs/closed/trees/site", { headers: { cookie: owner } })).status).toBe(200);
  });
});
