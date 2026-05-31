import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatContextStore } from "../../src/project/context-store.js";
import type { AppContext } from "../../src/mcp/server.js";
import type { ProjectConfig } from "../../src/types.js";
import { handleProjectInspect } from "../../src/mcp/tools/dev/project-inspect.js";
import { handleWorkspaceRead } from "../../src/mcp/tools/dev/workspace-read.js";
import { handleWorkspaceList } from "../../src/mcp/tools/dev/workspace-list.js";
import { handleWorkspaceSearch } from "../../src/mcp/tools/dev/workspace-search.js";
import { handleWorkspacePatch } from "../../src/mcp/tools/dev/workspace-patch.js";

let tmpRoot = "";

afterEach(() => {
  if (tmpRoot) {
    rmSync(tmpRoot, { recursive: true, force: true });
    tmpRoot = "";
  }
});

function createProject(hostRoot: string, deniedPaths: string[] = [".env", ".env.*", "secrets"]): ProjectConfig {
  return {
    projectId: "alpha",
    displayName: "Alpha",
    hostRoot,
    sandboxRoot: hostRoot,
    sandboxType: "host",
    defaultShell: "/bin/bash",
    defaultTimeoutSeconds: 30,
    maxTimeoutSeconds: 300,
    networkPolicy: "ask",
    writePolicy: "allow",
    approvalMode: "catastrophic_only",
    deniedPaths,
    redactionProfile: "default",
  };
}

function createContext(project: ProjectConfig) {
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject("chat-a", project.projectId);
  return {
    registry: {
      has: (projectId: string) => projectId === project.projectId,
      get: (projectId: string) => (projectId === project.projectId ? project : undefined),
      getAll: () => [project],
    },
    contextStore,
    auditLogger: { log: vi.fn().mockResolvedValue(undefined) },
  } as unknown as AppContext;
}

function payload(result: { content: Array<{ text?: string }> }) {
  return JSON.parse(result.content[0].text ?? "{}");
}

describe("typed development tools", () => {
  it("inspects package metadata for the selected project", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-typed-"));
    writeFileSync(join(tmpRoot, "package.json"), JSON.stringify({ scripts: { dev: "vite", test: "vitest" }, dependencies: { express: "latest" } }, null, 2));
    writeFileSync(join(tmpRoot, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    writeFileSync(join(tmpRoot, "tsconfig.json"), "{}\n");
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleProjectInspect(ctx, "chat-a");
    const body = payload(result);

    expect(body.package_manager).toBe("pnpm");
    expect(body.scripts).toMatchObject({ dev: "vite", test: "vitest" });
    expect(body.frameworks).toContain("express");
    expect(body.likely_commands.test).toBe("pnpm test");
  });

  it("reads line ranges and rejects denied paths", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-typed-"));
    writeFileSync(join(tmpRoot, "notes.txt"), "one\ntwo\nthree\n");
    writeFileSync(join(tmpRoot, ".env"), "SECRET=value\n");
    const ctx = createContext(createProject(tmpRoot));

    const read = await handleWorkspaceRead(ctx, "chat-a", { path: "notes.txt", start_line: 2, end_line: 3 });
    expect(payload(read).lines).toEqual([{ line: 2, text: "two" }, { line: 3, text: "three" }]);

    const denied = await handleWorkspaceRead(ctx, "chat-a", { path: ".env" });
    expect(denied.isError).toBe(true);
    expect(payload(denied).error.code).toBe("DENIED_PATH");
  });

  it("lists and searches project files while omitting denied paths", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-typed-"));
    mkdirSync(join(tmpRoot, "src"));
    mkdirSync(join(tmpRoot, "secrets"));
    writeFileSync(join(tmpRoot, "src", "app.ts"), "const token = 'public-token';\n");
    writeFileSync(join(tmpRoot, "secrets", "hidden.txt"), "token\n");
    const ctx = createContext(createProject(tmpRoot));

    const listed = payload(await handleWorkspaceList(ctx, "chat-a", { depth: 2 }));
    expect(listed.entries.some((entry: { path: string }) => entry.path === "src/app.ts")).toBe(true);
    expect(listed.entries.some((entry: { path: string }) => entry.path.startsWith("secrets"))).toBe(false);

    const searched = payload(await handleWorkspaceSearch(ctx, "chat-a", { query: "token", context_lines: 0 }));
    expect(searched.matches.map((match: { path: string }) => match.path)).toEqual(["src/app.ts"]);
  });

  it("applies replacement patches and detects expected sha mismatches", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-typed-"));
    writeFileSync(join(tmpRoot, "file.txt"), "before\n");
    const ctx = createContext(createProject(tmpRoot));

    const mismatch = await handleWorkspacePatch(ctx, "chat-a", { patches: [{ path: "file.txt", expected_sha256: "wrong", replacement: "after\n" }] });
    expect(payload(mismatch).applied).toBe(false);
    expect(payload(mismatch).conflicts[0].reason).toBe("expected_sha256 mismatch");

    const applied = await handleWorkspacePatch(ctx, "chat-a", { patches: [{ path: "file.txt", replacement: "after\n" }] });
    const body = payload(applied);
    expect(body.applied).toBe(true);
    expect(body.changed_files).toEqual(["file.txt"]);
    expect(body.files[0].mode).toBe("replacement");
  });

  it("checks unified diff patches in dry-run mode", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-typed-"));
    const ctx = createContext(createProject(tmpRoot));
    const diff = "diff --git a/new.txt b/new.txt\nnew file mode 100644\nindex 0000000..3b18e51\n--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1 @@\n+hello\n";

    const result = await handleWorkspacePatch(ctx, "chat-a", { patches: [{ unified_diff: diff }], dry_run: true });
    const body = payload(result);

    expect(body.applied).toBe(false);
    expect(body.changed_files).toEqual(["new.txt"]);
    expect(body.files[0].mode).toBe("unified_diff");
  });
});
