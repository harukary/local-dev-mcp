import type { AppContext } from "../server.js";
import type { AuditLogEntry } from "../../types.js";
import { resolveWorkingDirectory } from "../../project/working-directory.js";

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
  args: { project_id: string; working_dir?: string }
) {
  const projectId = args?.project_id;
  if (!projectId) return jsonError("PROJECT_ID_REQUIRED", "Missing required argument: project_id");

  const project = ctx.registry.get(projectId);
  if (!project) {
    return jsonError("PROJECT_NOT_FOUND", `Unknown project: "${projectId}".`, {
      available_projects: ctx.registry.getAll().map((p) => p.projectId),
    });
  }

  const working = resolveWorkingDirectory(project, args.working_dir);
  if (!working.ok) return jsonError(working.code, working.message);

  const previousProjectId = ctx.contextStore.getCurrentProject(chatContextId);
  const previousWorkingDir = ctx.contextStore.getWorkingDirectory?.(chatContextId);
  const nextWorkingDir = working.relativePath === "." ? undefined : working.relativePath;
  const changed = previousProjectId !== projectId || previousWorkingDir !== nextWorkingDir;
  if (changed) {
    ctx.contextStore.setCurrentProject(chatContextId, projectId);
    ctx.contextStore.setWorkingDirectory?.(chatContextId, nextWorkingDir);
    await ctx.contextStore.save();

    const entry: AuditLogEntry = {
      timestamp: new Date().toISOString(),
      chatContextId,
      tool: "project.select",
      projectId,
      cwd: working.hostRoot,
    };
    await ctx.auditLogger.log(entry);
  }

  return jsonResult({
    selected: true,
    changed,
    project_id: project.projectId,
    display_name: project.displayName,
    project_root: project.hostRoot,
    working_dir: working.relativePath,
    cwd: working.hostRoot,
    sandbox_type: project.sandboxType,
  });
}
