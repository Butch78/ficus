import { describe, expect, test } from "bun:test";
import * as Option from "effect/Option";
import { appJwt, importSource, installUrl, pushed, signedByGitHub } from "./github.ts";

const hmac = async (secret: string, body: string) => {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));

  return `sha256=${Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

const fromBase64Url = (text: string) => Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (character) => character.codePointAt(0) ?? 0);

describe("signedByGitHub", () => {
  test("accepts the secret's HMAC of the body, and nothing else", async () => {
    const body = JSON.stringify({ ref: "refs/heads/main" });
    const signature = await hmac("s3cret", body);

    expect(await signedByGitHub("s3cret", body, signature)).toBe(true);
    expect(await signedByGitHub("other", body, signature)).toBe(false);
    expect(await signedByGitHub("s3cret", `${body} `, signature)).toBe(false);
    expect(await signedByGitHub("s3cret", body, null)).toBe(false);
    expect(await signedByGitHub("s3cret", body, "sha1=abc")).toBe(false);
  });
});

describe("appJwt", () => {
  test("is RS256 over the app's key, issued by the app, for under ten minutes", async () => {
    const generated = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);

    if (!("privateKey" in generated)) {
      throw new Error("RSA generates a key pair");
    }

    const pair = generated;
    const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);

    if (!(exported instanceof ArrayBuffer)) {
      throw new Error("PKCS#8 exports bytes");
    }

    const pkcs8 = new Uint8Array(exported);
    const privateKey = btoa(Array.from(pkcs8, (byte) => String.fromCodePoint(byte)).join(""));

    const jwt = await appJwt({ appId: "42", privateKey }, 1_000_000);
    const [header = "", claims = "", signature = ""] = jwt.split(".");

    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(header)))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(claims)))).toEqual({ iat: 999_940, exp: 1_000_540, iss: "42" });
    expect(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pair.publicKey, fromBase64Url(signature), new TextEncoder().encode(`${header}.${claims}`))).toBe(true);
  });
});

describe("pushed", () => {
  const push = (fields: { readonly ref?: string; readonly deleted?: boolean }) => JSON.stringify({ ref: "refs/heads/main", repository: { id: 7, full_name: "ada/site", private: true }, ...fields });

  test("is the repo and branch a branch push moved", () => {
    expect(pushed(push({}))).toEqual(Option.some({ repository: { id: 7, full_name: "ada/site", private: true }, branch: "main" }));
    expect(Option.map(pushed(push({ ref: "refs/heads/feature/x" })), (moved) => moved.branch)).toEqual(Option.some("feature/x"));
  });

  test("is nothing for a tag, a deleted branch, or another event", () => {
    expect(pushed(push({ ref: "refs/tags/v1" }))).toEqual(Option.none());
    expect(pushed(push({ deleted: true }))).toEqual(Option.none());
    expect(pushed(JSON.stringify({ zen: "Keep it logically awesome." }))).toEqual(Option.none());
  });
});

describe("importSource", () => {
  test("carries the token only for a private repo", () => {
    expect(importSource({ full_name: "ada/site", private: true }, "ghs_1")).toBe("https://x-access-token:ghs_1@github.com/ada/site.git");
    expect(importSource({ full_name: "ada/site", private: false }, "ghs_1")).toBe("https://github.com/ada/site.git");
    expect(installUrl({ slug: "ficus-fruit-cards" })).toBe("https://github.com/apps/ficus-fruit-cards/installations/new");
  });
});
