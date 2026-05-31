import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { AuditLogger } from "../../src/audit/audit-log.js";

describe("AuditLogger", () => {
  let tmpDir: string;
  let logPath: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "audit-test-"));
    logPath = join(tmpDir, "audit.jsonl");
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("writes a log entry as JSONL", async () => {
    const logger = new AuditLogger(logPath);
    await logger.log({
      timestamp: "2026-01-01T00:00:00.000Z",
      chatContextId: "default",
      tool: "shell.run",
      projectId: "test",
      command: "ls -la",
      exitCode: 0,
      durationMs: 100,
      redactions: [],
    });

    const content = readFileSync(logPath, "utf-8").trim();
    const parsed = JSON.parse(content);
    expect(parsed.tool).toBe("shell.run");
    expect(parsed.command).toBe("ls -la");
  });

  it("appends multiple entries", async () => {
    const logger = new AuditLogger(logPath);
    await logger.log({
      timestamp: "2026-01-01T00:00:01.000Z",
      chatContextId: "default",
      tool: "project.select",
      projectId: "test",
    });
    await logger.log({
      timestamp: "2026-01-01T00:00:02.000Z",
      chatContextId: "default",
      tool: "shell.run",
      projectId: "test",
      command: "npm test",
      exitCode: 0,
      durationMs: 200,
      redactions: [],
    });

    const lines = readFileSync(logPath, "utf-8").trim().split("\n");
    expect(lines.length).toBe(3);
  });
});
