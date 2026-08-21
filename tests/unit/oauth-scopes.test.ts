import { describe, expect, it } from "vitest";
import {
  OAUTH_SCOPES_SUPPORTED,
  resolveAuthorizationScopes,
  resolveRefreshScopes,
} from "../../src/mcp/oauth-scopes.js";

describe("OAuth scopes", () => {
  it("advertises offline access alongside the resource scope", () => {
    expect(OAUTH_SCOPES_SUPPORTED).toEqual(["all", "offline_access"]);
  });

  it("preserves the existing default when a client omits scope", () => {
    expect(resolveAuthorizationScopes(undefined)).toEqual(["all"]);
  });

  it("accepts and deduplicates supported authorization scopes", () => {
    expect(resolveAuthorizationScopes(["all", "offline_access", "all"])).toEqual([
      "all",
      "offline_access",
    ]);
  });

  it("rejects unsupported authorization scopes", () => {
    expect(() => resolveAuthorizationScopes(["unknown"])).toThrow("Unsupported scope: unknown");
  });

  it("allows refresh scope narrowing but rejects expansion", () => {
    expect(resolveRefreshScopes(["all", "offline_access"], ["all"])).toEqual(["all"]);
    expect(() => resolveRefreshScopes(["all"], ["all", "offline_access"])).toThrow(
      "Refresh scope exceeds the original grant: offline_access"
    );
  });
});
