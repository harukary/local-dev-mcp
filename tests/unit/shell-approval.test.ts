import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import { clearApprovalRequestsForTests, evaluateApproval, listPendingRequests } from "../../src/shell/approval.js";
import { handleShellApprove, handleShellReject } from "../../src/mcp/tools/shell-approval.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";

const project: ProjectConfig = {
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
  approvalMode: "policy",
  deniedPaths: [],
  redactionProfile: "default",
};

function createContext(activeProject: ProjectConfig = project) {
  const auditLogger = { log: vi.fn().mockResolvedValue(undefined) };
  const contextStore = new ChatContextStore();
  const shellRunner = {
    run: vi.fn().mockResolvedValue({
      projectId: "alpha",
      cwd: "/tmp/alpha",
      command: "npm install zod",
      purpose: "Install zod",
      riskLevel: "network_or_dependency",
      exitCode: 0,
      durationMs: 12,
      stdout: "installed\n",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      redactions: [],
    }),
  };

  return {
    ctx: {
      registry: {
        get: (projectId: string) => (projectId === "alpha" ? activeProject : undefined),
      },
      contextStore,
      shellRunner,
      auditLogger,
    } as unknown as AppContext,
    auditLogger,
    contextStore,
    shellRunner,
  };
}

describe("shell approval tools", () => {
  beforeEach(() => {
    clearApprovalRequestsForTests();
  });

  it("approves and executes the original pending command", async () => {
    const { ctx, auditLogger, contextStore, shellRunner } = createContext();
    const approval = evaluateApproval(
      project,
      "chat-a",
      "npm install zod",
      "network_or_dependency",
      ["npm install"],
      "Install zod",
      { timeoutSeconds: 45 }
    );

    const result = await handleShellApprove(ctx, "chat-a", {
      approval_request_id: approval.request!.id,
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({
      approved: true,
      executed: true,
      project_id: "alpha",
      command: "npm install zod",
      exit_code: 0,
      stdout: "installed\n",
    });
    expect(shellRunner.run).toHaveBeenCalledWith(
      project,
      {
        command: "npm install zod",
        timeoutSeconds: 45,
        purpose: "Install zod",
      },
      "chat-a"
    );
    expect(contextStore.getAll().get("chat-a")?.lastShellRunAt).toBeDefined();
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
      event: "approval_approved",
      approvalRequestId: approval.request!.id,
    }));
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
      event: "approved_command_executed",
      enforcement: "approval_required",
      approvalRequestId: approval.request!.id,
    }));
  });

  it("audits rejected pending commands", async () => {
    const { ctx, auditLogger } = createContext();
    const approval = evaluateApproval(
      project,
      "chat-a",
      "npm install zod",
      "network_or_dependency",
      ["npm install"],
      "Install zod"
    );

    const result = await handleShellReject(ctx, "chat-a", {
      approval_request_id: approval.request!.id,
    });
    const payload = JSON.parse(result.content[0].text);

    expect(payload).toMatchObject({
      rejected: true,
      approval_request_id: approval.request!.id,
    });
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
      event: "approval_rejected",
      approvalRequestId: approval.request!.id,
      approval: {
        required: true,
        approved: false,
      },
    }));
  });

  it("does not consume approval when the command becomes forbidden before execution", async () => {
    const { ctx, auditLogger, shellRunner } = createContext({
      ...project,
      deniedPaths: [".env"],
    });
    const approval = evaluateApproval(
      project,
      "chat-a",
      "cat .env",
      "network_or_dependency",
      ["requires approval before reload"],
      "Inspect env"
    );

    const result = await handleShellApprove(ctx, "chat-a", {
      approval_request_id: approval.request!.id,
    });
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload.error.code).toBe("FORBIDDEN_COMMAND");
    expect(shellRunner.run).not.toHaveBeenCalled();
    expect(listPendingRequests("chat-a")).toHaveLength(1);
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
      event: "approved_command_blocked",
      enforcement: "blocked",
      approvalRequestId: approval.request!.id,
      approval: {
        required: true,
        approved: null,
      },
    }));
  });
});
