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

describe("MCP server launcher", () => {
  it("refuses to start when another server service owns the lock", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-server-"));
    tempDirs.push(tempDir);
    const lockDir = path.join(tempDir, "server.lock");
    mkdirSync(lockDir);
    writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n`);

    const result = spawnSync("/bin/bash", [path.resolve("scripts/server.sh")], {
      cwd: path.resolve("."),
      env: {
        ...process.env,
        LOCAL_DEV_MCP_SERVER_LOCK_DIR: lockDir,
      },
      encoding: "utf8",
    });

    expect(result.status).toBe(75);
    expect(result.stderr).toContain("Another instance is already running");
  });
});
