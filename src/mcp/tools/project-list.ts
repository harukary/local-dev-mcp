import type { AppContext } from "../server.js";

export async function handleProjectList(ctx: AppContext, chatContextId: string) {
  const projects = ctx.registry.getAll();
  const current = resolveCurrentProjectId(ctx, chatContextId);

  const result = {
    projects: projects.map((p) => ({
      project_id: p.projectId,
      display_name: p.displayName,
      sandbox_type: p.sandboxType,
      network_policy: p.networkPolicy,
      write_policy: p.writePolicy,
      approval_mode: p.approvalMode,
      current: p.projectId === current,
    })),
  };

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
  };
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
