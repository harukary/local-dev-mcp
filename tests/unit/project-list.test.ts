import { describe, it, expect } from "vitest";
import { handleProjectList } from "../../src/mcp/tools/project-list.js";
import type { AppContext } from "../../src/mcp/server.js";

describe("handleProjectList", () => {
  it("marks the current project for the resolved chat context", async () => {
    const ctx = {
      registry: {
        getAll: () => [
          {
            projectId: "alpha",
            displayName: "Alpha",
            sandboxType: "host",
            networkPolicy: "ask",
            writePolicy: "confirm",
            approvalMode: "catastrophic_only",
          },
          {
            projectId: "beta",
            displayName: "Beta",
            sandboxType: "host",
            networkPolicy: "allow",
            writePolicy: "allow",
            approvalMode: "never",
          },
        ],
      },
      contextStore: {
        getCurrentProject: (chatContextId: string) => (chatContextId === "chat-a" ? "beta" : undefined),
      },
    } as unknown as AppContext;

    const result = await handleProjectList(ctx, "chat-a");
    const payload = JSON.parse(result.content[0].text);

    expect(payload.projects).toEqual([
      expect.objectContaining({ project_id: "alpha", current: false }),
      expect.objectContaining({ project_id: "beta", current: true }),
    ]);
  });
});
