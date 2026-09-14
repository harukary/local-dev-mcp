import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  it("reads a bounded line range from large files", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-typed-"));
    const lines = Array.from({ length: 300_000 }, (_, index) => `line-${index + 1}`);
    writeFileSync(join(tmpRoot, "large.log"), `${lines.join("\n")}\n`);
    const ctx = createContext(createProject(tmpRoot));

    const result = await handleWorkspaceRead(ctx, "chat-a", {
      path: "large.log",
      start_line: 299_998,
      end_line: 300_000,
      max_bytes: 1024,
    });
    expect(payload(result).lines).toEqual([
      { line: 299_998, text: "line-299998" },
      { line: 299_999, text: "line-299999" },
      { line: 300_000, text: "line-300000" },
    ]);
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

  it("bounds workspace listings and excludes generated artifacts by default", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-typed-"));
    mkdirSync(join(tmpRoot, "src"));
    mkdirSync(join(tmpRoot, "generated"));
    writeFileSync(join(tmpRoot, "src", "a.ts"), "a\n");
    writeFileSync(join(tmpRoot, "src", "b.ts"), "b\n");
    writeFileSync(join(tmpRoot, "generated", "artifact.txt"), "artifact\n");
    const ctx = createContext(createProject(tmpRoot));

    const bounded = payload(await handleWorkspaceList(ctx, "chat-a", { depth: 2, max_entries: 2 }));
    expect(bounded.entries).toHaveLength(2);
    expect(bounded.truncated).toBe(true);
    expect(bounded.entries.some((entry: { path: string }) => entry.path.startsWith("generated"))).toBe(false);

    const artifacts = payload(await handleWorkspaceList(ctx, "chat-a", { depth: 2, include_artifacts: true }));
    expect(artifacts.entries.some((entry: { path: string }) => entry.path === "generated/artifact.txt")).toBe(true);
  });

  it("supports regex and case-insensitive ripgrep search", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-typed-"));
    writeFileSync(join(tmpRoot, "sample.txt"), "Alpha-123\nbeta\n");
    const ctx = createContext(createProject(tmpRoot));

    const searched = payload(await handleWorkspaceSearch(ctx, "chat-a", { query: "alpha-[0-9]+", regex: true, case_sensitive: false }));
    expect(searched.matches).toMatchObject([{ path: "sample.txt", line: 1, text: "Alpha-123" }]);
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

  it("applies exact text replacement patches and rejects ambiguous matches", async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), "local-dev-mcp-typed-"));
    writeFileSync(join(tmpRoot, "file.txt"), "alpha\nbeta\nalpha\n");
    const ctx = createContext(createProject(tmpRoot));

    const ambiguous = payload(await handleWorkspacePatch(ctx, "chat-a", {
      patches: [{ path: "file.txt", old_text: "alpha", new_text: "omega" }],
    }));
    expect(ambiguous.applied).toBe(false);
    expect(ambiguous.conflicts[0]).toMatchObject({
      reason: "old_text is ambiguous; set replace_all=true to replace all occurrences",
      occurrences: 2,
    });

    const applied = payload(await handleWorkspacePatch(ctx, "chat-a", {
      patches: [{ path: "file.txt", old_text: "alpha", new_text: "omega", replace_all: true }],
    }));
    expect(applied.applied).toBe(true);
    expect(applied.files[0]).toMatchObject({ mode: "text_replace", occurrences_replaced: 2 });
    expect(readFileSync(join(tmpRoot, "file.txt"), "utf8")).toBe("omega\nbeta\nomega\n");
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
