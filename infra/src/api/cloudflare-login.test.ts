import { describe, expect, test } from "bun:test";
import { cloudflareUser, type Fetcher } from "./cloudflare-login.ts";

/** A fetch that answers each Cloudflare URL with the JSON text given, or 403. */
const answering =
  (answers: ReadonlyMap<string, string>): Fetcher =>
  async (url) => {
    const body = answers.get(url);

    return body === undefined ? new Response("", { status: 403 }) : new Response(body);
  };

const API_USER = "https://api.cloudflare.com/client/v4/user";

describe("cloudflareUser", () => {
  test("is Cloudflare's user, named from the profile", async () => {
    const user = await cloudflareUser("t", answering(new Map([[API_USER, JSON.stringify({ result: { id: "a-9", email: "ada@example.com", first_name: "Ada", last_name: null } })]])));

    expect(user).toEqual({ id: "a-9", email: "ada@example.com", name: "Ada", emailVerified: true });
  });

  test("is named by the email's local part when the profile has no name", async () => {
    const user = await cloudflareUser("t", answering(new Map([[API_USER, JSON.stringify({ result: { id: "a-9", email: "ada@example.com" } })]])));

    expect(user).toEqual({ id: "a-9", email: "ada@example.com", name: "ada", emailVerified: true });
  });

  test("is nobody without a token, or when the user API does not answer", async () => {
    expect(await cloudflareUser(undefined, answering(new Map()))).toBeNull();
    expect(await cloudflareUser("t", answering(new Map()))).toBeNull();
  });
});
