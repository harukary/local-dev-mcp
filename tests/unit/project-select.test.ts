import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import { handleProjectSelect } from "../../src/mcp/tools/project-select.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";

let root = "";
let codexHome = "";
let previousCodexHome: string | undefined;

beforeEach(() => {
  previousCodexHome = process.env.CODEX_HOME;
  codexHome = mkdtempSync(join(tmpdir(), "local-dev-codex-home-"));
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  if (codexHome) rmSync(codexHome, { recursive: true, force: true });
  root = "";
  codexHome = "";
  if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = previousCodexHome;
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

  it("returns the project AGENTS.md as working instructions", async () => {
    const project = makeProject();
    writeFileSync(join(root, "AGENTS.md"), "# Project instructions\n\n- Use typed tools.\n", "utf8");
    const { ctx } = makeContext(project);

    const result = await handleProjectSelect(ctx, "chat-a", { project_id: "alpha" });

    expect(payload(result)).toMatchObject({
      agent_instructions: {
        path: "AGENTS.md",
        content: "# Project instructions\n\n- Use typed tools.\n",
        truncated: false,
      },
    });
  });

  it("merges global AGENTS.md before project instructions", async () => {
    const project = makeProject();
    writeFileSync(join(codexHome, "AGENTS.md"), "# Global instructions\n\n- Queue heavy work.\n", "utf8");
    writeFileSync(join(root, "AGENTS.md"), "# Project instructions\n\n- Use typed tools.\n", "utf8");
    const { ctx } = makeContext(project);

    const result = await handleProjectSelect(ctx, "chat-a", { project_id: "alpha" });

    expect(payload(result)).toMatchObject({
      agent_instructions: {
        path: "AGENTS.md",
        content: "# Global instructions\n\n- Queue heavy work.\n\n# Project instructions\n\n- Use typed tools.\n",
        truncated: false,
        sources: [
          { scope: "global", path: "$CODEX_HOME/AGENTS.md", truncated: false },
          { scope: "project", path: "AGENTS.md", truncated: false },
        ],
      },
    });
  });

  it("prefers AGENTS.md in the selected working directory", async () => {
    const project = makeProject();
    mkdirSync(join(root, ".worktree", "feature-x"), { recursive: true });
    writeFileSync(join(root, "AGENTS.md"), "root instructions", "utf8");
    writeFileSync(join(root, ".worktree", "feature-x", "AGENTS.md"), "worktree instructions", "utf8");
    const { ctx } = makeContext(project);

    const result = await handleProjectSelect(ctx, "chat-a", {
      project_id: "alpha",
      working_dir: ".worktree/feature-x",
    });

    expect(payload(result)).toMatchObject({
      agent_instructions: {
        path: ".worktree/feature-x/AGENTS.md",
        content: "worktree instructions",
        truncated: false,
      },
    });
  });

  it("returns null when no AGENTS.md exists", async () => {
    const project = makeProject();
    const { ctx } = makeContext(project);

    const result = await handleProjectSelect(ctx, "chat-a", { project_id: "alpha" });

    expect(payload(result)).toMatchObject({ agent_instructions: null });
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
