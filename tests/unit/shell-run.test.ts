import { describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import { handleShellRun } from "../../src/mcp/tools/shell-run.js";
import type { AppContext } from "../../src/mcp/server.js";

describe("handleShellRun", () => {
  it("clears a stale selected project before returning an error", async () => {
    const contextStore = new ChatContextStore();
    contextStore.setCurrentProject("chat-a", "removed");

    const ctx = {
      registry: {
        has: (projectId: string) => projectId === "alpha",
        get: (projectId: string) => (projectId === "alpha" ? { projectId: "alpha" } : undefined),
        getAll: () => [{ projectId: "alpha" }],
      },
      contextStore,
      shellRunner: { run: vi.fn() },
      auditLogger: { log: vi.fn() },
    } as unknown as AppContext;

    const result = await handleShellRun(ctx, "chat-a", { command: "pwd" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe("PROJECT_NOT_SELECTED");
    expect(contextStore.getCurrentProject("chat-a")).toBeUndefined();
  });

  it("does not require approval for forbidden-classified commands in catastrophic_only mode", async () => {
    const contextStore = new ChatContextStore();
    contextStore.setCurrentProject("chat-a", "alpha");
    const shellRunner = { run: vi.fn().mockResolvedValue({
      projectId: "alpha",
      cwd: "/tmp/alpha",
      command: "cat .env",
      riskLevel: "forbidden",
      exitCode: 0,
      durationMs: 1,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      redactions: [],
    }) };

    const ctx = {
      registry: {
        has: (projectId: string) => projectId === "alpha",
        get: (projectId: string) => (projectId === "alpha" ? {
          projectId: "alpha",
          displayName: "Alpha",
          hostRoot: "/tmp/alpha",
          sandboxRoot: "/tmp/alpha",
          sandboxType: "host",
          defaultShell: "/bin/bash",
          defaultTimeoutSeconds: 30,
          maxTimeoutSeconds: 300,
          networkPolicy: "ask",
          writePolicy: "confirm",
          approvalMode: "catastrophic_only",
          deniedPaths: [".env"],
          redactionProfile: "default",
        } : undefined),
        getAll: () => [],
      },
      contextStore,
      shellRunner,
      auditLogger: { log: vi.fn() },
    } as unknown as AppContext;

    const result = await handleShellRun(ctx, "chat-a", { command: "cat .env" });

    expect(result.isError).toBeUndefined();
    expect(shellRunner.run).toHaveBeenCalled();
  });

  it("blocks catastrophic commands in catastrophic_only mode", async () => {
    const contextStore = new ChatContextStore();
    contextStore.setCurrentProject("chat-a", "alpha");
    const shellRunner = { run: vi.fn() };

    const ctx = {
      registry: {
        has: (projectId: string) => projectId === "alpha",
        get: (projectId: string) => (projectId === "alpha" ? {
          projectId: "alpha",
          displayName: "Alpha",
          hostRoot: "/tmp/alpha",
          sandboxRoot: "/tmp/alpha",
          sandboxType: "host",
          defaultShell: "/bin/bash",
          defaultTimeoutSeconds: 30,
          maxTimeoutSeconds: 300,
          networkPolicy: "ask",
          writePolicy: "confirm",
          approvalMode: "catastrophic_only",
          deniedPaths: [],
          redactionProfile: "default",
        } : undefined),
        getAll: () => [],
      },
      contextStore,
      shellRunner,
      auditLogger: { log: vi.fn() },
    } as unknown as AppContext;

    const result = await handleShellRun(ctx, "chat-a", { command: "rm -rf /" });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe("FORBIDDEN_COMMAND");
    expect(shellRunner.run).not.toHaveBeenCalled();
  });
});
