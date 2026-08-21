import { describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import { handleShellRun } from "../../src/mcp/tools/shell-run.js";
import type { AppContext } from "../../src/mcp/server.js";

vi.mock("../../src/shell/credential-env.js", () => ({
  resolveCredentialEnv: vi.fn(async () => ({
    BWS_ACCESS_TOKEN: "test-token",
    PATH: "/tmp/bitwarden-bin:/usr/bin",
  })),
}));

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

  it("blocks forbidden-classified commands even in catastrophic_only mode", async () => {
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

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe("FORBIDDEN_COMMAND");
    expect(shellRunner.run).not.toHaveBeenCalled();
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

  it("uses Bitwarden access without forcing approval for an otherwise safe command", async () => {
    const contextStore = new ChatContextStore();
    contextStore.setCurrentProject("chat-a", "alpha");
    const shellRunner = {
      run: vi.fn().mockResolvedValue({
        projectId: "alpha",
        cwd: "/tmp/alpha",
        command: "pnpm env:sync",
        purpose: undefined,
        credentialScope: "bitwarden",
        riskLevel: "read",
        exitCode: 0,
        durationMs: 1,
        stdout: "ok",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        redactions: [],
      }),
    };
    const project = {
      projectId: "alpha",
      displayName: "Alpha",
      hostRoot: "/tmp/alpha",
      sandboxRoot: "/tmp/alpha",
      sandboxType: "host",
      defaultShell: "/bin/bash",
      defaultTimeoutSeconds: 30,
      maxTimeoutSeconds: 300,
      networkPolicy: "allow",
      writePolicy: "allow",
      approvalMode: "catastrophic_only",
      deniedPaths: [],
      redactionProfile: "default",
    };
    const ctx = {
      registry: {
        has: () => true,
        get: () => project,
        getAll: () => [project],
      },
      contextStore,
      shellRunner,
      auditLogger: { log: vi.fn() },
    } as unknown as AppContext;

    const result = await handleShellRun(ctx, "chat-a", {
      command: "pnpm env:sync",
      credential_scope: "bitwarden",
    });

    expect(result.isError).not.toBe(true);
    expect(shellRunner.run).toHaveBeenCalledWith(
      project,
      expect.objectContaining({
        command: "pnpm env:sync",
        credentialScope: "bitwarden",
        env: {
          BWS_ACCESS_TOKEN: "test-token",
          PATH: "/tmp/bitwarden-bin:/usr/bin",
        },
      }),
      "chat-a"
    );
  });
  it("requires async mode for long-running jobs", async () => {
    const contextStore = new ChatContextStore();
    const ctx = {
      registry: { has: () => true, get: () => undefined, getAll: () => [] },
      contextStore,
      shellRunner: { run: vi.fn() },
      auditLogger: { log: vi.fn() },
    } as unknown as AppContext;

    const result = await handleShellRun(ctx, "chat-a", { command: "sleep 10", long_running: true });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).error.code).toBe("INVALID_ARGUMENT");
  });


  it("rejects synchronous requests that approach the plugin deadline", async () => {
    const contextStore = new ChatContextStore();
    contextStore.setCurrentProject("chat-a", "alpha");
    const shellRunner = { run: vi.fn() };
    const project = {
      projectId: "alpha",
      defaultTimeoutSeconds: 30,
    };
    const ctx = {
      registry: {
        has: (projectId: string) => projectId === "alpha",
        get: (projectId: string) => (projectId === "alpha" ? project : undefined),
        getAll: () => [project],
      },
      contextStore,
      shellRunner,
      auditLogger: { log: vi.fn() },
    } as unknown as AppContext;

    const result = await handleShellRun(ctx, "chat-a", { command: "sleep 300", timeout_seconds: 300 });
    const error = JSON.parse(result.content[0].text).error;

    expect(result.isError).toBe(true);
    expect(error.code).toBe("USE_ASYNC");
    expect(error.max_sync_timeout_seconds).toBe(240);
    expect(shellRunner.run).not.toHaveBeenCalled();
  });

  it("also rejects a project default timeout above the synchronous safety limit", async () => {
    const contextStore = new ChatContextStore();
    contextStore.setCurrentProject("chat-a", "alpha");
    const shellRunner = { run: vi.fn() };
    const project = {
      projectId: "alpha",
      defaultTimeoutSeconds: 300,
    };
    const ctx = {
      registry: {
        has: (projectId: string) => projectId === "alpha",
        get: (projectId: string) => (projectId === "alpha" ? project : undefined),
        getAll: () => [project],
      },
      contextStore,
      shellRunner,
      auditLogger: { log: vi.fn() },
    } as unknown as AppContext;

    const result = await handleShellRun(ctx, "chat-a", { command: "sleep 300" });
    const error = JSON.parse(result.content[0].text).error;

    expect(result.isError).toBe(true);
    expect(error.code).toBe("USE_ASYNC");
    expect(error.requested_timeout_seconds).toBe(300);
    expect(shellRunner.run).not.toHaveBeenCalled();
  });

});
