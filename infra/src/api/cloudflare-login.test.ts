import { describe, expect, test } from "bun:test";
import { cloudflareUser, type Fetcher } from "./cloudflare-login.ts";

/** A fetch that answers each Cloudflare URL with the JSON text given, or 403. */
const answering =
  (answers: ReadonlyMap<string, string>): Fetcher =>
  async (url) => {
    const body = answers.get(url);

    return body === undefined ? new Response("", { status: 403 }) : new Response(body);
  };

const USERINFO = "https://dash.cloudflare.com/oauth2/userinfo";

const API_USER = "https://api.cloudflare.com/client/v4/user";

describe("cloudflareUser", () => {
  test("is OpenID's userinfo when it carries an email", async () => {
    const user = await cloudflareUser("t", answering(new Map([[USERINFO, JSON.stringify({ sub: "u-1", email: "ada@example.com", name: "Ada" })]])));

    expect(user).toEqual({ id: "u-1", email: "ada@example.com", name: "Ada", emailVerified: true });
  });

  test("asks Cloudflare's user API when userinfo has no email, keeping userinfo's subject", async () => {
    const user = await cloudflareUser("t", answering(new Map([[USERINFO, JSON.stringify({ sub: "u-1" })], [API_USER, JSON.stringify({ result: { id: "a-9", email: "ada@example.com", first_name: "Ada", last_name: null } })]])));

    expect(user).toEqual({ id: "u-1", email: "ada@example.com", name: "Ada", emailVerified: true });
  });

  test("is nobody without a token, or when neither answers", async () => {
    expect(await cloudflareUser(undefined, answering(new Map()))).toBeNull();
    expect(await cloudflareUser("t", answering(new Map()))).toBeNull();
  });
});
