import type { AppContext } from "../server.js";
import type { AuditLogEntry } from "../../types.js";
import { classifyRisk, isCatastrophicCommand } from "../../shell/risk-classifier.js";
import { evaluateApproval } from "../../shell/approval.js";
import { startJob } from "../../shell/job-manager.js";

export async function handleShellRun(
  ctx: AppContext,
  chatContextId: string,
  args: { command: string; timeout_seconds?: number; purpose?: string; async?: boolean }
) {
  if (!args?.command) {
    return {
      content: [{ type: "text", text: "Missing required argument: command" }],
      isError: true,
    };
  }

  const currentProjectId = resolveCurrentProjectId(ctx, chatContextId);
  if (!currentProjectId) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              error: {
                code: "PROJECT_NOT_SELECTED",
                message:
                  "No project is selected for this chat. Call project.select first.",
                available_projects: ctx.registry.getAll().map((p) => p.projectId),
              },
            },
            null,
            2
          ),
        },
      ],
      isError: true,
    };
  }

  const project = ctx.registry.get(currentProjectId);
  if (!project) {
    ctx.contextStore.clearCurrentProject(chatContextId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "PROJECT_NOT_SELECTED",
              message: "No project is selected for this chat. Call project.select first.",
              available_projects: ctx.registry.getAll().map((p) => p.projectId),
            },
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  const risk = classifyRisk(args.command, project.deniedPaths);

  if (shouldBlockCommand(project, args.command, risk.level)) {
    await ctx.auditLogger.log({
      timestamp: new Date().toISOString(),
      chatContextId,
      tool: "shell.run",
      event: "blocked_command",
      projectId: project.projectId,
      command: args.command,
      riskLevel: risk.level,
      enforcement: "blocked",
      error: `Forbidden: ${risk.reasons.join(", ")}`,
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "FORBIDDEN_COMMAND",
              message: "This command is not allowed.",
              risk_level: risk.level,
              reasons: risk.reasons,
            },
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  const approval = evaluateApproval(
    project,
    chatContextId,
    args.command,
    risk.level,
    risk.reasons,
    args.purpose,
    { async: args.async, timeoutSeconds: args.timeout_seconds }
  );

  if (approval.required) {
    await ctx.auditLogger.log({
      timestamp: new Date().toISOString(),
      chatContextId,
      tool: "shell.run",
      event: "approval_required",
      projectId: project.projectId,
      command: args.command,
      purpose: args.purpose,
      riskLevel: risk.level,
      enforcement: "approval_required",
      approvalRequestId: approval.request!.id,
      approvalPolicy: approval.request!.approvalPolicy,
      approval: {
        required: true,
        approved: null,
      },
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "APPROVAL_REQUIRED",
              message:
                approval.request?.approvalPolicy === "deny"
                  ? "This command is high risk and requires explicit approval before execution."
                  : "This command requires approval before execution.",
              approval_request_id: approval.request!.id,
              approval_policy: approval.request?.approvalPolicy,
              risk_level: risk.level,
              reasons: risk.reasons,
              command: args.command,
              purpose: args.purpose,
            },
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  ctx.contextStore.recordShellRun(chatContextId);

  if (args.async) {
    const result = startJob(project, args.command, args.purpose, args.timeout_seconds);

    if ("error" in result) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ error: result.error }, null, 2),
          },
        ],
        isError: true,
      };
    }

    await ctx.auditLogger.log({
      timestamp: new Date().toISOString(),
      chatContextId,
      tool: "shell.run",
      projectId: project.projectId,
      command: args.command,
      purpose: args.purpose,
      riskLevel: result.riskLevel,
      enforcement: "audit_only",
    });

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            async: true,
            job_id: result.id,
            project_id: project.projectId,
            command: result.command,
            risk_level: result.riskLevel,
            status: "running",
            message: "Job started. Use shell.status to check progress.",
          }, null, 2),
        },
      ],
    };
  }

  const result = await ctx.shellRunner.run(
    project,
    {
      command: args.command,
      timeoutSeconds: args.timeout_seconds,
      purpose: args.purpose,
    },
    chatContextId
  );

  const entry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "shell.run",
    projectId: result.projectId,
    cwd: result.cwd,
    command: result.command,
    purpose: result.purpose,
    riskLevel: result.riskLevel,
    enforcement: "audit_only",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    redactions: result.redactions,
  };
  await ctx.auditLogger.log(entry);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            project_id: result.projectId,
            cwd: result.cwd,
            command: result.command,
            risk_level: result.riskLevel,
            exit_code: result.exitCode,
            duration_ms: result.durationMs,
            stdout: result.stdout,
            stderr: result.stderr,
            stdout_truncated: result.stdoutTruncated,
            stderr_truncated: result.stderrTruncated,
            redactions: result.redactions,
          },
          null,
          2
        ),
      },
    ],
  };
}

function shouldBlockCommand(project: { approvalMode: string }, command: string, riskLevel: string): boolean {
  if (riskLevel === "forbidden") {
    return true;
  }
  if (project.approvalMode === "never") {
    return false;
  }
  if (project.approvalMode === "catastrophic_only") {
    return isCatastrophicCommand(command);
  }
  return false;
}

function resolveCurrentProjectId(ctx: AppContext, chatContextId: string): string | undefined {
  const store = ctx.contextStore as {
    getActiveProject?: (chatContextId: string, isAvailable: (projectId: string) => boolean) => string | undefined;
    getCurrentProject?: (chatContextId: string) => string | undefined;
    clearCurrentProject?: (chatContextId: string) => void;
  };

  const isAvailable = (projectId: string): boolean => {
    if (typeof ctx.registry.has === "function") {
      return ctx.registry.has(projectId);
    }
    if (typeof ctx.registry.get === "function") {
      return Boolean(ctx.registry.get(projectId));
    }
    return ctx.registry.getAll().some((project) => project.projectId === projectId);
  };

  if (typeof store.getActiveProject === "function") {
    return store.getActiveProject(chatContextId, isAvailable);
  }

  const current = store.getCurrentProject?.(chatContextId);
  if (current && !isAvailable(current)) {
    store.clearCurrentProject?.(chatContextId);
    return undefined;
  }
  return current;
}
