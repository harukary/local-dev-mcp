import type { AppContext } from "../server.js";

export async function handleProjectReload(
  ctx: AppContext,
  reloadProjectRegistry: (ctx: AppContext) => Promise<string[]>,
) {
  const projectIds = await reloadProjectRegistry(ctx);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            reloaded: true,
            config_path: ctx.configPath,
            project_count: projectIds.length,
            projects: projectIds,
          },
          null,
          2
        ),
      },
    ],
  };
}
