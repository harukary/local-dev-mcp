import type { AppContext } from "../server.js";
import type { AuditLogEntry } from "../../types.js";

export async function handleProjectSelect(
  ctx: AppContext,
  chatContextId: string,
  args: { project_id: string }
) {
  const projectId = args?.project_id;

  if (!projectId) {
    return {
      content: [{ type: "text", text: "Missing required argument: project_id" }],
      isError: true,
    };
  }

  const project = ctx.registry.get(projectId);
  if (!project) {
    const available = ctx.registry.getAll().map((p) => p.projectId).join(", ");
    return {
      content: [
        {
          type: "text",
          text: `Unknown project: "${projectId}". Available: ${available}`,
        },
      ],
      isError: true,
    };
  }

  ctx.contextStore.setCurrentProject(chatContextId, projectId);

  const entry: AuditLogEntry = {
    timestamp: new Date().toISOString(),
    chatContextId,
    tool: "project.select",
    projectId,
  };
  await ctx.auditLogger.log(entry);

  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            selected: true,
            project_id: project.projectId,
            display_name: project.displayName,
            cwd: project.hostRoot,
            sandbox_type: project.sandboxType,
          },
          null,
          2
        ),
      },
    ],
  };
}
