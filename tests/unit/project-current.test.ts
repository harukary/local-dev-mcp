import { describe, expect, it } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import { handleProjectCurrent } from "../../src/mcp/tools/project-current.js";
import type { AppContext } from "../../src/mcp/server.js";

describe("handleProjectCurrent", () => {
  it("clears a stale selected project before reporting the current state", async () => {
    const contextStore = new ChatContextStore();
    contextStore.setCurrentProject("chat-a", "removed");

    const ctx = {
      registry: {
        has: (projectId: string) => projectId === "alpha",
        getAll: () => [{ projectId: "alpha" }],
      },
      contextStore,
    } as unknown as AppContext;

    const result = await handleProjectCurrent(ctx, "chat-a");
    const payload = JSON.parse(result.content[0].text);

    expect(payload.selected).toBe(false);
    expect(contextStore.getCurrentProject("chat-a")).toBeUndefined();
  });
});
