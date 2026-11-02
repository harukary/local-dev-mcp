import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { createMcpServer, type AppContext } from "../../src/mcp/server.js";
import { museWorkContextId } from "../../src/mcp/auth-muse.js";
import { ChatContextStore } from "../../src/project/context-store.js";
import { ShellRunner } from "../../src/shell/runner.js";
import { ToolUsageMetrics } from "../../src/metrics/tool-usage.js";
import type { ProjectConfig } from "../../src/types.js";

it("isolates Muse project calls without chat IDs or persisted selection", async () => {
  const root = join(dirname(process.env.LOCAL_DEV_MCP_JOB_STORE_DIR!), "muse-context");
  const alphaRoot = join(root, "alpha");
  const betaRoot = join(root, "beta");
  await mkdir(alphaRoot, { recursive: true });
  await mkdir(betaRoot, { recursive: true });
  await mkdir(join(alphaRoot, "worktree"), { recursive: true });
  await writeFile(join(alphaRoot, "sample.txt"), "alpha-only\n");
  await writeFile(join(betaRoot, "sample.txt"), "beta-only\n");
  await writeFile(join(alphaRoot, "AGENTS.md"), "Only modify project alpha.\n");
  const project = (id: string, dir: string): ProjectConfig => ({
    projectId: id, displayName: id, hostRoot: dir, sandboxRoot: dir, sandboxType: "host",
    defaultShell: "/bin/bash", defaultTimeoutSeconds: 10, maxTimeoutSeconds: 30,
    networkPolicy: "ask", writePolicy: "allow", approvalMode: "never", deniedPaths: [], redactionProfile: "default",
  });
  const projects = [project("alpha", alphaRoot), project("beta", betaRoot)];
  const contextStore = new ChatContextStore();
  const metrics = new ToolUsageMetrics(join(root, "usage.json"), { flush_every: 1 });
  const ownerHash = "b".repeat(64);
  const audit = vi.fn().mockResolvedValue(undefined);
  const server = createMcpServer({
    registry: { has: (id: string) => projects.some(p => p.projectId === id),
      get: (id: string) => projects.find(p => p.projectId === id), getAll: () => projects },
    contextStore, shellRunner: new ShellRunner(), auditLogger: { log: audit },
    toolUsageMetrics: metrics, clientProfile: "muse", museOwnerHash: ownerHash,
  } as unknown as AppContext);
  const client = new Client({ name: "muse-test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(b);
    await client.connect(a);
    const tools = (await client.listTools()).tools;
    const names = tools.map(t => t.name);
    expect(names).toContain("project.open");
    expect(names).not.toContain("project.select");
    expect(names).not.toContain("project.current");
    expect(names).not.toContain("artifact.link");
    expect(names).not.toContain("shell.approve");
    expect(names).not.toContain("project.reload");
    expect(tools.find(t => t.name === "workspace.read")?.inputSchema.required).toContain("project_id");
    expect(tools.find(t => t.name === "browser.open")?.inputSchema.required).toContain("project_id");
    expect(tools.find(t => t.name === "shell.status")?.inputSchema.required).toContain("project_id");

    // Discoverability is not an authorization boundary: calls to hidden tools must also fail.
    for (const [name, args] of [
      ["project.select", { project_id: "beta" }],
      ["project.current", {}],
      ["project.reload", {}],
      ["artifact.link", { project_id: "alpha", path: "sample.txt" }],
      ["artifact.receive", { project_id: "alpha" }],
      ["shell.approve", { approval_request_id: "untrusted" }],
      ["shell.reject", { approval_request_id: "untrusted" }],
      ["shell.pending", {}],
      ["future.privileged", {}],
    ] as const) {
      const rejected = await client.callTool({ name, arguments: args });
      expect(rejected.isError, name).toBe(true);
      expect(rejected.structuredContent, name).toMatchObject({ error: { code: "TOOL_UNAVAILABLE" } });
    }
    expect(contextStore.getAll().size).toBe(0);

    const opened = await client.callTool({ name: "project.open", arguments: { project_id: "alpha" } });
    expect(opened.isError).toBeUndefined();
    expect(opened.structuredContent).toBeUndefined();
    expect(opened.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("Only modify project alpha.") });
    expect(opened.content[0]).toMatchObject({ type: "text", text: expect.not.stringContaining("Context ID") });

    const missing = await client.callTool({ name: "workspace.read", arguments: { path: "sample.txt" } });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]).toMatchObject({ text: expect.stringContaining("project_id") });
    const wrong = await client.callTool({ name: "workspace.read", arguments: { path: "sample.txt", project_id: "not-registered" } });
    expect(wrong.isError).toBe(true);
    const [alpha, beta] = await Promise.all([
      client.callTool({ name: "workspace.read", arguments: { path: "sample.txt", project_id: "alpha" } }),
      client.callTool({ name: "workspace.read", arguments: { path: "sample.txt", project_id: "beta" } }),
    ]);
    expect(alpha.isError).toBeUndefined();
    expect(beta.isError).toBeUndefined();
    expect(alpha.content[0]).toMatchObject({ text: expect.stringContaining("alpha-only") });
    expect(beta.content[0]).toMatchObject({ text: expect.stringContaining("beta-only") });
    expect(alpha.structuredContent).toBeUndefined();

    const nestedScope = await client.callTool({ name: "workspace.batch", arguments: {
      project_id: "alpha",
      requests: [{ tool: "workspace.read", arguments: { project_id: "beta", path: "sample.txt" } }],
    } });
    expect(nestedScope.structuredContent).toMatchObject({ error: { code: "CONTEXT_PROJECT_CONFLICT" } });

    const patch = await client.callTool({ name: "workspace.patch", arguments: {
      project_id: "alpha",
      patches: [{ path: "sample.txt", old_text: "alpha-only", new_text: "alpha-updated" }],
    } });
    expect(patch.isError).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "workspace.patch", event: "workspace_patch_applied", clientProfile: "muse",
      projectId: "alpha", changedPaths: ["sample.txt"],
      chatContextId: museWorkContextId(ownerHash, "alpha"),
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("alpha-updated");

    const preview = await client.callTool({ name: "workspace.patch", arguments: {
      project_id: "alpha", dry_run: true,
      patches: [{ path: "sample.txt", old_text: "alpha-updated", new_text: "preview-only" }],
    } });
    expect(preview.isError).toBeUndefined();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      event: "workspace_patch_previewed", changedPaths: ["sample.txt"],
    }));
    const conflict = await client.callTool({ name: "workspace.patch", arguments: {
      project_id: "alpha", patches: [{ path: "sample.txt", old_text: "not-present", new_text: "unsafe" }],
    } });
    expect(conflict.isError).toBe(true);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      event: "workspace_patch_failed", error: "PATCH_CONFLICT", changedPaths: [],
    }));
    expect(JSON.stringify(audit.mock.calls)).not.toContain("preview-only");

    const started = await client.callTool({ name: "shell.run", arguments: {
      project_id: "alpha", command: "sleep 20", async: true,
    } });
    expect(started.isError).toBeUndefined();
    const jobId = JSON.parse(started.content[0].text ?? "{}").job_id as string;
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/);
    const ownStatus = await client.callTool({ name: "shell.status", arguments: { project_id: "alpha", job_id: jobId } });
    expect(ownStatus.structuredContent).toMatchObject({ job_id: jobId, project_id: "alpha" });
    for (const scope of [{ project_id: "beta" }, { project_id: "alpha", working_dir: "worktree" }]) {
      const deniedStatus = await client.callTool({ name: "shell.status", arguments: { ...scope, job_id: jobId } });
      expect(deniedStatus.structuredContent).toMatchObject({ error: { code: "JOB_NOT_FOUND" } });
      const deniedCancel = await client.callTool({ name: "shell.cancel", arguments: { ...scope, job_id: jobId } });
      expect(deniedCancel.structuredContent).toMatchObject({ error: { code: "JOB_NOT_FOUND" } });
    }
    const canceled = await client.callTool({ name: "shell.cancel", arguments: { project_id: "alpha", job_id: jobId } });
    expect(canceled.isError).toBeUndefined();
    expect(canceled.content[0]).toMatchObject({ text: expect.stringContaining('"canceled": true') });
    const lostJob = await client.callTool({ name: "shell.status", arguments: { project_id: "alpha", job_id: "unknown" } });
    expect(lostJob.content[0]).toMatchObject({ text: expect.stringContaining("JOB_NOT_FOUND") });
    expect(contextStore.getAll().size).toBe(0);
    expect(contextStore.getCurrentProject(museWorkContextId(ownerHash, "alpha"))).toBeUndefined();
  } finally {
    await client.close(); await server.close(); metrics.flush();
  }
});
