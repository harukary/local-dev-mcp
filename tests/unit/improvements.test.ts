import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../../src/types.js";
import type { AppContext } from "../../src/mcp/server.js";
import { ChatContextStore } from "../../src/project/context-store.js";
import { ShellRunner } from "../../src/shell/runner.js";
import { handleWorkspacePatch } from "../../src/mcp/tools/dev/workspace-patch.js";
import { handleWorkspaceRead } from "../../src/mcp/tools/dev/workspace-read.js";
import { handleWorkspaceList } from "../../src/mcp/tools/dev/workspace-list.js";
import { applyWorkingDirectory } from "../../src/project/working-directory.js";
import { handleWorkspaceSearch } from "../../src/mcp/tools/dev/workspace-search.js";
import { handleProjectInspect } from "../../src/mcp/tools/dev/project-inspect.js";

let root = "";
function fixture() {
  const parent = dirname(process.env.LOCAL_DEV_MCP_JOB_STORE_DIR!);
  root = mkdtempSync(join(parent, "files-"));
  const project: ProjectConfig = { projectId: "test", displayName: "Test", hostRoot: root, sandboxRoot: root, sandboxType: "host", defaultShell: "/bin/bash", defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30, networkPolicy: "ask", writePolicy: "allow", approvalMode: "never", deniedPaths: ["secrets"], redactionProfile: "default" };
  const contextStore = new ChatContextStore();
  contextStore.setCurrentProject("test", project.projectId);
  const ctx = { registry: { get: () => project, has: () => true, getAll: () => [project] }, contextStore, auditLogger: { log: vi.fn() } } as unknown as AppContext;
  return { project, ctx };
}
function payload(result: { content: { text?: string }[] }) { return JSON.parse(result.content[0].text!); }
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = ""; });

