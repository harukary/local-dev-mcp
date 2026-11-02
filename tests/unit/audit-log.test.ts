import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
    expect(statSync(logPath).mode & 0o777).toBe(0o600);
    expect(statSync(tmpDir).mode & 0o777).toBe(0o700);
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

  it("rotates audit logs before unbounded growth", async () => {
    const rotatingPath = join(tmpDir, "rotating.jsonl");
    const logger = new AuditLogger(rotatingPath, { max_bytes: 1024, backups: 2 });
    const command = "x".repeat(650);
    await logger.log({ timestamp: "2026-01-01T00:00:03.000Z", chatContextId: "default", tool: "shell.run", command });
    await logger.log({ timestamp: "2026-01-01T00:00:04.000Z", chatContextId: "default", tool: "shell.run", command });

    expect(existsSync(`${rotatingPath}.1`)).toBe(true);
    expect(readFileSync(rotatingPath, "utf8")).toContain("2026-01-01T00:00:04.000Z");
    expect(readFileSync(`${rotatingPath}.1`, "utf8")).toContain("2026-01-01T00:00:03.000Z");
    expect(statSync(rotatingPath).mode & 0o777).toBe(0o600);
    expect(statSync(`${rotatingPath}.1`).mode & 0o777).toBe(0o600);
  });

  it("tightens existing audit and rotated-log permissions before new writes", () => {
    const dir = join(tmpDir, "old-audit");
    mkdirSync(dir, { mode: 0o755 });
    chmodSync(dir, 0o755);
    const existing = join(dir, "audit.jsonl");
    writeFileSync(existing, "old data\n", { mode: 0o644 });
    writeFileSync(`${existing}.1`, "older data\n", { mode: 0o644 });
    const logger = new AuditLogger(existing);
    expect(logger).toBeInstanceOf(AuditLogger);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(existing).mode & 0o777).toBe(0o600);
    expect(statSync(`${existing}.1`).mode & 0o777).toBe(0o600);
  });

  it("rejects audit paths that are symbolic links", () => {
    const target = join(tmpDir, "target");
    const link = join(tmpDir, "link.jsonl");
    writeFileSync(target, "protected\n");
    symlinkSync(target, link);
    expect(() => new AuditLogger(link)).toThrow("regular file");
    expect(readFileSync(target, "utf8")).toBe("protected\n");
  });
});
