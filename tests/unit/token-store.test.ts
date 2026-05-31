import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TokenStore } from "../../src/mcp/token-store.js";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

describe("TokenStore", () => {
  it("persists token data with owner-only permissions", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-token-store-"));
    const filePath = join(tmpRoot, "state", "tokens.json");
    const store = new TokenStore(filePath);

    store.setAccessToken("access-token", {
      token: "access-token",
      clientId: "client-a",
      scopes: [],
      expiresAt: Math.floor(Date.now() / 1000) + 60,
    });
    await store.shutdown();

    expect(statSync(join(tmpRoot, "state")).mode & 0o777).toBe(0o700);
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it("keeps expired access token metadata when a refresh token references it", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-token-store-"));
    const filePath = join(tmpRoot, "state", "tokens.json");
    const store = new TokenStore(filePath);

    store.setAccessToken("expired-access-token", {
      token: "expired-access-token",
      clientId: "client-a",
      scopes: ["all"],
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });
    store.setRefreshToken("refresh-token", "expired-access-token");
    await store.shutdown();

    const loaded = new TokenStore(filePath);
    await loaded.load();

    expect(loaded.getRefreshToken("refresh-token")).toBe("expired-access-token");
    expect(loaded.getAccessToken("expired-access-token")?.clientId).toBe("client-a");
  });

  it("drops expired access token metadata when no refresh token references it", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-token-store-"));
    const filePath = join(tmpRoot, "state", "tokens.json");
    const store = new TokenStore(filePath);

    store.setAccessToken("expired-access-token", {
      token: "expired-access-token",
      clientId: "client-a",
      scopes: ["all"],
      expiresAt: Math.floor(Date.now() / 1000) - 60,
    });
    await store.shutdown();

    const loaded = new TokenStore(filePath);
    await loaded.load();

    expect(loaded.getAccessToken("expired-access-token")).toBeUndefined();
  });
});
