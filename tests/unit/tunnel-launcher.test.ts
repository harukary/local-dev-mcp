import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("tunnel launcher", () => {
  it("refuses to start when another launcher owns the lock", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-tunnel-"));
    tempDirs.push(tempDir);

    const lockDir = path.join(tempDir, "launcher.lock");
    const credentialsFile = path.join(tempDir, "credentials.json");
    mkdirSync(lockDir);
    writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n`);
    writeFileSync(credentialsFile, '{"TunnelID":"test-tunnel"}\n');

    const result = spawnSync("/bin/bash", [path.resolve("scripts/tunnel.sh")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        LOCAL_DEV_MCP_CLOUDFLARE_TUNNEL_ID: "test-tunnel",
        LOCAL_DEV_MCP_CLOUDFLARE_CREDENTIALS_FILE: credentialsFile,
        LOCAL_DEV_MCP_LAUNCHER_LOCK_DIR: lockDir,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(75);
    expect(result.stderr).toContain("Another launcher is already running");
  });
});
