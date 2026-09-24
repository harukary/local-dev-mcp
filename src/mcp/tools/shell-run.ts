import type { AppContext } from "../server.js";
import type { AuditLogEntry } from "../../types.js";
import { classifyRisk, isCatastrophicCommand } from "../../shell/risk-classifier.js";
import { evaluateApproval } from "../../shell/approval.js";
import { startJob } from "../../shell/job-manager.js";
import { resolveCredentialEnv } from "../../shell/credential-env.js";
import type { CredentialScope } from "../../types.js";
import { applyWorkingDirectory } from "../../project/working-directory.js";

const MAX_SYNC_TIMEOUT_SECONDS = 240;

export async function handleShellRun(
  ctx: AppContext,
  chatContextId: string,
  args: {
    command: string;
    timeout_seconds?: number;
    purpose?: string;
    async?: boolean;
    long_running?: boolean;
    credential_scope?: CredentialScope;
  }
) {
  if (!args?.command) {
    return {
      content: [{ type: "text", text: "Missing required argument: command" }],
      isError: true,
    };
  }

  if (args.long_running && !args.async) {
    return {
      content: [{ type: "text", text: JSON.stringify({ error: { code: "INVALID_ARGUMENT", message: "long_running requires async=true" } }, null, 2) }],
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

  const baseProject = ctx.registry.get(currentProjectId);
  if (!baseProject) {
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

  const project = applyWorkingDirectory(
    baseProject,
    ctx.contextStore.getWorkingDirectory?.(chatContextId)
  );

  const effectiveTimeoutSeconds = args.timeout_seconds ?? project.defaultTimeoutSeconds;
  if (!args.async && effectiveTimeoutSeconds > MAX_SYNC_TIMEOUT_SECONDS) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            error: {
              code: "USE_ASYNC",
              message: `Synchronous shell commands cannot use a timeout above ${MAX_SYNC_TIMEOUT_SECONDS} seconds. Use async=true and omit timeout_seconds, then poll shell.status.`,
              requested_timeout_seconds: effectiveTimeoutSeconds,
              max_sync_timeout_seconds: MAX_SYNC_TIMEOUT_SECONDS,
            },
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  const risk = classifyRisk(args.command, project.deniedPaths);
  const approvalReasons = args.credential_scope
    ? [...risk.reasons, `credential scope requested: ${args.credential_scope}`]
    : risk.reasons;

  if (shouldBlockCommand(project, args.command, risk.level)) {
    await ctx.auditLogger.log({
      timestamp: new Date().toISOString(),
      chatContextId,
      tool: "shell.run",
      event: "blocked_command",
      projectId: project.projectId,
      command: args.command,
      riskLevel: risk.level,
      riskReasons: risk.reasons,
      enforcement: "blocked",
      enforcementReason: risk.level === "forbidden"
        ? "risk classifier forbids this command"
        : `catastrophic command blocked by approval mode: ${project.approvalMode}`,
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
    approvalReasons,
    args.purpose,
    {
      async: args.async,
      timeoutSeconds: args.timeout_seconds,
      longRunning: args.long_running ?? (args.async === true && args.timeout_seconds === undefined),
      force: false,
      credentialScope: args.credential_scope,
    }
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
      credentialScope: args.credential_scope,
      riskLevel: risk.level,
      riskReasons: approvalReasons,
      enforcement: "approval_required",
      enforcementReason: approval.request!.approvalPolicy === "deny"
        ? "project policy requires approval for a denied operation"
        : "project policy requires explicit approval",
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
              reasons: approvalReasons,
              command: args.command,
              purpose: args.purpose,
              credential_scope: args.credential_scope,
            },
          }, null, 2),
        },
      ],
      isError: true,
    };
  }

  let credentialEnv: Record<string, string> | undefined;
  if (args.credential_scope) {
    try {
      credentialEnv = await resolveCredentialEnv(args.credential_scope);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await ctx.auditLogger.log({
        timestamp: new Date().toISOString(),
        chatContextId,
        tool: "shell.run",
        event: "credential_resolution_failed",
        projectId: project.projectId,
        command: args.command,
        purpose: args.purpose,
        credentialScope: args.credential_scope,
        riskLevel: risk.level,
        enforcement: "blocked",
        error: message,
      });
      return {
        content: [{ type: "text", text: JSON.stringify({ error: { code: "CREDENTIAL_UNAVAILABLE", message } }, null, 2) }],
        isError: true,
      };
    }
  }

  ctx.contextStore.recordShellRun(chatContextId);

  if (args.async) {
    const longRunning = args.long_running ?? args.timeout_seconds === undefined;
    const result = startJob(
      project,
      args.command,
      args.purpose,
      args.timeout_seconds,
      longRunning,
      args.credential_scope,
      credentialEnv
    );

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
      credentialScope: args.credential_scope,
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
            pid: result.pid,
            long_running: result.longRunning ?? false,
            project_id: project.projectId,
            command: result.command,
            credential_scope: result.credentialScope,
            risk_level: result.riskLevel,
            status: "running",
            message: "Job started. Poll shell.status with wait_ms=30000; use output=none when only completion matters, or reuse cursor when reading output.",
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
      ...(args.credential_scope ? { credentialScope: args.credential_scope } : {}),
      ...(credentialEnv ? { env: credentialEnv } : {}),
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
    credentialScope: result.credentialScope,
    riskLevel: result.riskLevel,
    enforcement: "audit_only",
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    redactions: result.redactions,
    ...(result.timedOut ? { error: `Command timed out after ${effectiveTimeoutSeconds} seconds.` } : {}),
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
            credential_scope: result.credentialScope,
            risk_level: result.riskLevel,
            exit_code: result.exitCode,
            timed_out: result.timedOut,
            duration_ms: result.durationMs,
            stdout: result.stdout,
            stderr: result.stderr,
            stdout_truncated: result.stdoutTruncated,
            stderr_truncated: result.stderrTruncated,
            redactions: result.redactions,
            ...(result.timedOut ? {
              error: {
                code: "COMMAND_TIMEOUT",
                message: `Command timed out after ${effectiveTimeoutSeconds} seconds. Re-run with async=true and poll shell.status instead of retrying synchronously.`,
              },
            } : {}),
          },
          null,
          2
        ),
      },
    ],
    ...(result.timedOut ? { isError: true } : {}),
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
