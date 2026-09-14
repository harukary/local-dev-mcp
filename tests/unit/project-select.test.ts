import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import { handleProjectSelect } from "../../src/mcp/tools/project-select.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";

let root = "";

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = "";
});

function makeProject(): ProjectConfig {
  root = mkdtempSync(join(tmpdir(), "local-dev-project-select-"));
  return {
    projectId: "alpha",
    displayName: "Alpha",
    hostRoot: root,
    sandboxRoot: root,
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
}

function payload(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

function makeContext(project: ProjectConfig) {
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
  return { ctx, contextStore, save, audit };
}

describe("handleProjectSelect", () => {
  it("avoids persistence and audit work when selecting the same project and working directory twice", async () => {
    const project = makeProject();
    const { ctx, save, audit } = makeContext(project);

    const first = await handleProjectSelect(ctx, "chat-a", { project_id: "alpha" });
    expect(payload(first)).toMatchObject({ selected: true, changed: true, project_id: "alpha", working_dir: "." });
    expect(first.structuredContent).toMatchObject({ changed: true });
    expect(save).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);

    const second = await handleProjectSelect(ctx, "chat-a", { project_id: "alpha" });
    expect(payload(second)).toMatchObject({ selected: true, changed: false, project_id: "alpha", working_dir: "." });
    expect(second.structuredContent).toMatchObject({ changed: false });
    expect(save).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledTimes(1);
  });

  it("persists a project-relative working directory for worktree-style operation", async () => {
    const project = makeProject();
    mkdirSync(join(root, ".worktree", "feature-x"), { recursive: true });
    const { ctx, contextStore, save, audit } = makeContext(project);

    const result = await handleProjectSelect(ctx, "chat-a", {
      project_id: "alpha",
      working_dir: ".worktree/feature-x",
    });

    expect(payload(result)).toMatchObject({
      selected: true,
      changed: true,
      project_id: "alpha",
      project_root: root,
      working_dir: ".worktree/feature-x",
      cwd: join(root, ".worktree", "feature-x"),
    });
    expect(contextStore.getWorkingDirectory("chat-a")).toBe(".worktree/feature-x");
    expect(save).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ cwd: join(root, ".worktree", "feature-x") }));
  });

  it("rejects working directories that escape the selected project", async () => {
    const project = makeProject();
    const { ctx, contextStore } = makeContext(project);

    const result = await handleProjectSelect(ctx, "chat-a", {
      project_id: "alpha",
      working_dir: "../outside",
    });

    expect(payload(result)).toMatchObject({ error: { code: "WORKING_DIRECTORY_OUTSIDE_PROJECT" } });
    expect(contextStore.getCurrentProject("chat-a")).toBeUndefined();
  });
});
