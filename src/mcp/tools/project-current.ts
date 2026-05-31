import type { AppContext } from "../server.js";

export async function handleProjectCurrent(
  ctx: AppContext,
  chatContextId: string
) {
  const currentProjectId = resolveCurrentProjectId(ctx, chatContextId);

  if (!currentProjectId) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              selected: false,
              message:
                "No project is selected for this chat. Use project.select first.",
              available_projects: ctx.registry.getAll().map((p) => p.projectId),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  const project = ctx.registry.get(currentProjectId);
  if (!project) {
    ctx.contextStore.clearCurrentProject(chatContextId);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              selected: false,
              message: "The selected project is no longer available. Choose another project.",
              available_projects: ctx.registry.getAll().map((p) => p.projectId),
            },
            null,
            2
          ),
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            project_id: project.projectId,
            display_name: project.displayName,
            cwd: project.hostRoot,
            sandbox_type: project.sandboxType,
            network_policy: project.networkPolicy,
            write_policy: project.writePolicy,
            approval_mode: project.approvalMode,
          },
          null,
          2
        ),
      },
    ],
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