describe("capability regressions", () => {
  it("rejects executable-file diffs instead of silently losing executable mode", async () => {
    const { ctx } = fixture();
    const result = payload(await handleWorkspacePatch(ctx, "test", { patches: [{ unified_diff: "diff --git a/run.sh b/run.sh\nnew file mode 100755\n--- /dev/null\n+++ b/run.sh\n@@ -0,0 +1 @@\n+echo test\n" }] }));
    expect(result.error.code).toBe("UNSUPPORTED_PATCH");
    expect(result.changed_files).toEqual([]);
  });
  it("paginates search matches without returning all matches in the first response", async () => {
    const { ctx } = fixture();
    writeFileSync(join(root, "lines.txt"), "match1\nmatch2\nmatch3\nmatch4\nmatch5\n");
    const first = payload(await handleWorkspaceSearch(ctx, "test", { query: "match", max_results: 2 }));
    expect(first.matches).toHaveLength(2);
    expect(first.next_offset).toBe(2);
    const next = payload(await handleWorkspaceSearch(ctx, "test", { query: "match", max_results: 2, offset: first.next_offset }));
    expect(next.matches.map((match: { line: number }) => match.line)).toEqual([3, 4]);
  });

  it("detects non-Node toolchains without inventing a package-manager command", async () => {
    const { ctx } = fixture();
    writeFileSync(join(root, "Cargo.toml"), "[package]\nname='example'\n");
    const result = payload(await handleProjectInspect(ctx, "test"));
    expect(result.toolchains).toContainEqual(expect.objectContaining({ language: "rust", test: "cargo test" }));
    expect(result.likely_commands.test).toBeUndefined();
  });
  it("continues before a multibyte line when the remaining budget cannot fit it", async () => {
    const { ctx } = fixture();
    writeFileSync(join(root, "text.txt"), "a\n\u65e5\u672c\u8a9e");
    const first = payload(await handleWorkspaceRead(ctx, "test", { path: "text.txt", max_bytes: 4 }));
    expect(first.lines).toEqual([{ line: 1, text: "a" }]);
    expect(first.next_start_line).toBe(2);
    const second = payload(await handleWorkspaceRead(ctx, "test", { path: "text.txt", start_line: first.next_start_line, max_bytes: 9 }));
    expect(second.lines[0].text).toBe("\u65e5\u672c\u8a9e");
  });

  it("rejects dangling symlinks when creating a patch target", async () => {
    const { ctx } = fixture();
    symlinkSync(join(root, "missing.txt"), join(root, "alias.txt"));
    const result = payload(await handleWorkspacePatch(ctx, "test", { patches: [{ path: "alias.txt", replacement: "new" }] }));
    expect(result.error.code).toBe("BROKEN_SYMLINK");
  });
  it("executes in each selected working directory for the same project", async () => {
    const { project } = fixture();
    mkdirSync(join(root, "nested"));
    const runner = new ShellRunner();
    const first = await runner.run(project, { command: "pwd" }, "test");
    const second = await runner.run(applyWorkingDirectory(project, "nested"), { command: "pwd" }, "test");
    expect(first.stdout.trim()).toBe(root);
    expect(second.stdout.trim()).toBe(join(root, "nested"));
  });

  it("does not change any file when a later patch conflicts", async () => {
    const { ctx } = fixture();
    writeFileSync(join(root, "a.txt"), "before");
    writeFileSync(join(root, "b.txt"), "before");
    const result = await handleWorkspacePatch(ctx, "test", { patches: [{ path: "a.txt", replacement: "after" }, { path: "b.txt", expected_sha256: "wrong", replacement: "after" }] });
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ applied: false, partial: false, changed_files: [], phase: "preflight" });
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("before");
  });

  it("plans successive exact edits and preserves literal dollar substitutions", async () => {
    const { ctx } = fixture();
    writeFileSync(join(root, "a.txt"), "first\n");
    const result = await handleWorkspacePatch(ctx, "test", { patches: [{ path: "a.txt", old_text: "first", new_text: "$&" }, { path: "a.txt", old_text: "$&", new_text: "last" }] });
    expect(payload(result).applied).toBe(true);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("last\n");
    expect(payload(result).diff).toContain("-first");
    expect(payload(result).diff).toContain("+last");
  });

  it("includes newly created files in the invocation diff without a git repo", async () => {
    const { ctx } = fixture();
    const result = await handleWorkspacePatch(ctx, "test", { patches: [{ path: "new.txt", replacement: "new\n" }] });
    expect(payload(result).diff).toContain("+new");
    expect(payload(result).diff).toContain("/dev/null");
  });

  it("keeps dry runs free of writes and validates later dependent edits", async () => {
    const { ctx } = fixture();
    writeFileSync(join(root, "a.txt"), "before");
    const result = await handleWorkspacePatch(ctx, "test", { dry_run: true, patches: [{ path: "a.txt", replacement: "after" }, { path: "a.txt", old_text: "after", new_text: "final" }] });
    expect(result.isError).toBeUndefined();
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("before");
    expect(payload(result).diff).toContain("+final");
  });

  it("finds root and nested TypeScript files with a recursive glob", async () => {
    const { ctx } = fixture();
    writeFileSync(join(root, "index.ts"), "");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "app.ts"), "");
    expect(payload(await handleWorkspaceList(ctx, "test", { glob: "**/*.ts" })).entries.map((x: { path: string }) => x.path)).toEqual(["index.ts", "src/app.ts"]);
  });

  it("rejects symlink reads into denied paths", async () => {
    const { ctx } = fixture();
    mkdirSync(join(root, "secrets"));
    writeFileSync(join(root, "secrets", "private.txt"), "private");
    symlinkSync(join(root, "secrets", "private.txt"), join(root, "alias.txt"));
    expect(payload(await handleWorkspaceRead(ctx, "test", { path: "alias.txt" })).error.code).toBe("DENIED_PATH");
  });

  it("persists concurrent context saves in invocation order", async () => {
    fixture();
    const path = join(root, "contexts.json");
    const store = new ChatContextStore(path);
    store.setCurrentProject("a", "one");
    const first = store.save();
    store.setCurrentProject("a", "two");
    const second = store.save();
    await Promise.all([first, second]);
    const restored = new ChatContextStore(path);
    await restored.load();
    expect(restored.getCurrentProject("a")).toBe("two");
  });
});
