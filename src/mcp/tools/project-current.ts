import type { AppContext } from "../server.js";
import { applyWorkingDirectory } from "../../project/working-directory.js";

function jsonResult(value: Record<string, unknown>) {
  return {
    structuredContent: value,
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
  };
}

export async function handleProjectCurrent(
  ctx: AppContext,
  chatContextId: string,
  options: { stateless?: boolean } = {}
) {
  const currentProjectId = resolveCurrentProjectId(ctx, chatContextId);

  if (!currentProjectId) {
    return jsonResult({
      selected: false,
      message: options.stateless
        ? "This request has no persistent chat project context. Pass project_id and optional working_dir directly on each project-scoped tool call."
        : "No project is selected for this chat. Use project.select first.",
      available_projects: ctx.registry.getAll().map((p) => p.projectId),
    });
  }

  const project = ctx.registry.get(currentProjectId);
  if (!project) {
    ctx.contextStore.clearCurrentProject(chatContextId);
    return jsonResult({
      selected: false,
      message: "The selected project is no longer available. Choose another project.",
      available_projects: ctx.registry.getAll().map((p) => p.projectId),
    });
  }

  const workingDirectory = ctx.contextStore.getWorkingDirectory?.(chatContextId);
  const effectiveProject = applyWorkingDirectory(project, workingDirectory);
  return jsonResult({
    selected: true,
    project_id: project.projectId,
    display_name: project.displayName,
    project_root: project.hostRoot,
    working_dir: workingDirectory ?? ".",
    cwd: effectiveProject.hostRoot,
    sandbox_type: project.sandboxType,
    network_policy: project.networkPolicy,
    write_policy: project.writePolicy,
    approval_mode: project.approvalMode,
  });
}

function resolveCurrentProjectId(ctx: AppContext, chatContextId: string): string | undefined {
  const store = ctx.contextStore as {
    getActiveProject?: (chatContextId: string, isAvailable: (projectId: string) => boolean) => string | undefined;
    getCurrentProject?: (chatContextId: string) => string | undefined;
    clearCurrentProject?: (chatContextId: string) => void;
  };

  const isAvailable = (projectId: string): boolean => {
    if (typeof ctx.registry.has === "function") return ctx.registry.has(projectId);
    if (typeof ctx.registry.get === "function") return Boolean(ctx.registry.get(projectId));
    return ctx.registry.getAll().some((project) => project.projectId === projectId);
  };

  if (typeof store.getActiveProject === "function") return store.getActiveProject(chatContextId, isAvailable);

  const current = store.getCurrentProject?.(chatContextId);
  if (current && !isAvailable(current)) {
    store.clearCurrentProject?.(chatContextId);
    return undefined;
  }
  return current;
}
