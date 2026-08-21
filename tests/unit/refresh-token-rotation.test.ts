import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RefreshTokenRotator } from "../../src/mcp/refresh-token-rotation.js";
import { TokenStore } from "../../src/mcp/token-store.js";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

function setup() {
  tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-refresh-"));
  const store = new TokenStore(join(tmpRoot, "tokens.json"));
  store.setAccessToken("access-token", {
    token: "access-token",
    clientId: "client-a",
    scopes: ["all", "offline_access"],
    expiresAt: 1,
  });
  store.setRefreshToken("refresh-old", "access-token");
  let now = 1_000_000;
  const rotator = new RefreshTokenRotator(store, {
    replayWindowMs: 30_000,
    now: () => now,
    issueToken: () => "refresh-new",
  });
  return { store, rotator, advance: (milliseconds: number) => { now += milliseconds; } };
}

describe("RefreshTokenRotator", () => {
  it("replays the same rotated token for concurrent refresh requests", async () => {
    const { store, rotator } = setup();

    const first = rotator.exchange("client-a", "refresh-old", undefined, 3600);
    const concurrentRetry = rotator.exchange("client-a", "refresh-old", undefined, 3600);

    expect(concurrentRetry).toEqual(first);
    expect(first.refresh_token).toBe("refresh-new");
    expect(store.getRefreshToken("refresh-old")).toBeUndefined();
    expect(store.getRefreshToken("refresh-new")).toBe("access-token");
    await store.shutdown();
  });

  it("rejects the old token after the replay window", async () => {
    const { store, rotator, advance } = setup();
    rotator.exchange("client-a", "refresh-old", undefined, 3600);
    advance(30_001);

    expect(() => rotator.exchange("client-a", "refresh-old", undefined, 3600)).toThrow(
      "Invalid refresh token"
    );
    await store.shutdown();
  });

  it("does not let another client consume or revoke a refresh token", async () => {
    const { store, rotator } = setup();

    expect(() => rotator.exchange("client-b", "refresh-old", undefined, 3600)).toThrow(
      "Invalid refresh token"
    );
    rotator.revoke("client-b", "refresh-old");
    expect(store.getRefreshToken("refresh-old")).toBe("access-token");
    await store.shutdown();
  });

  it("revoking a replayed old token also revokes its replacement", async () => {
    const { store, rotator } = setup();
    rotator.exchange("client-a", "refresh-old", undefined, 3600);

    rotator.revoke("client-a", "refresh-old");

    expect(store.getRefreshToken("refresh-new")).toBeUndefined();
    expect(() => rotator.exchange("client-a", "refresh-old", undefined, 3600)).toThrow(
      "Invalid refresh token"
    );
    await store.shutdown();
  });
});
