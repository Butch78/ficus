import { describe, expect, test } from "bun:test";
import { hasCredentials, redactCredentials, withoutCredentials } from "./remote.ts";

describe("withoutCredentials", () => {
  test("drops a token from a remote", () => {
    expect(withoutCredentials("https://x-access-token:ghs_secret@github.com/owner/repo.git")).toBe("https://github.com/owner/repo.git");
    expect(withoutCredentials("https://user@example.com/repo")).toBe("https://example.com/repo");
  });

  test("leaves a plain remote, and anything that is not a URL, as it is", () => {
    expect(withoutCredentials("https://github.com/owner/repo")).toBe("https://github.com/owner/repo");
    expect(withoutCredentials("not a url")).toBe("not a url");
  });
});

describe("redactCredentials", () => {
  test("drops credentials from every URL a message quotes", () => {
    expect(redactCredentials("could not fetch https://x-access-token:ghs_1@github.com/a/b.git (401)")).toBe("could not fetch https://github.com/a/b.git (401)");
    expect(redactCredentials("nothing to hide at https://github.com/a/b")).toBe("nothing to hide at https://github.com/a/b");
  });
});

describe("hasCredentials", () => {
  test("tells a remote with a token from a plain one", () => {
    expect(hasCredentials("https://x-access-token:ghs_1@github.com/a/b.git")).toBe(true);
    expect(hasCredentials("https://github.com/a/b.git")).toBe(false);
  });
});
