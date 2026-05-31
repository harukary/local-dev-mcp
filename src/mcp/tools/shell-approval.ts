import {
  claimApprovalRequest,
  completeApprovalRequest,
  rejectRequest,
  releaseApprovalRequest,
} from "../../shell/approval.js";
import { startJob } from "../../shell/job-manager.js";
import { classifyRisk, isCatastrophicCommand } from "../../shell/risk-classifier.js";
import type { AppContext } from "../server.js";

export async function handleShellApprove(ctx: AppContext, chatContextId: string, args: { approval_request_id: string }) {
  if (!args?.approval_request_id) {
    return {
      content: [{ type: "text", text: "Missing required argument: approval_request_id" }],
      isError: true,
    };
  }

  const request = claimApprovalRequest(chatContextId, args.approval_request_id);
  if (!request) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "APPROVAL_NOT_FOUND",
          message: `No pending approval request found for this chat context: "${args.approval_request_id}".`,
            },
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  const project = ctx.registry.get(request.projectId);
  if (!project) {
    releaseApprovalRequest(request.id);
    await ctx.auditLogger.log({
      timestamp: new Date().toISOString(),
      chatContextId,
      tool: "shell.approve",
      event: "approval_execution_failed",
      projectId: request.projectId,
      command: request.command,
      purpose: request.purpose,
      riskLevel: request.riskLevel,
      enforcement: "approval_required",
      approvalRequestId: request.id,
      approvalPolicy: request.approvalPolicy,
      approval: {
        required: true,
        approved: null,
      },
      error: `Approved project is no longer available: "${request.projectId}".`,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "PROJECT_NOT_FOUND",
              message: `Approved project is no longer available: "${request.projectId}".`,
            },
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  const currentRisk = classifyRisk(request.command, project.deniedPaths);
  if (shouldBlockApprovedCommand(project.approvalMode, request.command, currentRisk.level)) {
    releaseApprovalRequest(request.id);
    await ctx.auditLogger.log({
      timestamp: new Date().toISOString(),
      chatContextId,
      tool: "shell.run",
      event: "approved_command_blocked",
      projectId: project.projectId,
      command: request.command,
      purpose: request.purpose,
      riskLevel: currentRisk.level,
      enforcement: "blocked",
      approvalRequestId: request.id,
      approvalPolicy: request.approvalPolicy,
      approval: {
        required: true,
        approved: null,
      },
      error: `Forbidden after approval: ${currentRisk.reasons.join(", ")}`,
    });
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "FORBIDDEN_COMMAND",
              message: "This command is no longer allowed and was not executed.",
              approval_request_id: request.id,
              risk_level: currentRisk.level,
              reasons: currentRisk.reasons,
            },
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  if (request.async) {
    const result = startJob(project, request.command, request.purpose, request.timeoutSeconds);
    if ("error" in result) {
      releaseApprovalRequest(request.id);
      await ctx.auditLogger.log({
        timestamp: new Date().toISOString(),
        chatContextId,
        tool: "shell.run",
        event: "approval_execution_failed",
        projectId: project.projectId,
        command: request.command,
        purpose: request.purpose,
        riskLevel: currentRisk.level,
        enforcement: "approval_required",
        approvalRequestId: request.id,
        approvalPolicy: request.approvalPolicy,
        approval: {
          required: true,
          approved: null,
        },
        error: result.error,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ error: result.error }, null, 2) }],
        isError: true,
      };
    }

    ctx.contextStore.recordShellRun(chatContextId);
    completeApprovalRequest(request.id);
    await logApprovalApproved(ctx, chatContextId, request);
    await ctx.auditLogger.log({
      timestamp: new Date().toISOString(),
      chatContextId,
      tool: "shell.run",
      event: "approved_command_started",
      projectId: project.projectId,
      command: request.command,
      purpose: request.purpose,
      riskLevel: result.riskLevel,
      enforcement: "approval_required",
      approvalRequestId: request.id,
      approvalPolicy: request.approvalPolicy,
      approval: {
        required: true,
        approved: true,
      },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            approved: true,
            executed: true,
            async: true,
            approval_request_id: request.id,
            job_id: result.id,
            project_id: project.projectId,
            command: result.command,
            risk_level: result.riskLevel,
            status: "running",
            message: "Approved job started. Use shell.status to check progress.",
          }, null, 2),
        },
      ],
    };
  }

  ctx.contextStore.recordShellRun(chatContextId);
  const result = await ctx.shellRunner.run(
    project,
    {
      command: request.command,
      timeoutSeconds: request.timeoutSeconds,
      purpose: request.purpose,
    },
    chatContextId
  );

  completeApprovalRequest(request.id);
  await logApprovalApproved(ctx, chatContextId, request);
  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "shell.run",
    event: "approved_command_executed",
    projectId: result.projectId,
    cwd: result.cwd,
    command: result.command,
    purpose: result.purpose,
    riskLevel: result.riskLevel,
    enforcement: "approval_required",
    approvalRequestId: request.id,
    approvalPolicy: request.approvalPolicy,
    approval: {
      required: true,
      approved: true,
    },
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    redactions: result.redactions,
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          approved: true,
          executed: true,
          approval_request_id: request.id,
          project_id: result.projectId,
          cwd: result.cwd,
          command: request.command,
          risk_level: request.riskLevel,
          exit_code: result.exitCode,
          duration_ms: result.durationMs,
          stdout: result.stdout,
          stderr: result.stderr,
          stdout_truncated: result.stdoutTruncated,
          stderr_truncated: result.stderrTruncated,
          redactions: result.redactions,
        }, null, 2),
      },
    ],
  };
}

async function logApprovalApproved(
  ctx: AppContext,
  chatContextId: string,
  request: {
    id: string;
    projectId: string;
    command: string;
    purpose?: string;
    riskLevel: ReturnType<typeof classifyRisk>["level"];
    approvalPolicy: "ask" | "deny";
  }
): Promise<void> {
  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "shell.approve",
    event: "approval_approved",
    projectId: request.projectId,
    command: request.command,
    purpose: request.purpose,
    riskLevel: request.riskLevel,
    approvalRequestId: request.id,
    approvalPolicy: request.approvalPolicy,
    approval: {
      required: true,
      approved: true,
    },
  });
}

function shouldBlockApprovedCommand(approvalMode: string, command: string, riskLevel: string): boolean {
  if (riskLevel === "forbidden") {
    return true;
  }
  if (approvalMode === "never") {
    return false;
  }
  if (approvalMode === "catastrophic_only") {
    return isCatastrophicCommand(command);
  }
  return false;
}

export async function handleShellReject(ctx: AppContext, chatContextId: string, args: { approval_request_id: string }) {
  if (!args?.approval_request_id) {
    return {
      content: [{ type: "text", text: "Missing required argument: approval_request_id" }],
      isError: true,
    };
  }

  const request = rejectRequest(chatContextId, args.approval_request_id);
  if (!request) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "APPROVAL_NOT_FOUND",
          message: `No pending approval request found for this chat context: "${args.approval_request_id}".`,
            },
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  await ctx.auditLogger.log({
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "shell.reject",
    event: "approval_rejected",
    projectId: request.projectId,
    command: request.command,
    purpose: request.purpose,
    riskLevel: request.riskLevel,
    approvalRequestId: request.id,
    approvalPolicy: request.approvalPolicy,
    approval: {
      required: true,
      approved: false,
    },
  });

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({
          rejected: true,
          approval_request_id: request.id,
          command: request.command,
          risk_level: request.riskLevel,
        }, null, 2),
      },
    ],
  };
}
