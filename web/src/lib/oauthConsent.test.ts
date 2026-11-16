import { describe, expect, it } from "vitest";
import { isTrustedRedirect } from "./oauthConsent";

describe("isTrustedRedirect", () => {
  it("accepts Claude's callback addresses", () => {
    expect(isTrustedRedirect("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isTrustedRedirect("https://claude.com/api/mcp/auth_callback")).toBe(true);
  });
  it("refuses look-alikes and other places", () => {
    for (const u of [
      "http://claude.ai/api/mcp/auth_callback", "https://claude.ai.evil.com/api/mcp/auth_callback", "https://evil.com/claude.ai/api/mcp/auth_callback",
      "https://claude.ai@evil.com/api/mcp/auth_callback", "https://claude.ai:8443/api/mcp/auth_callback", "https://claude.ai/other", "http://localhost:6274/callback", "not a url", "",
    ]) expect(isTrustedRedirect(u), u).toBe(false);
  });
});
