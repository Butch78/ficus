import { describe, expect, test } from "bun:test";
import { TOKEN_PLACEHOLDER, withDeployToken } from "./deploy-token.ts";

describe("withDeployToken", () => {
  test("swaps the placeholder for the deploy token", () => {
    expect(withDeployToken(`Bearer ${TOKEN_PLACEHOLDER}`, "real")).toBe("Bearer real");
  });

  test("passes a credential the API issued unchanged", () => {
    expect(withDeployToken("Bearer upload-jwt", "real")).toBe("Bearer upload-jwt");
  });

  test("adds nothing to a request with no credentials", () => {
    expect(withDeployToken(null, "real")).toBeNull();
  });
});
