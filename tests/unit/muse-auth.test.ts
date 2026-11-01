import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { museWorkContextId, resolveMuseAuthConfig, verifyMuseBearer } from "../../src/mcp/auth-muse.js";

const tempDirs: string[] = [];
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "local-dev-muse-auth-"));
  tempDirs.push(dir);
  const file = join(dir, "token");
  const token = "a".repeat(64);
  writeFileSync(file, token + "\n", { mode: 0o600 });
  return { dir, file, token, env: {
    LOCAL_DEV_MCP_MUSE_HOST: "mac.example-tailnet.ts.net:10000",
    LOCAL_DEV_MCP_MUSE_TOKEN_FILE: file,
  } };
}
afterEach(() => tempDirs.splice(0).forEach(dir => rmSync(dir, { force: true, recursive: true })));

describe("Muse transport authentication", () => {
  it("is disabled by default and requires both options", () => {
    expect(resolveMuseAuthConfig({})).toBeUndefined();
    const { env } = fixture();
    expect(() => resolveMuseAuthConfig({ LOCAL_DEV_MCP_MUSE_HOST: env.LOCAL_DEV_MCP_MUSE_HOST })).toThrow("both");
    expect(() => resolveMuseAuthConfig({ LOCAL_DEV_MCP_MUSE_TOKEN_FILE: env.LOCAL_DEV_MCP_MUSE_TOKEN_FILE })).toThrow("both");
  });

  it("accepts only an exact Tailscale HTTPS Host and private strong token file", () => {
    const { env, file, dir } = fixture();
    const config = resolveMuseAuthConfig(env)!;
    expect(config.host).toBe("mac.example-tailnet.ts.net:10000");
    expect(config.token).toHaveLength(64);
    expect(config.ownerHash).toMatch(/^[a-f0-9]{64}$/);
    for (const host of [
      "mac.example-tailnet.ts.net", "mac.example-tailnet.ts.net:0",
      "https://mac.example-tailnet.ts.net:10000", "mac.example-tailnet.ts.net.attacker.com:10000",
      "127.0.0.1:10000", "mac.example-tailnet.ts.net:99999",
    ]) expect(() => resolveMuseAuthConfig({ ...env, LOCAL_DEV_MCP_MUSE_HOST: host })).toThrow();
    chmodSync(file, 0o644);
    expect(() => resolveMuseAuthConfig(env)).toThrow("private");
    chmodSync(file, 0o600);
    const symlink = join(dir, "linked-token");
    symlinkSync(file, symlink);
    expect(() => resolveMuseAuthConfig({ ...env, LOCAL_DEV_MCP_MUSE_TOKEN_FILE: symlink })).toThrow("regular");
    writeFileSync(file, "weak\n", { mode: 0o600 });
    expect(() => resolveMuseAuthConfig(env)).toThrow("strong");
  });

  it("compares the token and partitions work by authenticated owner, project and directory", () => {
    const { env, token } = fixture();
    const config = resolveMuseAuthConfig(env)!;
    expect(verifyMuseBearer("Bearer " + token, config)).toBe(true);
    expect(verifyMuseBearer(token, config)).toBe(false);
    expect(verifyMuseBearer("Bearer " + token + "x", config)).toBe(false);
    expect(verifyMuseBearer("Bearer " + "x".repeat(64), config)).toBe(false);
    expect(verifyMuseBearer(undefined, config)).toBe(false);
    const a = museWorkContextId(config.ownerHash, "project-a");
    expect(a).toBe(museWorkContextId(config.ownerHash, "project-a", "."));
    expect(a).not.toBe(museWorkContextId(config.ownerHash, "project-b"));
    expect(a).not.toBe(museWorkContextId(config.ownerHash, "project-a", ".worktree/x"));
    expect(a).not.toBe(museWorkContextId("different", "project-a"));
  });
});
