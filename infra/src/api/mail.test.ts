import { describe, expect, test } from "bun:test";
import { verificationMail } from "./mail.ts";

describe("verificationMail", () => {
  test("carries the link in both parts, escaped in the HTML", () => {
    const url = "https://ficus.fruit.cards/api/auth/verify-email?token=t&callbackURL=/";
    const mail = verificationMail("ada@example.com", url);

    expect(mail.to).toBe("ada@example.com");
    expect(mail.text).toContain(url);
    expect(mail.html).toContain('href="https://ficus.fruit.cards/api/auth/verify-email?token=t&amp;callbackURL=/"');
    expect(mail.html).not.toContain("token=t&callbackURL");
  });
});
