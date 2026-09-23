import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("rotating log supervisor", () => {
  it("rotates child output without restarting the child", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-logs-"));
    tempDirs.push(tempDir);
    const logPath = path.join(tempDir, "service.log");

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/run-with-rotating-log.mjs"),
        logPath,
        "--",
        process.execPath,
        "-e",
        "for (let i=0;i<80;i++) console.error('x'.repeat(80))",
      ],
      {
        env: {
          ...process.env,
          LOCAL_DEV_MCP_LOG_MAX_BYTES: "1024",
          LOCAL_DEV_MCP_LOG_KEEP: "3",
        },
        encoding: "utf8",
      }
    );

    expect(result.status).toBe(0);
    expect(existsSync(logPath)).toBe(true);
    expect(existsSync(`${logPath}.1`)).toBe(true);
    const current = readFileSync(logPath, "utf8");
    const previous = readFileSync(`${logPath}.1`, "utf8");
    expect(current.length).toBeGreaterThan(0);
    expect(previous.length).toBeGreaterThan(0);
    expect(`${previous}${current}`).toMatch(/\[\d{4}-\d{2}-\d{2}T[^\]]+Z\] \[stderr\] x+/);
  });

  it("timestamps complete stdout and stderr lines and flushes partial output", () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), "local-dev-mcp-logs-"));
    tempDirs.push(tempDir);
    const logPath = path.join(tempDir, "service.log");

    const result = spawnSync(
      process.execPath,
      [
        path.resolve("scripts/run-with-rotating-log.mjs"),
        logPath,
        "--",
        process.execPath,
        "-e",
        "process.stdout.write('out\\npartial'); process.stderr.write('err\\n')",
      ],
      { encoding: "utf8" }
    );

    expect(result.status).toBe(0);
    const log = readFileSync(logPath, "utf8");
    expect(log).toMatch(/\[[^\]]+Z\] \[stdout\] out\n/);
    expect(log).toMatch(/\[[^\]]+Z\] \[stdout\] partial\n/);
    expect(log).toMatch(/\[[^\]]+Z\] \[stderr\] err\n/);
  });
});
