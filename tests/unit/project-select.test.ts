import { describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import { handleProjectSelect } from "../../src/mcp/tools/project-select.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";

const project: ProjectConfig = {
  projectId: "alpha",
  displayName: "Alpha",
  hostRoot: "/tmp/alpha",
  sandboxRoot: "/tmp/alpha",
  sandboxType: "host",
  defaultShell: "/bin/bash",
  defaultTimeoutSeconds: 30,
  maxTimeoutSeconds: 300,
  networkPolicy: "ask",
  writePolicy: "allow",
  approvalMode: "catastrophic_only",
  deniedPaths: [],
  redactionProfile: "default",
};

function payload(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

describe("handleProjectSelect", () => {
  it("avoids persistence and audit work when selecting the same project twice", async () => {
    const contextStore = new ChatContextStore();
    const save = vi.spyOn(contextStore, "save");
    const audit = vi.fn().mockResolvedValue(undefined);
    const ctx = {
      registry: {
        get: (projectId: string) => projectId === project.projectId ? project : undefined,
        getAll: () => [project],
        has: (projectId: string) => projectId === project.projectId,
      },
      contextStore,
      auditLogger: { log: audit },
    } as unknown as AppContext;

    const first = await handleProjectSelect(ctx, "chat-a", { project_id: "alpha" });
    expect(payload(first)).toMatchObject({ selected: true, changed: true, project_id: "alpha" });
    expect(first.structuredContent).toMatchObject({ changed: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);

    const second = await handleProjectSelect(ctx, "chat-a", { project_id: "alpha" });
    expect(payload(second)).toMatchObject({ selected: true, changed: false, project_id: "alpha" });
    expect(second.structuredContent).toMatchObject({ changed: false });
    expect(save).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });
});
