import { describe, expect, it, vi } from "vitest";
import { handleProjectReload } from "../../src/mcp/tools/project-reload.js";

describe("handleProjectReload", () => {
  it("reloads the registry and returns a concise structured result", async () => {
    const reload = vi.fn().mockResolvedValue(["alpha", "beta"]);
    const clearCache = vi.fn();
    const reloadProjectRegistry = vi.fn(async (ctx) => {
      const projectIds = await ctx.registry.reload();
      ctx.shellRunner.clearCache();
      return projectIds;
    });

    const result = await handleProjectReload({
      configPath: "/tmp/projects.yaml",
      registry: { reload } as never,
      contextStore: {} as never,
      shellRunner: { clearCache } as never,
      auditLogger: {} as never,
    }, reloadProjectRegistry);

    expect(reloadProjectRegistry).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(clearCache).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              reloaded: true,
              config_path: "/tmp/projects.yaml",
              project_count: 2,
              projects: ["alpha", "beta"],
            },
            null,
            2
          ),
        },
      ],
    });
  });
});
