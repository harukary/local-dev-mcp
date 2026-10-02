import { lstat, open } from "node:fs/promises";
import { join, relative } from "node:path";
import type { AppContext } from "../server.js";
import type { AuditLogEntry } from "../../types.js";
import { resolveWorkingDirectory } from "../../project/working-directory.js";

const MAX_AGENT_INSTRUCTIONS_BYTES = 64 * 1024;

async function readAgentInstructions(projectRoot: string, workingRoot: string) {
  const candidates = workingRoot === projectRoot
    ? [join(projectRoot, "AGENTS.md")]
    : [join(workingRoot, "AGENTS.md"), join(projectRoot, "AGENTS.md")];

  for (const path of candidates) {
    try {
      const info = await lstat(path);
      if (!info.isFile()) continue;

      const bytesToRead = Math.min(info.size, MAX_AGENT_INSTRUCTIONS_BYTES);
      const buffer = Buffer.alloc(bytesToRead);
      const file = await open(path, "r");
      try {
        const { bytesRead } = await file.read(buffer, 0, bytesToRead, 0);
        return {
          path: relative(projectRoot, path).replace(/\\/g, "/") || "AGENTS.md",
          content: buffer.subarray(0, bytesRead).toString("utf8"),
          truncated: info.size > MAX_AGENT_INSTRUCTIONS_BYTES,
        };
      } finally {
        await file.close();
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      throw error;
    }
  }

  return null;
}

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

  const agentInstructions = await readAgentInstructions(project.hostRoot, working.hostRoot);

  return jsonResult({
    selected: true,
    changed,
    project_id: project.projectId,
    display_name: project.displayName,
    project_root: project.hostRoot,
    working_dir: working.relativePath,
    cwd: working.hostRoot,
    sandbox_type: project.sandboxType,
    agent_instructions: agentInstructions,
  });
}
