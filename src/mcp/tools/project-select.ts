import type { AppContext } from "../server.js";
import type { AuditLogEntry } from "../../types.js";

function jsonResult(value: Record<string, unknown>) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

function jsonError(code: string, message: string, details?: Record<string, unknown>) {
  const value = { error: { code, message, ...(details ? { details } : {}) } };
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError: true,
  };
}

export async function handleProjectSelect(
  ctx: AppContext,
  chatContextId: string,
  args: { project_id: string }
) {
  const projectId = args?.project_id;
  if (!projectId) return jsonError("PROJECT_ID_REQUIRED", "Missing required argument: project_id");

  const project = ctx.registry.get(projectId);
  if (!project) {
    return jsonError("PROJECT_NOT_FOUND", `Unknown project: "${projectId}".`, {
      available_projects: ctx.registry.getAll().map((p) => p.projectId),
    });
  }

  const changed = ctx.contextStore.getCurrentProject(chatContextId) !== projectId;
  if (changed) {
    ctx.contextStore.setCurrentProject(chatContextId, projectId);
    await ctx.contextStore.save();

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      chatContextId,
      tool: "project.select",
      projectId,
    };
    await ctx.auditLogger.log(entry);
  }

  return jsonResult({
    selected: true,
    changed,
    project_id: project.projectId,
    display_name: project.displayName,
    cwd: project.hostRoot,
    sandbox_type: project.sandboxType,
  });
}
